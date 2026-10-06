/** Filter operators (CONTRACTS §6). */
export type FilterOp =
  | "eq"
  | "neq"
  | "contains"
  | "notContains"
  | "startsWith"
  | "endsWith"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "empty"
  | "notEmpty"
  | "anyOf"
  | "noneOf"
  | "hasAnyOf"
  | "hasAllOf"
  | "isWithin"
  | "isBefore"
  | "isAfter"
  | "isOnOrBefore"
  | "isOnOrAfter"
  | "isMe";

export const FILTER_OPS: readonly FilterOp[] = [
  "eq",
  "neq",
  "contains",
  "notContains",
  "startsWith",
  "endsWith",
  "gt",
  "gte",
  "lt",
  "lte",
  "empty",
  "notEmpty",
  "anyOf",
  "noneOf",
  "hasAnyOf",
  "hasAllOf",
  "isWithin",
  "isBefore",
  "isAfter",
  "isOnOrBefore",
  "isOnOrAfter",
  "isMe",
];

export type RelativeDate =
  | "today"
  | "tomorrow"
  | "yesterday"
  | "oneWeekAgo"
  | "oneWeekFromNow"
  | "oneMonthAgo"
  | "oneMonthFromNow"
  | "nDaysAgo"
  | "nDaysFromNow"
  | "exactDate";

/** Date operand: `"YYYY-MM-DD"` or a relative date. */
export type DateFilterValue =
  | string
  | { relative: RelativeDate; date?: string; n?: number };

export type WithinRange =
  | "pastWeek"
  | "pastMonth"
  | "pastYear"
  | "nextWeek"
  | "nextMonth"
  | "nextYear"
  | "thisWeek"
  | "thisMonth"
  | "thisYear"
  | "pastNDays"
  | "nextNDays";

export interface WithinFilterValue {
  range: WithinRange;
  n?: number;
}

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

/** A filter that cannot be compiled/evaluated (unknown field, bad operator, bad value). Maps to HTTP 422. */
export class FilterError extends Error {
  readonly code: string;
  readonly fieldId: string | undefined;
  constructor(message: string, code = "INVALID_FILTER", fieldId?: string) {
    super(message);
    this.name = "FilterError";
    this.code = code;
    this.fieldId = fieldId;
  }
}

export function isFilterError(e: unknown): e is FilterError {
  return e instanceof FilterError || (e instanceof Error && e.name === "FilterError");
}
