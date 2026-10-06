import type { TabulaDb } from "@tabula/db";
import {
  buildRecordQuerySql,
  decodeLegacyCursor,
  decodeRecordCursor,
  encodeRecordCursor,
  nextCursorFromRow,
  planRecordQuery,
  type RecordQueryInput,
} from "@tabula/query";
import { parsePid, pid } from "../../lib/public-ids.js";
import {
  buildPlanContext,
  loadQueryFields,
  loadTableQueryMeta,
  type QueryFieldRow,
} from "./context.js";
import { executeRawQuery } from "./raw-sql.js";

export interface RecordQueryResult {
  records: Record<string, unknown>[];
  nextCursor: string | null;
}

function encodeRecordRow(
  row: {
    id: string;
    cells: unknown;
    computed: unknown;
    version: string;
    row_number: string;
    manual_order: string;
    created_at?: Date | string;
  },
  fieldRows: QueryFieldRow[],
): Record<string, unknown> {
  const cells = (row.cells ?? {}) as Record<string, unknown>;
  const computed = (row.computed ?? {}) as Record<string, unknown>;
  const bySlot = new Map(fieldRows.map((f) => [String(f.slot), f]));
  const fields: Record<string, unknown> = {};

  for (const [slot, value] of Object.entries(cells)) {
    const f = bySlot.get(slot);
    if (f) fields[pid("fld", f.id)] = value;
  }
  for (const [slot, value] of Object.entries(computed)) {
    const f = bySlot.get(slot);
    if (f) fields[pid("fld", f.id)] = value;
  }

  const createdAt =
    row.created_at instanceof Date
      ? row.created_at.toISOString()
      : row.created_at
        ? String(row.created_at)
        : new Date().toISOString();

  return {
    id: pid("rec", row.id),
    version: Number(row.version),
    createdAt,
    rowNumber: Number(row.row_number),
    manualOrder: row.manual_order,
    fields,
  };
}

function offsetSqlParams(fragment: string, offset: number): string {
  return fragment.replace(/\$(\d+)/g, (_, n) => `$${Number(n) + offset}`);
}

function normalizeCursor(input: RecordQueryInput): RecordQueryInput {
  if (!input.cursor) return input;
  try {
    const cur = decodeRecordCursor(input.cursor);
    if (cur.kind === "manualOrder" && cur.id.startsWith("rec_")) {
      return {
        ...input,
        cursor: encodeRecordCursor({
          ...cur,
          id: parsePid(cur.id, "rec"),
        }),
      };
    }
    return input;
  } catch {
    const legacy = decodeLegacyCursor(input.cursor);
    if (legacy && legacy.id.startsWith("rec_")) {
      return {
        ...input,
        cursor: encodeRecordCursor({
          kind: "manualOrder",
          manualOrder: legacy.manualOrder,
          id: parsePid(legacy.id, "rec"),
        }),
      };
    }
    return input;
  }
}

export async function executeRecordQuery(
  db: TabulaDb,
  tableId: string,
  input: RecordQueryInput,
): Promise<RecordQueryResult> {
  const fieldRows = await loadQueryFields(db, tableId);
  const meta = await loadTableQueryMeta(db, tableId);
  const planCtx = buildPlanContext(fieldRows, meta);
  const plan = planRecordQuery(normalizeCursor(input), planCtx);
  const fragments = buildRecordQuerySql(plan);

  const filterClause = fragments.filterSql
    ? ` AND (${offsetSqlParams(fragments.filterSql, 1)})`
    : "";
  const limitParam = 1 + fragments.filterParams.length + 1;
  const queryText = `
    SELECT id, cells, computed, version, row_number, manual_order, created_at
    FROM data.records r
    WHERE r.table_id = $1 AND r.deleted_at IS NULL
    ${filterClause}
    ORDER BY ${fragments.orderBySql}
    LIMIT $${limitParam}
  `;
  const values = [tableId, ...fragments.filterParams, fragments.limit];

  type RecordRow = {
    id: string;
    cells: unknown;
    computed: unknown;
    version: string;
    row_number: string;
    manual_order: string;
    created_at: Date;
  };

  const rows = await executeRawQuery<RecordRow>(db, queryText, values);

  const hasMore = rows.length > plan.pageSize;
  const page = hasMore ? rows.slice(0, plan.pageSize) : rows;
  const last = page[page.length - 1];
  const nextCursor =
    hasMore && last
      ? nextCursorFromRow(plan, {
          id: last.id,
          manual_order: last.manual_order,
          cells: (last.cells ?? {}) as Record<string, unknown>,
        })
      : null;

  return {
    records: page.map((r) => encodeRecordRow(r, fieldRows)),
    nextCursor,
  };
}
