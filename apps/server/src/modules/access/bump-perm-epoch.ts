import type { BumpPermEpochResult } from "@tabula/permissions";
import type { Database } from "@tabula/db";
import { sql, type Transaction } from "kysely";
import { invalidateBaseSnapshotCache } from "./compile.js";

type DbTrx = Transaction<Database>;

/** Bump `perm_epoch` for a base inside a mutation transaction. */
export async function bumpPermEpoch(
  trx: DbTrx,
  baseId: string,
): Promise<BumpPermEpochResult> {
  const result = await sql<{ perm_epoch: string }>`
    UPDATE data.base_runtime
    SET perm_epoch = perm_epoch + 1, updated_at = now()
    WHERE base_id = ${baseId}
    RETURNING perm_epoch
  `.execute(trx);

  const row = result.rows[0];
  const newEpoch = Number(row?.perm_epoch ?? 1);
  invalidateBaseSnapshotCache(baseId);

  return {
    baseId,
    previousEpoch: newEpoch - 1,
    newEpoch,
  };
}
