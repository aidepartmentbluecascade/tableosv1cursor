import type { Database } from "@tabula/db";
import { sql, type Transaction } from "kysely";

type DbTrx = Transaction<Database>;

export const INDEX_SIDECAR_THRESHOLD = 20_000;

export interface SidecarFieldRow {
  slot: number;
  type: string;
  index_state: string;
}

export interface SidecarTableMeta {
  record_count: number;
  workspace_id: string;
  base_id: string;
}

function sidecarKind(type: string): "text" | "num" | "time" | null {
  switch (type) {
    case "number":
    case "currency":
    case "percent":
    case "rating":
    case "date":
    case "checkbox":
      return "num";
    case "dateTime":
    case "createdTime":
    case "lastModifiedTime":
      return "time";
    case "singleLineText":
    case "longText":
    case "email":
    case "url":
    case "phone":
    case "singleSelect":
      return "text";
    default:
      return null;
  }
}

function isEmptyCell(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    value === "" ||
    (Array.isArray(value) && value.length === 0)
  );
}

export function shouldMaintainSidecar(
  field: SidecarFieldRow,
  table: SidecarTableMeta,
): boolean {
  if (sidecarKind(field.type) === null) return false;
  if (field.index_state === "ready") return true;
  return table.record_count >= INDEX_SIDECAR_THRESHOLD;
}

function numProjection(value: unknown): { value_eq: number | null; sort_key: number | null } {
  if (isEmptyCell(value)) return { value_eq: null, sort_key: null };
  if (typeof value === "number" && Number.isFinite(value)) {
    return { value_eq: value, sort_key: value };
  }
  const n = Number(value);
  if (!Number.isFinite(n)) return { value_eq: null, sort_key: null };
  return { value_eq: n, sort_key: n };
}

function textProjection(value: unknown): { value_eq: string | null; sort_key: string | null } {
  if (isEmptyCell(value)) return { value_eq: null, sort_key: null };
  const s = String(value).slice(0, 512);
  return { value_eq: s, sort_key: s };
}

function timeProjection(value: unknown): { value_eq: Date | null; sort_key: Date | null } {
  if (isEmptyCell(value)) return { value_eq: null, sort_key: null };
  const d = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(d.getTime())) return { value_eq: null, sort_key: null };
  return { value_eq: d, sort_key: d };
}

export async function deleteSidecars(
  trx: DbTrx,
  tableId: string,
  recordId: string,
): Promise<void> {
  await sql`
    DELETE FROM data.record_index_num
    WHERE table_id = ${tableId} AND record_id = ${recordId}
  `.execute(trx);
  await sql`
    DELETE FROM data.record_index_text
    WHERE table_id = ${tableId} AND record_id = ${recordId}
  `.execute(trx);
  await sql`
    DELETE FROM data.record_index_time
    WHERE table_id = ${tableId} AND record_id = ${recordId}
  `.execute(trx);
}

export async function upsertSidecars(
  trx: DbTrx,
  tableId: string,
  recordId: string,
  cells: Record<string, unknown>,
  fields: SidecarFieldRow[],
  table: SidecarTableMeta,
): Promise<void> {
  await deleteSidecars(trx, tableId, recordId);

  for (const field of fields) {
    if (!shouldMaintainSidecar(field, table)) continue;
    const kind = sidecarKind(field.type);
    if (!kind) continue;

    const value = cells[String(field.slot)];
    if (isEmptyCell(value)) continue;

    if (kind === "num") {
      const { value_eq, sort_key } = numProjection(value);
      if (value_eq === null) continue;
      await sql`
        INSERT INTO data.record_index_num (
          table_id, field_slot, record_id, value_eq, sort_key, workspace_id, base_id
        ) VALUES (
          ${tableId}, ${field.slot}, ${recordId}, ${value_eq}, ${sort_key},
          ${table.workspace_id}, ${table.base_id}
        )
      `.execute(trx);
    } else if (kind === "text") {
      const { value_eq, sort_key } = textProjection(value);
      if (!value_eq) continue;
      await sql`
        INSERT INTO data.record_index_text (
          table_id, field_slot, record_id, value_eq, sort_key, workspace_id, base_id
        ) VALUES (
          ${tableId}, ${field.slot}, ${recordId}, ${value_eq}, ${sort_key},
          ${table.workspace_id}, ${table.base_id}
        )
      `.execute(trx);
    } else {
      const { value_eq, sort_key } = timeProjection(value);
      if (!value_eq) continue;
      await sql`
        INSERT INTO data.record_index_time (
          table_id, field_slot, record_id, value_eq, sort_key, workspace_id, base_id
        ) VALUES (
          ${tableId}, ${field.slot}, ${recordId}, ${value_eq}, ${sort_key},
          ${table.workspace_id}, ${table.base_id}
        )
      `.execute(trx);
    }
  }
}
