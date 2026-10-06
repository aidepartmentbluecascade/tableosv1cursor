import { sql } from "kysely";
import type { TabulaDb } from "@tabula/db";
import type { PlanQueryContext } from "@tabula/query";
import { INDEX_SIDECAR_THRESHOLD } from "../recordstore/sidecars.js";
import { pid } from "../../lib/public-ids.js";

export interface QueryFieldRow {
  id: string;
  slot: number;
  name: string;
  type: string;
  index_state: string;
  is_computed: boolean;
}

export interface TableQueryMeta {
  record_count: number;
}

export async function loadQueryFields(
  db: TabulaDb,
  tableId: string,
): Promise<QueryFieldRow[]> {
  const result = await sql<QueryFieldRow>`
    SELECT id, slot, name, type, index_state, is_computed
    FROM data.fields
    WHERE table_id = ${tableId} AND deleted_at IS NULL
    ORDER BY slot ASC
  `.execute(db);
  return result.rows;
}

export async function loadTableQueryMeta(
  db: TabulaDb,
  tableId: string,
): Promise<TableQueryMeta> {
  const result = await sql<{ record_count: string }>`
    SELECT record_count
    FROM data.tables
    WHERE id = ${tableId}
  `.execute(db);
  const row = result.rows[0];
  return {
    record_count: Number(row?.record_count ?? 0),
  };
}

export function buildPlanContext(
  fields: QueryFieldRow[],
  meta: TableQueryMeta,
): PlanQueryContext {
  // Clients address fields by public id (fld_…); internal callers use raw UUIDs.
  // Register both so filters, sorts and groups resolve either form.
  const fieldSlotById = new Map<string, number>();
  const fieldTypeByFieldId = new Map<string, string>();
  for (const f of fields) {
    for (const key of [f.id, pid("fld", f.id)]) {
      fieldSlotById.set(key, f.slot);
      fieldTypeByFieldId.set(key, f.type);
    }
  }
  const sidecarReadySlots = new Set<number>();
  for (const f of fields) {
    if (f.index_state === "ready") {
      sidecarReadySlots.add(f.slot);
    }
  }
  const useSidecars =
    meta.record_count >= INDEX_SIDECAR_THRESHOLD || sidecarReadySlots.size > 0;

  return {
    fieldSlotById,
    fieldTypeByFieldId,
    sidecarReadySlots,
    useSidecars,
  };
}
