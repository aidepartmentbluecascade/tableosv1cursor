import { decodePublicId } from "@tabula/types";
import { sql } from "kysely";
import type { TabulaDb } from "@tabula/db";

export interface FieldRow {
  id: string;
  slot: number;
  name: string;
  type: string;
}

export async function loadTableFields(
  db: TabulaDb,
  tableId: string,
): Promise<FieldRow[]> {
  const result = await sql<FieldRow>`
    SELECT id, slot, name, type
    FROM data.fields
    WHERE table_id = ${tableId} AND deleted_at IS NULL
    ORDER BY slot ASC
  `.execute(db);
  return result.rows;
}

export function mapInputFieldsToCells(
  fields: FieldRow[],
  input: Record<string, unknown>,
): Record<string, unknown> {
  const byId = new Map(fields.map((f) => [f.id, f]));
  const byName = new Map(fields.map((f) => [f.name.toLowerCase(), f]));
  const cells: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(input)) {
    let field: FieldRow | undefined;
    if (key.includes("_")) {
      try {
        const decoded = decodePublicId(key);
        if (decoded.prefix === "fld") {
          field = byId.get(decoded.uuid);
        }
      } catch {
        field = byName.get(key.toLowerCase());
      }
    } else {
      field = byName.get(key.toLowerCase());
    }
    if (field) {
      cells[String(field.slot)] = value;
    }
  }
  return cells;
}
