import { sql } from "kysely";
import type { TabulaDb } from "@tabula/db";

/** Active org membership grants workspace-level access for MVP. */
export async function userCanAccessWorkspace(
  db: TabulaDb,
  userId: string,
  workspaceId: string,
): Promise<{ ok: true; orgId: string } | { ok: false }> {
  const result = await sql<{ org_id: string }>`
    SELECT w.org_id
    FROM core.workspaces w
    INNER JOIN core.organization_members m
      ON m.org_id = w.org_id AND m.user_id = ${userId} AND m.status = 'active'
    WHERE w.id = ${workspaceId}
      AND w.deleted_at IS NULL
      AND w.status = 'active'
    LIMIT 1
  `.execute(db);

  const row = result.rows[0];
  if (!row) {
    return { ok: false };
  }
  return { ok: true, orgId: row.org_id };
}

export async function resolveBaseContext(
  db: TabulaDb,
  userId: string,
  baseId: string,
): Promise<
  | {
      ok: true;
      workspaceId: string;
      orgId: string;
      shardId: string;
      name: string;
    }
  | { ok: false }
> {
  const result = await sql<{
    workspace_id: string;
    org_id: string;
    shard_id: string;
    name: string;
  }>`
    SELECT bd.workspace_id, bd.org_id, bd.shard_id, bd.name
    FROM core.base_directory bd
    INNER JOIN core.organization_members m
      ON m.org_id = bd.org_id AND m.user_id = ${userId} AND m.status = 'active'
    WHERE bd.base_id = ${baseId}
      AND bd.status = 'active'
      AND bd.deleted_at IS NULL
    LIMIT 1
  `.execute(db);

  const row = result.rows[0];
  if (!row) {
    return { ok: false };
  }
  return {
    ok: true,
    workspaceId: row.workspace_id,
    orgId: row.org_id,
    shardId: row.shard_id,
    name: row.name,
  };
}

export async function resolveTableContext(
  db: TabulaDb,
  userId: string,
  baseId: string,
  tableId: string,
): Promise<
  | { ok: true; workspaceId: string; orgId: string; tableName: string }
  | { ok: false }
> {
  const base = await resolveBaseContext(db, userId, baseId);
  if (!base.ok) {
    return { ok: false };
  }

  const result = await sql<{ name: string; workspace_id: string }>`
    SELECT name, workspace_id
    FROM data.tables
    WHERE id = ${tableId}
      AND base_id = ${baseId}
      AND deleted_at IS NULL
    LIMIT 1
  `.execute(db);

  const row = result.rows[0];
  if (!row) {
    return { ok: false };
  }

  return {
    ok: true,
    workspaceId: row.workspace_id,
    orgId: base.orgId,
    tableName: row.name,
  };
}
