import {
  compileSnapshot,
  type AccessGrantRow,
  type PermissionSnapshot,
} from "@tabula/permissions";
import type { TabulaDb } from "@tabula/db";
import { sql } from "kysely";

const snapshotCache = new Map<string, PermissionSnapshot>();

function cacheKey(userId: string, baseId: string): string {
  return `${userId}:${baseId}`;
}

async function loadGrantsForUser(
  db: TabulaDb,
  userId: string,
  workspaceId: string,
  baseId: string,
): Promise<AccessGrantRow[]> {
  const result = await sql<AccessGrantRow>`
    SELECT resource_type, resource_id, workspace_id, base_id, role
    FROM core.access_grants
    WHERE principal_type = 'user'
      AND principal_id = ${userId}
      AND (
        workspace_id = ${workspaceId}
        OR base_id = ${baseId}
        OR (resource_type = 'workspace' AND resource_id = ${workspaceId})
      )
  `.execute(db);
  return result.rows;
}

/** Invalidate cached snapshots for a base (after perm_epoch bump). */
export function invalidateBaseSnapshotCache(baseId: string): void {
  for (const key of snapshotCache.keys()) {
    if (key.endsWith(`:${baseId}`)) {
      snapshotCache.delete(key);
    }
  }
}

/** Compile (and cache) effective permissions for a user on a base. */
export async function compileForUser(
  db: TabulaDb,
  userId: string,
  baseId: string,
): Promise<PermissionSnapshot> {
  const key = cacheKey(userId, baseId);
  const cached = snapshotCache.get(key);

  const dir = await sql<{ workspace_id: string }>`
    SELECT workspace_id FROM core.base_directory
    WHERE base_id = ${baseId} AND status = 'active' AND deleted_at IS NULL
    LIMIT 1
  `.execute(db);
  const workspaceId = dir.rows[0]?.workspace_id;
  if (!workspaceId) {
    return {
      baseId,
      workspaceId: "",
      effectiveBaseRole: null,
      permEpoch: 1,
    };
  }

  const runtime = await sql<{ perm_epoch: string }>`
    SELECT perm_epoch FROM data.base_runtime WHERE base_id = ${baseId} LIMIT 1
  `.execute(db);
  const permEpoch = Number(runtime.rows[0]?.perm_epoch ?? 1);

  if (cached && cached.permEpoch === permEpoch) {
    return cached;
  }

  const grants = await loadGrantsForUser(db, userId, workspaceId, baseId);
  const snapshot = compileSnapshot(
    { baseId, workspaceId, grants },
    permEpoch,
  );
  snapshotCache.set(key, snapshot);
  return snapshot;
}

/** Workspace-scoped snapshot (e.g. before a base exists). */
export async function compileForWorkspace(
  db: TabulaDb,
  userId: string,
  workspaceId: string,
): Promise<PermissionSnapshot> {
  const grants = await sql<AccessGrantRow>`
    SELECT resource_type, resource_id, workspace_id, base_id, role
    FROM core.access_grants
    WHERE principal_type = 'user'
      AND principal_id = ${userId}
      AND (
        workspace_id = ${workspaceId}
        OR (resource_type = 'workspace' AND resource_id = ${workspaceId})
      )
  `.execute(db);

  return compileSnapshot(grants.rows, { baseId: "", workspaceId }, 1);
}
