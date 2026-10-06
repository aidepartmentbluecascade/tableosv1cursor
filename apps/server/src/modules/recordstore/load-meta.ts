import { sql } from "kysely";
import type { TabulaDb } from "@tabula/db";
import type { SidecarFieldRow, SidecarTableMeta } from "./sidecars.js";

export async function loadSidecarFields(
  db: TabulaDb,
  tableId: string,
): Promise<SidecarFieldRow[]> {
  const result = await sql<SidecarFieldRow>`
    SELECT slot, type, index_state
    FROM data.fields
    WHERE table_id = ${tableId} AND deleted_at IS NULL
  `.execute(db);
  return result.rows;
}

export async function loadSidecarTableMeta(
  db: TabulaDb,
  tableId: string,
  workspaceId: string,
  baseId: string,
): Promise<SidecarTableMeta> {
  const result = await sql<{ record_count: string }>`
    SELECT record_count FROM data.tables WHERE id = ${tableId}
  `.execute(db);
  return {
    record_count: Number(result.rows[0]?.record_count ?? 0),
    workspace_id: workspaceId,
    base_id: baseId,
  };
}
