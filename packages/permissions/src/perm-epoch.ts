/**
 * Permission epoch (`data.base_runtime.perm_epoch`) bumps when grants or roles change.
 * Cached `PermissionSnapshot` entries must be invalidated when the epoch advances.
 *
 * Call `bumpPermEpoch` in the same transaction as grant/invite/membership writes.
 */
export interface BumpPermEpochResult {
  baseId: string;
  previousEpoch: number;
  newEpoch: number;
}

/** SQL shape returned after incrementing perm_epoch (for use in Kysely/raw SQL). */
export type BumpPermEpochRow = {
  perm_epoch: string;
};

/**
 * Documented SQL for bumping epoch inside a transaction (see `m/access` server helper).
 * Consumers must invalidate cached permission snapshots when epoch changes.
 */
export function bumpPermEpoch(baseId: string): {
  baseId: string;
  sql: string;
} {
  return {
    baseId,
    sql: `UPDATE data.base_runtime SET perm_epoch = perm_epoch + 1 WHERE base_id = '${baseId}'`,
  };
}
