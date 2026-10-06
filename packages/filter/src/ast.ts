export type FilterOp =
  | "eq"
  | "neq"
  | "contains"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "empty"
  | "notEmpty";

export interface FilterCondition {
  kind: "condition";
  fieldId: string;
  op: FilterOp;
  value?: unknown;
}

export interface FilterAndGroup {
  kind: "and";
  children: FilterNode[];
}

export interface FilterOrGroup {
  kind: "or";
  children: FilterNode[];
}

export type FilterNode = FilterCondition | FilterAndGroup | FilterOrGroup;

export type FilterAst = FilterAndGroup | FilterOrGroup | FilterCondition;
