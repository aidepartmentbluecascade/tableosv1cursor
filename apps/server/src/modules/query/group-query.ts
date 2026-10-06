import { compileFilterToSql } from "@tabula/filter";
import type { TabulaDb } from "@tabula/db";
import { executeRawQuery } from "./raw-sql.js";
import {
  buildPlanContext,
  loadQueryFields,
  loadTableQueryMeta,
} from "./context.js";

function offsetSqlParams(fragment: string, offset: number): string {
  return fragment.replace(/\$(\d+)/g, (_, n) => `$${Number(n) + offset}`);
}

export interface GroupAggregateSpec {
  op: "count" | "sum";
  fieldId?: string | undefined;
}

export interface GroupQueryInput {
  filter?: unknown;
  groupBy: { fieldId: string }[];
  aggregates: GroupAggregateSpec[];
}

export async function executeGroupQuery(
  db: TabulaDb,
  tableId: string,
  input: GroupQueryInput,
): Promise<{ groups: Record<string, unknown>[] }> {
  const fieldRows = await loadQueryFields(db, tableId);
  const meta = await loadTableQueryMeta(db, tableId);
  const planCtx = buildPlanContext(fieldRows, meta);
  const fieldSlotById = planCtx.fieldSlotById;

  const groupField = input.groupBy[0];
  if (!groupField) {
    return { groups: [] };
  }
  const slot = fieldSlotById.get(groupField.fieldId);
  if (slot === undefined) {
    return { groups: [] };
  }

  const compiled = input.filter
    ? compileFilterToSql(input.filter, fieldSlotById, planCtx)
    : { sql: "TRUE", params: [] as unknown[] };

  const filterClause = compiled.sql !== "TRUE"
    ? ` AND (${offsetSqlParams(compiled.sql, 1)})`
    : "";

  const selectParts: string[] = [
    `r.cells->>'${slot}' AS group_key`,
  ];
  const paramValues: unknown[] = [tableId, ...compiled.params];

  for (const agg of input.aggregates) {
    if (agg.op === "count") {
      selectParts.push("COUNT(*)::bigint AS count_all");
    } else if (agg.op === "sum" && agg.fieldId) {
      const sumSlot = fieldSlotById.get(agg.fieldId);
      if (sumSlot !== undefined) {
        selectParts.push(
          `COALESCE(SUM((r.cells->>'${sumSlot}')::double precision), 0) AS sum_${sumSlot}`,
        );
      }
    }
  }

  if (selectParts.length === 1) {
    selectParts.push("COUNT(*)::bigint AS count_all");
  }

  const queryText = `
    SELECT ${selectParts.join(", ")}
    FROM data.records r
    WHERE r.table_id = $1 AND r.deleted_at IS NULL
    ${filterClause}
    GROUP BY r.cells->>'${slot}'
    ORDER BY group_key NULLS LAST
    LIMIT 500
  `;

  const groups = await executeRawQuery<Record<string, unknown>>(
    db,
    queryText,
    paramValues,
  );
  return { groups };
}
