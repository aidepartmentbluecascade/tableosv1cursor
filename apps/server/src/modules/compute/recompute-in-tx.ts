import type { Database } from "@tabula/db";
import {
  COMPUTE_SYNC_FANOUT_LIMIT,
  planPropagation,
  type ComputedValue,
} from "@tabula/compute";
import { compileFormula, parseFormula, type FormulaContext } from "@tabula/formula";
import { QueueNames, createQueue } from "@tabula/jobs";
import type { Redis } from "ioredis";
import { sql, type Transaction } from "kysely";
import { loadBaseComputeSchema, type BaseComputeSchema, type ComputeFieldRow } from "./schema.js";

type DbTrx = Transaction<Database>;

export interface RecomputeTarget {
  tableId: string;
  recordId: string;
}

export interface RecomputeResult {
  updatedRecords: number;
  deferred: boolean;
}

function fieldNameMap(schema: BaseComputeSchema, tableId: string): Record<string, string> {
  const map: Record<string, string> = {};
  for (const f of schema.fieldsByTable.get(tableId) ?? []) {
    map[f.name] = String(f.slot);
  }
  return map;
}

async function loadLinkedTargetIds(
  trx: DbTrx,
  relationId: string,
  fromRecordId: string,
  side: "a" | "b",
): Promise<string[]> {
  if (side === "a") {
    const rows = await sql<{ b_record_id: string }>`
      SELECT b_record_id FROM data.record_links
      WHERE relation_id = ${relationId} AND a_record_id = ${fromRecordId}
        AND deletion_batch_id IS NULL
      ORDER BY a_order ASC
    `.execute(trx);
    return rows.rows.map((r) => r.b_record_id);
  }
  const rows = await sql<{ a_record_id: string }>`
    SELECT a_record_id FROM data.record_links
    WHERE relation_id = ${relationId} AND b_record_id = ${fromRecordId}
      AND deletion_batch_id IS NULL
    ORDER BY b_order ASC
  `.execute(trx);
  return rows.rows.map((r) => r.a_record_id);
}

async function loadRecordCells(
  trx: DbTrx,
  tableId: string,
  recordId: string,
): Promise<{ cells: Record<string, unknown>; computed: Record<string, unknown> } | null> {
  const row = await sql<{ cells: unknown; computed: unknown }>`
    SELECT cells, computed FROM data.records
    WHERE table_id = ${tableId} AND id = ${recordId} AND deleted_at IS NULL
  `.execute(trx);
  const r = row.rows[0];
  if (!r) return null;
  return {
    cells: (r.cells ?? {}) as Record<string, unknown>,
    computed: (r.computed ?? {}) as Record<string, unknown>,
  };
}

function slotValue(
  cells: Record<string, unknown>,
  computed: Record<string, unknown>,
  slot: number,
  isComputed: boolean,
): unknown {
  const key = String(slot);
  if (isComputed) {
    const c = computed[key] as { value?: unknown } | undefined;
    return c?.value;
  }
  return cells[key];
}

