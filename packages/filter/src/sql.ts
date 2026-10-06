import type { FilterAst, FilterCondition, FilterNode, FilterOp } from "./ast.js";
import { parseFilterAst } from "./parse.js";

export type SidecarKind = "text" | "num" | "time";

export interface CompileFilterOptions {
  useSidecars?: boolean;
  sidecarReadySlots?: Set<number>;
  /** fieldId → field type key (for sidecar table selection). */
  fieldTypeByFieldId?: Map<string, string>;
  /** Alias for the records table in SQL (default `r`). */
  recordAlias?: string;
}

export interface CompiledFilterSql {
  sql: string;
  params: unknown[];
}

function sidecarKindForType(type: string | undefined): SidecarKind {
  switch (type) {
    case "number":
    case "currency":
    case "percent":
    case "rating":
    case "duration":
    case "autonumber":
    case "count":
    case "checkbox":
    case "date":
      return "num";
    case "dateTime":
    case "createdTime":
    case "lastModifiedTime":
      return "time";
    default:
      return "text";
  }
}

function sidecarTable(kind: SidecarKind): string {
  switch (kind) {
    case "num":
      return "data.record_index_num";
    case "time":
      return "data.record_index_time";
    default:
      return "data.record_index_text";
  }
}

function isNumericOp(op: FilterOp): boolean {
  return op === "gt" || op === "gte" || op === "lt" || op === "lte";
}

