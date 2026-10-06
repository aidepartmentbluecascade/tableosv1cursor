import type { TabulaDb } from "@tabula/db";
import { sql } from "kysely";
import { recomputeInTx, type RecomputeTarget } from "./recompute-in-tx.js";

export interface ComputeJobPayload {
  baseId: string;
  workspaceId: string;
}

/** Drain computed_stale rows for a base (worker handler). */
export async function handleComputeJob(
  db: TabulaDb,
  payload: ComputeJobPayload,
): Promise<void> {
  const stale = await sql<{
    table_id: string;
    record_id: string;
    field_id: string;
  }>`
    SELECT table_id, record_id, field_id
    FROM data.computed_stale
    WHERE base_id = ${payload.baseId}
    ORDER BY enqueued_at ASC
    LIMIT 500
  `.execute(db);

  if (stale.rows.length === 0) return;

  const byRecord = new Map<string, RecomputeTarget>();
  const fieldIds = new Set<string>();
  for (const row of stale.rows) {
    const key = `${row.table_id}:${row.record_id}`;
    byRecord.set(key, { tableId: row.table_id, recordId: row.record_id });
    fieldIds.add(row.field_id);
  }

  await db.transaction().execute(async (trx) => {
    await recomputeInTx(
      trx,
      payload.baseId,
      payload.workspaceId,
      [...byRecord.values()],
      [...fieldIds],
      null,
    );

    for (const row of stale.rows) {
      await sql`
        DELETE FROM data.computed_stale
        WHERE table_id = ${row.table_id}
          AND record_id = ${row.record_id}
          AND field_id = ${row.field_id}
      `.execute(trx);
    }
  });
}
