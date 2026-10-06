import { sql } from "kysely";
import type { TabulaDb } from "@tabula/db";
import { pid } from "../../lib/public-ids.js";
import { normalizeViewConfig, type ConfigFieldInfo, type ViewConfig } from "./config.js";

export interface ViewRow {
  id: string;
  table_id: string;
  name: string;
  type: string;
  visibility: string;
  owner_user_id: string | null;
  created_by: string | null;
  config: unknown;
  is_default?: boolean;
  is_favorite?: boolean;
  order_key?: string;
}

export interface TableConfigInfo {
  name: string;
  fields: ConfigFieldInfo[];
}

export interface ViewWire {
  id: string;
  tableId: string;
  name: string;
  type: string;
  isDefault: boolean;
  visibility: string;
  ownerUserId: string | null;
  createdBy: string | null;
  isFavorite: boolean;
  isMine: boolean;
  /** True when the requesting user may change this view's config/name. */
  canEdit: boolean;
  config: ViewConfig;
}

/** Load field info (public ids) for computing view config defaults. */
export async function loadTableConfigInfo(
  db: TabulaDb,
  tableIds: string[],
): Promise<Map<string, TableConfigInfo>> {
  const out = new Map<string, TableConfigInfo>();
  if (tableIds.length === 0) return out;
  const tables = await sql<{ id: string; name: string; primary_field_id: string | null }>`
    SELECT id, name, primary_field_id FROM data.tables
    WHERE id = ANY(${tableIds}::uuid[])
  `.execute(db);
  const fields = await sql<{ id: string; table_id: string; type: string }>`
    SELECT id, table_id, type FROM data.fields
    WHERE table_id = ANY(${tableIds}::uuid[]) AND deleted_at IS NULL
    ORDER BY order_key ASC, slot ASC
  `.execute(db);
  const primaryByTable = new Map<string, string | null>();
  for (const t of tables.rows) {
    primaryByTable.set(t.id, t.primary_field_id);
    out.set(t.id, { name: t.name, fields: [] });
  }
  for (const f of fields.rows) {
    const info = out.get(f.table_id);
    if (!info) continue;
    info.fields.push({
      id: pid("fld", f.id),
      type: f.type,
      isPrimary: primaryByTable.get(f.table_id) === f.id,
    });
  }
  return out;
}

/** Whether `userId` may modify this view (name/config/visibility/delete). */
export function canEditView(
  row: Pick<ViewRow, "visibility" | "owner_user_id" | "created_by">,
  userId: string,
  isBaseCreator = false,
): boolean {
  if (row.visibility === "personal") return row.owner_user_id === userId;
  if (row.visibility === "locked") return row.created_by === userId || isBaseCreator;
  return true;
}

export function serializeView(
  row: ViewRow,
  userId: string,
  info: TableConfigInfo | undefined,
  isBaseCreator = false,
): ViewWire {
  return {
    id: pid("viw", row.id),
    tableId: pid("tbl", row.table_id),
    name: row.name,
    type: row.type,
    isDefault: Boolean(row.is_default),
    visibility: row.visibility,
    ownerUserId: row.owner_user_id ? pid("usr", row.owner_user_id) : null,
    createdBy: row.created_by ? pid("usr", row.created_by) : null,
    isFavorite: Boolean(row.is_favorite),
    isMine: row.created_by === userId || row.owner_user_id === userId,
    canEdit: canEditView(row, userId, isBaseCreator),
    config: normalizeViewConfig(row.config, row.type, info?.fields ?? [], info?.name),
  };
}