async function computeFieldValue(
  trx: DbTrx,
  schema: BaseComputeSchema,
  field: ComputeFieldRow,
  tableId: string,
  recordId: string,
  cells: Record<string, unknown>,
  computed: Record<string, unknown>,
): Promise<ComputedValue> {
  try {
    if (field.type === "formula") {
      const expr = String(field.config["expression"] ?? field.config["formula"] ?? "");
      const ast = parseFormula(expr);
      const runner = compileFormula(ast);
      const ctx: FormulaContext = {
        fieldNameToSlot: fieldNameMap(schema, tableId),
        cells: cells as FormulaContext["cells"],
        recordId,
      };
      return { value: runner(ctx), status: "ok" };
    }

    if (field.type === "count") {
      const linkFieldId = String(field.config["linkFieldId"]);
      const relInfo = schema.linkRelationByFieldId.get(linkFieldId);
      if (!relInfo) return { value: 0, status: "ok" };
      const linkField = schema.fieldsById.get(linkFieldId);
      if (!linkField) return { value: 0, status: "ok" };
      const linked = await loadLinkedTargetIds(
        trx,
        relInfo.id,
        recordId,
        relInfo.aFieldId === linkFieldId ? "a" : "b",
      );
      return { value: linked.length, status: "ok" };
    }

    if (field.type === "lookup") {
      const linkFieldId = String(field.config["linkFieldId"]);
      const lookupFieldId = String(field.config["lookupFieldId"]);
      const relInfo = schema.linkRelationByFieldId.get(linkFieldId);
      const lookupField = schema.fieldsById.get(lookupFieldId);
      if (!relInfo || !lookupField) return { value: null, status: "ok" };
      const linkField = schema.fieldsById.get(linkFieldId)!;
      const side = relInfo.aFieldId === linkFieldId ? "a" : "b";
      const targets = await loadLinkedTargetIds(trx, relInfo.id, recordId, side);
      const values: unknown[] = [];
      for (const targetId of targets) {
        const other = await loadRecordCells(trx, lookupField.tableId, targetId);
        if (!other) continue;
        values.push(
          slotValue(other.cells, other.computed, lookupField.slot, lookupField.isComputed),
        );
      }
      return { value: values.length === 1 ? values[0] : values, status: "ok" };
    }

    if (field.type === "rollup") {
      const linkFieldId = String(field.config["linkFieldId"]);
      const rollupFieldId = String(field.config["rollupFieldId"]);
      const agg = String(field.config["aggregation"] ?? field.config["function"] ?? "sum");
      const relInfo = schema.linkRelationByFieldId.get(linkFieldId);
      const rollupField = schema.fieldsById.get(rollupFieldId);
      if (!relInfo || !rollupField) return { value: null, status: "ok" };
      const linkField = schema.fieldsById.get(linkFieldId)!;
      const side = relInfo.aFieldId === linkFieldId ? "a" : "b";
      const targets = await loadLinkedTargetIds(trx, relInfo.id, recordId, side);
      const nums: number[] = [];
      for (const targetId of targets) {
        const other = await loadRecordCells(trx, rollupField.tableId, targetId);
        if (!other) continue;
        const raw = slotValue(other.cells, other.computed, rollupField.slot, rollupField.isComputed);
        const n = typeof raw === "number" ? raw : Number(raw);
        if (Number.isFinite(n)) nums.push(n);
      }
      if (agg === "count") return { value: targets.length, status: "ok" };
      if (nums.length === 0) return { value: null, status: "ok" };
      if (agg === "sum") return { value: nums.reduce((a, b) => a + b, 0), status: "ok" };
      if (agg === "average") return { value: nums.reduce((a, b) => a + b, 0) / nums.length, status: "ok" };
      if (agg === "min") return { value: Math.min(...nums), status: "ok" };
      if (agg === "max") return { value: Math.max(...nums), status: "ok" };
      return { value: null, status: "ok" };
    }

    return { value: null, status: "ok" };
  } catch (err) {
    return {
      value: null,
      status: "error",
      error: err instanceof Error ? err.message : "Compute failed",
    };
  }
}

/**
 * Recompute computed columns for touched records inside the current base txn.
 */
export async function recomputeInTx(
  trx: DbTrx,
  baseId: string,
  workspaceId: string,
  targets: RecomputeTarget[],
  changedFieldIds: string[],
  redis: Redis | null,
): Promise<RecomputeResult> {
  if (targets.length === 0) return { updatedRecords: 0, deferred: false };

  const schema = await loadBaseComputeSchema(trx, baseId);
  const plan = planPropagation(schema.graph, changedFieldIds);
  const computedFields = plan.fieldIds
    .map((id) => schema.fieldsById.get(id))
    .filter((f): f is ComputeFieldRow => !!f && f.isComputed);

  if (computedFields.length === 0) {
    return { updatedRecords: 0, deferred: false };
  }

  const fanOut = targets.length * computedFields.length;
  const defer = fanOut > COMPUTE_SYNC_FANOUT_LIMIT;

  if (defer) {
    for (const t of targets) {
      for (const field of computedFields) {
        await sql`
          INSERT INTO data.computed_stale (table_id, record_id, field_id, workspace_id, base_id)
          VALUES (${t.tableId}, ${t.recordId}, ${field.id}, ${workspaceId}, ${baseId})
          ON CONFLICT (table_id, record_id, field_id) DO UPDATE SET enqueued_at = now()
        `.execute(trx);
      }
    }
    if (redis) {
      const queue = createQueue(QueueNames.COMPUTE, redis);
      await queue.add(
        "recompute-base",
        { baseId, workspaceId },
        { removeOnComplete: 1000, removeOnFail: 5000 },
      );
    }
    return { updatedRecords: 0, deferred: true };
  }

  let updatedRecords = 0;
  for (const t of targets) {
    const row = await loadRecordCells(trx, t.tableId, t.recordId);
    if (!row) continue;

    const nextComputed = { ...row.computed };
    let touched = false;

    for (const field of computedFields) {
      if (field.tableId !== t.tableId) continue;
      const result = await computeFieldValue(
        trx,
        schema,
        field,
        t.tableId,
        t.recordId,
        row.cells,
        nextComputed,
      );
      nextComputed[String(field.slot)] = result;
      touched = true;
    }

    if (touched) {
      await sql`
        UPDATE data.records
        SET computed = ${JSON.stringify(nextComputed)}::jsonb, updated_at = now()
        WHERE table_id = ${t.tableId} AND id = ${t.recordId}
      `.execute(trx);
      updatedRecords++;
    }
  }

  return { updatedRecords, deferred: false };
}
