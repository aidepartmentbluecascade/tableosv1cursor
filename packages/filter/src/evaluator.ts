import type { CellsRecord } from "@tabula/fields";
import type {
  FilterAndGroup,
  FilterAst,
  FilterCondition,
  FilterNode,
  FilterOrGroup,
} from "./ast.js";

export interface SlotFieldMap {
  /** fieldId → cell slot (decimal string key in cells). */
  fieldIdToSlot: Record<string, string>;
}

function cellValue(cells: CellsRecord, slot: string | undefined): unknown {
  if (slot === undefined) return undefined;
  return cells[slot];
}

function isEmptyValue(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    value === "" ||
    (Array.isArray(value) && value.length === 0)
  );
}

function compareValues(a: unknown, b: unknown): number | null {
  if (typeof a === "number" && typeof b === "number") {
    return a - b;
  }
  if (typeof a === "string" && typeof b === "string") {
    return a.localeCompare(b);
  }
  return null;
}

function evalCondition(
  condition: FilterCondition,
  cells: CellsRecord,
  map: SlotFieldMap,
): boolean {
  const slot = map.fieldIdToSlot[condition.fieldId];
  const value = cellValue(cells, slot);

  switch (condition.op) {
    case "empty":
      return isEmptyValue(value);
    case "notEmpty":
      return !isEmptyValue(value);
    case "eq": {
      if (isEmptyValue(value)) return false;
      if (typeof value === "string" && typeof condition.value === "string") {
        return value.toLowerCase() === condition.value.toLowerCase();
      }
      return value === condition.value;
    }
    case "neq": {
      if (isEmptyValue(value)) return condition.value !== undefined && condition.value !== null;
      if (typeof value === "string" && typeof condition.value === "string") {
        return value.toLowerCase() !== condition.value.toLowerCase();
      }
      return value !== condition.value;
    }
    case "contains": {
      if (typeof value !== "string" || condition.value === undefined) return false;
      return value.toLowerCase().includes(String(condition.value).toLowerCase());
    }
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      const cmp = compareValues(value, condition.value);
      if (cmp === null) return false;
      if (condition.op === "gt") return cmp > 0;
      if (condition.op === "gte") return cmp >= 0;
      if (condition.op === "lt") return cmp < 0;
      return cmp <= 0;
    }
    default:
      return false;
  }
}

function evalNode(node: FilterNode, cells: CellsRecord, map: SlotFieldMap): boolean {
  if (node.kind === "condition") {
    return evalCondition(node, cells, map);
  }
  if (node.kind === "and") {
    return node.children.every((c) => evalNode(c, cells, map));
  }
  return node.children.some((c) => evalNode(c, cells, map));
}

export function evaluateFilter(
  ast: FilterAst,
  cells: CellsRecord,
  map: SlotFieldMap,
): boolean {
  return evalNode(ast, cells, map);
}

export function andGroup(children: FilterNode[]): FilterAndGroup {
  return { kind: "and", children };
}

export function orGroup(children: FilterNode[]): FilterOrGroup {
  return { kind: "or", children };
}
