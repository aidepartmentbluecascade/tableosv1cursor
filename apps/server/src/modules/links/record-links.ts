import type { Database } from "@tabula/db";
import {
  mergeLinkOps,
  nextFractionalOrderKey,
  validateCardinality,
  type LinkSetOp,
} from "@tabula/links";
import { sql, type Transaction } from "kysely";
import { parsePid } from "../../lib/public-ids.js";

type DbTrx = Transaction<Database>;

export interface LinkRelationContext {
  relationId: string;
  side: "a" | "b";
  allowMultiple: boolean;
  peerTableId: string;
}

export async function getLinkRelationForField(
  trx: DbTrx,
  fieldId: string,
): Promise<(LinkRelationContext & { aFieldId: string; bFieldId: string | null }) | null> {
  const row = await sql<{
    id: string;
    a_field_id: string;
    b_field_id: string | null;
    a_table_id: string;
    b_table_id: string;
    allow_multiple_a: boolean;
    allow_multiple_b: boolean;
  }>`
    SELECT id, a_field_id, b_field_id, a_table_id, b_table_id,
           allow_multiple_a, allow_multiple_b
    FROM data.link_relations
    WHERE a_field_id = ${fieldId} OR b_field_id = ${fieldId}
    LIMIT 1
  `.execute(trx);

  const rel = row.rows[0];
  if (!rel) return null;

  if (rel.a_field_id === fieldId) {
    return {
      relationId: rel.id,
      side: "a",
      allowMultiple: rel.allow_multiple_a,
      peerTableId: rel.b_table_id,
      aFieldId: rel.a_field_id,
      bFieldId: rel.b_field_id,
    };
  }

  return {
    relationId: rel.id,
    side: "b",
    allowMultiple: rel.allow_multiple_b,
    peerTableId: rel.a_table_id,
    aFieldId: rel.a_field_id,
    bFieldId: rel.b_field_id,
  };
}

async function currentPeerIds(
  trx: DbTrx,
  rel: LinkRelationContext,
  recordId: string,
): Promise<string[]> {
  if (rel.side === "a") {
    const rows = await sql<{ b_record_id: string }>`
      SELECT b_record_id FROM data.record_links
      WHERE relation_id = ${rel.relationId} AND a_record_id = ${recordId}
        AND deletion_batch_id IS NULL
    `.execute(trx);
    return rows.rows.map((r) => r.b_record_id);
  }
  const rows = await sql<{ a_record_id: string }>`
    SELECT a_record_id FROM data.record_links
    WHERE relation_id = ${rel.relationId} AND b_record_id = ${recordId}
      AND deletion_batch_id IS NULL
  `.execute(trx);
  return rows.rows.map((r) => r.a_record_id);
}

function normalizeRecordId(raw: string): string {
  if (raw.includes("_")) {
    return parsePid(raw, "rec");
  }
  return raw;
}

export async function applyLinkOpsInTx(
  trx: DbTrx,
  params: {
    workspaceId: string;
    baseId: string;
    tableId: string;
    recordId: string;
    fieldId: string;
    ops: LinkSetOp[];
  },
): Promise<{ nextIds: string[] }> {
  const rel = await getLinkRelationForField(trx, params.fieldId);
  if (!rel) {
    throw new Error("LINK_FIELD_NOT_FOUND");
  }

  const normalizedOps: LinkSetOp[] = params.ops.map((op) => ({
    ...op,
    recordId: normalizeRecordId(op.recordId),
  }));

  const merged = mergeLinkOps(normalizedOps);
  const current = await currentPeerIds(trx, rel, params.recordId);
  const check = validateCardinality({ allowMultiple: rel.allowMultiple }, current, merged);
  if (!check.ok) {
    throw new Error("LINK_CARDINALITY");
  }

  for (const removeId of merged.remove) {
    if (rel.side === "a") {
      await sql`
        DELETE FROM data.record_links
        WHERE relation_id = ${rel.relationId}
          AND a_record_id = ${params.recordId}
          AND b_record_id = ${removeId}
      `.execute(trx);
    } else {
      await sql`
        DELETE FROM data.record_links
        WHERE relation_id = ${rel.relationId}
          AND b_record_id = ${params.recordId}
          AND a_record_id = ${removeId}
      `.execute(trx);
    }
  }

  for (const add of merged.add) {
    const order = add.order ?? nextFractionalOrderKey();
    if (rel.side === "a") {
      await sql`
        INSERT INTO data.record_links (
          relation_id, a_record_id, b_record_id, a_order, b_order, workspace_id, base_id
        ) VALUES (
          ${rel.relationId}, ${params.recordId}, ${add.recordId}, ${order}, ${order},
          ${params.workspaceId}, ${params.baseId}
        )
        ON CONFLICT (relation_id, a_record_id, b_record_id) DO NOTHING
      `.execute(trx);
    } else {
      await sql`
        INSERT INTO data.record_links (
          relation_id, a_record_id, b_record_id, a_order, b_order, workspace_id, base_id
        ) VALUES (
          ${rel.relationId}, ${add.recordId}, ${params.recordId}, ${order}, ${order},
          ${params.workspaceId}, ${params.baseId}
        )
        ON CONFLICT (relation_id, a_record_id, b_record_id) DO NOTHING
      `.execute(trx);
    }
  }

  return { nextIds: check.nextIds };
}

/** Sync record_links from link-field cell arrays on a record write. */
export async function syncRecordLinksFromCells(
  trx: DbTrx,
  params: {
    workspaceId: string;
    baseId: string;
    tableId: string;
    recordId: string;
    linkFields: Array<{ fieldId: string; slot: number }>;
    cells: Record<string, unknown>;
  },
): Promise<string[]> {
  const changedFieldIds: string[] = [];

  for (const lf of params.linkFields) {
    const slotKey = String(lf.slot);
    if (!(slotKey in params.cells)) continue;
    const raw = params.cells[slotKey];
    const desired = Array.isArray(raw)
      ? raw.map((id) => (typeof id === "string" ? normalizeRecordId(id) : String(id)))
      : [];

    const rel = await getLinkRelationForField(trx, lf.fieldId);
    if (!rel) continue;

    const current = await currentPeerIds(trx, rel, params.recordId);
    const toAdd = desired.filter((id) => !current.includes(id));
    const toRemove = current.filter((id) => !desired.includes(id));

    if (toAdd.length === 0 && toRemove.length === 0) continue;

    const ops: LinkSetOp[] = [
      ...toRemove.map((recordId) => ({ kind: "remove" as const, recordId })),
      ...toAdd.map((recordId) => ({ kind: "add" as const, recordId })),
    ];

    await applyLinkOpsInTx(trx, {
      workspaceId: params.workspaceId,
      baseId: params.baseId,
      tableId: params.tableId,
      recordId: params.recordId,
      fieldId: lf.fieldId,
      ops,
    });
    changedFieldIds.push(lf.fieldId);
  }

  return changedFieldIds;
}
