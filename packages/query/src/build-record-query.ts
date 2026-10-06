import type { RecordQueryPlan, SortPlanEntry } from "./types.js";
import { encodeRecordCursor, type RecordCursor } from "./cursor.js";

export interface RecordQuerySql {
  /** WHERE fragments (without table scope); combine with AND */
  filterSql: string | null;
  filterParams: unknown[];
  orderBySql: string;
  cursorSql: string | null;
  cursorParams: unknown[];
  limit: number;
}

function sortKeyExpr(entry: SortPlanEntry, alias: string): string {
  if (entry.source === "manual_order") {
    return `${alias}.manual_order`;
  }
  const slot = entry.slot;
  if (slot === undefined) {
    return `${alias}.manual_order`;
  }
  if (entry.source === "sidecar" && entry.sidecarKind) {
    const table =
      entry.sidecarKind === "num"
        ? "data.record_index_num"
        : entry.sidecarKind === "time"
          ? "data.record_index_time"
          : "data.record_index_text";
    const col = entry.sidecarKind === "text" ? "sort_key" : "sort_key";
    return `(
      SELECT s.${col} FROM ${table} s
      WHERE s.table_id = ${alias}.table_id
        AND s.field_slot = ${slot}
        AND s.record_id = ${alias}.id
      LIMIT 1
    )`;
  }
  return `${alias}.cells->>'${slot}'`;
}

function buildOrderBy(sort: SortPlanEntry[], alias: string): string {
  const parts = sort.map((s) => {
    const expr = sortKeyExpr(s, alias);
    const dir = s.direction === "desc" ? "DESC" : "ASC";
    return `${expr} ${dir} NULLS LAST`;
  });
  parts.push(`${alias}.id ASC`);
  return parts.join(", ");
}

function buildCursorPredicate(
  plan: RecordQueryPlan,
  alias: string,
): { sql: string | null; params: unknown[] } {
  const cursor = plan.cursor;
  if (!cursor) return { sql: null, params: [] };

  const primary = plan.sort[0];
  if (!primary) return { sql: null, params: [] };

  if (primary.source === "manual_order") {
    if (cursor.kind !== "manualOrder") {
      return { sql: null, params: [] };
    }
    const dir = primary.direction === "desc" ? "DESC" : "ASC";
    const cmp = dir === "ASC" ? ">" : "<";
    return {
      sql: `(${alias}.manual_order, ${alias}.id) ${cmp} ($1, $2)`,
      params: [cursor.manualOrder, cursor.id],
    };
  }

  if (cursor.kind === "fieldSort") {
    const expr = sortKeyExpr(primary, alias);
    const dir = primary.direction === "desc" ? "DESC" : "ASC";
    const cmp = dir === "ASC" ? ">" : "<";
    return {
      sql: `((${expr}), ${alias}.id) ${cmp} (($1), $2)`,
      params: [cursor.sortKey, cursor.id],
    };
  }

  return { sql: null, params: [] };
}

/** Build SQL fragments for a record list query (alias `r` on data.records). */
export function buildRecordQuerySql(
  plan: RecordQueryPlan,
  alias = "r",
): RecordQuerySql {
  const orderBySql = buildOrderBy(plan.sort, alias);
  const cursor = buildCursorPredicate(plan, alias);

  let filterSql = plan.filter?.sql ?? null;
  const filterParams = [...(plan.filter?.params ?? [])];

  if (cursor.sql) {
    const offset = filterParams.length;
    const cursorSql = cursor.sql.replace(/\$(\d+)/g, (_, n: string) => {
      return `$${offset + Number(n)}`;
    });
    filterSql = filterSql
      ? `(${filterSql}) AND (${cursorSql})`
      : cursorSql;
    filterParams.push(...cursor.params);
  }

  return {
    filterSql,
    filterParams,
    orderBySql,
    cursorSql: cursor.sql,
    cursorParams: cursor.params,
    limit: plan.limit,
  };
}

export function nextCursorFromRow(
  plan: RecordQueryPlan,
  row: {
    id: string;
    manual_order: string;
    cells: Record<string, unknown>;
  },
): string {
  const primary = plan.sort[0];
  if (!primary || primary.source === "manual_order") {
    return encodeRecordCursor({
      kind: "manualOrder",
      manualOrder: row.manual_order,
      id: row.id,
    });
  }
  const slot = primary.slot;
  const raw = slot !== undefined ? row.cells[String(slot)] : undefined;
  const sortKey =
    typeof raw === "number"
      ? raw
      : raw === undefined || raw === null
        ? ""
        : String(raw);
  return encodeRecordCursor({
    kind: "fieldSort",
    fieldId: primary.fieldId,
    slot: slot ?? 0,
    direction: primary.direction,
    sortKey,
    id: row.id,
  });
}

export type { RecordCursor };