function foldText(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

class SqlBuilder {
  params: unknown[] = [];
  private readonly alias: string;

  constructor(alias: string) {
    this.alias = alias;
  }

  addParam(value: unknown): string {
    this.params.push(value);
    return `$${this.params.length}`;
  }

  slotKey(slot: number): string {
    return String(slot);
  }

  textExpr(slot: number): string {
    const k = this.slotKey(slot);
    return `${this.alias}.cells->>'${k}'`;
  }

  numExpr(slot: number): string {
    const k = this.slotKey(slot);
    return `(${this.alias}.cells->>'${k}')::double precision`;
  }

  presentExpr(slot: number): string {
    const k = this.slotKey(slot);
    return `(${this.alias}.cells ? '${k}')`;
  }

  emptyExpr(slot: number): string {
    const k = this.slotKey(slot);
    return `(
      NOT (${this.alias}.cells ? '${k}')
      OR ${this.alias}.cells->'${k}' IS NULL
      OR (
        jsonb_typeof(${this.alias}.cells->'${k}') = 'string'
        AND btrim(${this.alias}.cells->>'${k}') = ''
      )
      OR (
        jsonb_typeof(${this.alias}.cells->'${k}') = 'array'
        AND jsonb_array_length(${this.alias}.cells->'${k}') = 0
      )
    )`;
  }

  sidecarSubquery(
    kind: SidecarKind,
    slot: number,
    predicateSql: string,
  ): string {
    const table = sidecarTable(kind);
    return `${this.alias}.id IN (
      SELECT s.record_id FROM ${table} s
      WHERE s.table_id = ${this.alias}.table_id
        AND s.field_slot = ${slot}
        AND ${predicateSql}
    )`;
  }
}

function useSidecarForCondition(
  slot: number,
  op: FilterOp,
  options: CompileFilterOptions,
): boolean {
  if (!options.useSidecars) return false;
  if (!options.sidecarReadySlots?.has(slot)) return false;
  if (op === "contains" || op === "empty" || op === "notEmpty") return false;
  return true;
}

function compileCondition(
  condition: FilterCondition,
  fieldSlotById: Map<string, number>,
  options: CompileFilterOptions,
  b: SqlBuilder,
): string {
  const slot = fieldSlotById.get(condition.fieldId);
  if (slot === undefined) {
    return "FALSE";
  }

  const fieldType = options.fieldTypeByFieldId?.get(condition.fieldId);
  const sidecarKind = sidecarKindForType(fieldType);
  const numeric = isNumericOp(condition.op) || (condition.op === "eq" && sidecarKind === "num");

  if (condition.op === "empty") {
    return b.emptyExpr(slot);
  }
  if (condition.op === "notEmpty") {
    return `NOT (${b.emptyExpr(slot)})`;
  }

  if (useSidecarForCondition(slot, condition.op, options)) {
    const table = sidecarTable(sidecarKind);
    const valueCol = sidecarKind === "text" ? "value_eq" : "sort_key";
    switch (condition.op) {
      case "eq": {
        const p = b.addParam(
          sidecarKind === "text"
            ? foldText(condition.value)
            : Number(condition.value),
        );
        const sub = b.sidecarSubquery(
          sidecarKind,
          slot,
          `s.${valueCol} = ${p}`,
        );
        const recheck =
          sidecarKind === "text"
            ? `lower(${b.textExpr(slot)}) = ${p}`
            : `${b.numExpr(slot)} = ${p}`;
        return `(${sub} AND COALESCE(${recheck}, FALSE))`;
      }
      case "neq": {
        const p = b.addParam(
          sidecarKind === "text"
            ? foldText(condition.value)
            : Number(condition.value),
        );
        return `(${b.textExpr(slot)}) IS DISTINCT FROM ${p}`;
      }
      case "gt":
      case "gte":
      case "lt":
      case "lte": {
        const p = b.addParam(Number(condition.value));
        const cmp =
          condition.op === "gt"
            ? ">"
            : condition.op === "gte"
              ? ">="
              : condition.op === "lt"
                ? "<"
                : "<=";
        const sub = b.sidecarSubquery(
          sidecarKind,
          slot,
          `s.${valueCol} ${cmp} ${p}`,
        );
        return `(COALESCE(${b.numExpr(slot)} ${cmp} ${p}, FALSE) OR ${sub})`;
      }
      default:
        break;
    }
    void table;
  }

  if (condition.op === "contains") {
    const p = b.addParam(foldText(condition.value));
    return `COALESCE(strpos(lower(${b.textExpr(slot)}), ${p}) > 0, FALSE)`;
  }

  if (condition.op === "eq") {
    if (numeric) {
      const p = b.addParam(Number(condition.value));
      return `COALESCE(${b.numExpr(slot)} = ${p}, FALSE)`;
    }
    const p = b.addParam(foldText(condition.value));
    return `COALESCE(lower(${b.textExpr(slot)}) = ${p}, FALSE)`;
  }

  if (condition.op === "neq") {
    if (numeric) {
      const p = b.addParam(Number(condition.value));
      return `${b.numExpr(slot)} IS DISTINCT FROM ${p}`;
    }
    const p = b.addParam(foldText(condition.value));
    return `lower(${b.textExpr(slot)}) IS DISTINCT FROM ${p}`;
  }

  if (isNumericOp(condition.op)) {
    const p = b.addParam(Number(condition.value));
    const cmp =
      condition.op === "gt"
        ? ">"
        : condition.op === "gte"
          ? ">="
          : condition.op === "lt"
            ? "<"
            : "<=";
    return `COALESCE(${b.numExpr(slot)} ${cmp} ${p}, FALSE)`;
  }

  return "FALSE";
}

function compileNode(
  node: FilterNode,
  fieldSlotById: Map<string, number>,
  options: CompileFilterOptions,
  b: SqlBuilder,
): string {
  if (node.kind === "condition") {
    return compileCondition(node, fieldSlotById, options, b);
  }
  if (node.kind === "and") {
    if (node.children.length === 0) return "TRUE";
    return `(${node.children.map((c) => compileNode(c, fieldSlotById, options, b)).join(" AND ")})`;
  }
  if (node.children.length === 0) return "FALSE";
  return `(${node.children.map((c) => compileNode(c, fieldSlotById, options, b)).join(" OR ")})`;
}

export function compileFilterToSql(
  filter: FilterAst | unknown,
  fieldSlotById: Map<string, number>,
  options: CompileFilterOptions = {},
): CompiledFilterSql {
  const ast =
    filter && typeof filter === "object" && "kind" in (filter as object)
      ? (filter as FilterAst)
      : parseFilterAst(filter);
  if (!ast) {
    return { sql: "TRUE", params: [] };
  }

  const alias = options.recordAlias ?? "r";
  const b = new SqlBuilder(alias);
  const sql = compileNode(ast, fieldSlotById, options, b);
  return { sql, params: b.params };
}
