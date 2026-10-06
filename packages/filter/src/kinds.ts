import type { FilterOp } from "./ast.js";

/**
 * Value "kind" of a field for filtering/sorting purposes. Every field type maps
 * to exactly one kind; the compiler and evaluator branch on the kind.
 */
export type FilterKind =
  | "text"
  | "number"
  | "date"
  | "datetime"
  | "checkbox"
  | "single_select"
  | "multi_select"
  | "collaborator"
  | "user"
  | "link"
  | "attachment"
  | "array"
  | "none";

const LEGACY_TYPE_NAMES: Record<string, string> = {
  singleLineText: "text",
  singleLine: "text",
  longText: "long_text",
  multilineText: "long_text",
  richText: "long_text",
  dateTime: "datetime",
  singleSelect: "single_select",
  multiSelect: "multi_select",
  multipleSelects: "multi_select",
  createdTime: "created_time",
  lastModifiedTime: "modified_time",
  modifiedTime: "modified_time",
  createdBy: "created_by",
  lastModifiedBy: "modified_by",
  modifiedBy: "modified_by",
  phoneNumber: "phone",
  multipleAttachments: "attachment",
  multipleRecordLinks: "link",
  multipleLookupValues: "lookup",
  autoNumber: "autonumber",
  aiGenerated: "ai_generated",
  multipleCollaborators: "collaborator",
  singleCollaborator: "collaborator",
};

/** Normalize legacy camelCase type names to the canonical snake_case DB names. */
export function normalizeFieldType(type: string): string {
  return LEGACY_TYPE_NAMES[type] ?? type;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

export function filterKindForField(
  rawType: string,
  config?: Record<string, unknown> | null,
): FilterKind {
  const type = normalizeFieldType(rawType);
  const cfg = config ?? {};
  switch (type) {
    case "text":
    case "long_text":
    case "email":
    case "url":
    case "phone":
    case "barcode":
    case "json":
    case "ai_generated":
      return "text";
    case "number":
    case "currency":
    case "percent":
    case "rating":
    case "duration":
    case "autonumber":
    case "count":
      return "number";
    case "date":
      return "date";
    case "datetime":
    case "created_time":
    case "modified_time":
      return "datetime";
    case "checkbox":
      return "checkbox";
    case "single_select":
      return "single_select";
    case "multi_select":
      return "multi_select";
    case "collaborator":
      return "collaborator";
    case "created_by":
    case "modified_by":
      return "user";
    case "link":
    case "contact":
      return "link";
    case "attachment":
      return "attachment";
    case "lookup":
      return "array";
    case "formula": {
      const rt = str(cfg["resultType"]);
      if (rt === "number" || rt === "currency" || rt === "percent") return "number";
      if (rt === "date") return "date";
      if (rt === "datetime") return "datetime";
      if (rt === "boolean" || rt === "checkbox") return "checkbox";
      return "text";
    }
    case "rollup": {
      const agg = str(cfg["aggregation"]) ?? str(cfg["function"]) ?? "sum";
      if (agg === "concat" || agg === "arrayjoin") return "text";
      if (agg === "and" || agg === "or") return "checkbox";
      if (agg === "unique") return "array";
      return "number";
    }
    case "button":
      return "none";
    default:
      return "text";
  }
}

/** Formula without a declared result type: text ops plus numeric comparisons. */
export function isUntypedFormula(rawType: string, config?: Record<string, unknown> | null): boolean {
  if (normalizeFieldType(rawType) !== "formula") return false;
  const rt = (config ?? {})["resultType"];
  return typeof rt !== "string" || rt === "";
}

const OPS_BY_KIND: Record<FilterKind, FilterOp[]> = {
  text: ["contains", "notContains", "eq", "neq", "startsWith", "endsWith", "empty", "notEmpty"],
  number: ["eq", "neq", "gt", "gte", "lt", "lte", "empty", "notEmpty"],
  date: ["eq", "neq", "isBefore", "isAfter", "isOnOrBefore", "isOnOrAfter", "isWithin", "empty", "notEmpty"],
  datetime: ["eq", "neq", "isBefore", "isAfter", "isOnOrBefore", "isOnOrAfter", "isWithin", "empty", "notEmpty"],
  checkbox: ["eq"],
  single_select: ["eq", "neq", "anyOf", "noneOf", "empty", "notEmpty"],
  multi_select: ["hasAnyOf", "hasAllOf", "noneOf", "eq", "empty", "notEmpty"],
  collaborator: ["hasAnyOf", "hasAllOf", "noneOf", "eq", "isMe", "empty", "notEmpty"],
  user: ["eq", "neq", "anyOf", "noneOf", "isMe", "empty", "notEmpty"],
  link: ["contains", "notContains", "hasAnyOf", "hasAllOf", "noneOf", "empty", "notEmpty"],
  attachment: ["empty", "notEmpty"],
  array: ["contains", "notContains", "eq", "neq", "empty", "notEmpty"],
  none: [],
};

/**
 * Operators valid for a field type (CONTRACTS §6). The UI must use this list
 * rather than hard-coding operators. Pass the field config so formula/rollup
 * result types are taken into account.
 */
export function operatorsForFieldType(
  type: string,
  config?: Record<string, unknown> | null,
): FilterOp[] {
  const kind = filterKindForField(type, config);
  const ops = [...OPS_BY_KIND[kind]];
  if (isUntypedFormula(type, config)) ops.push("gt", "gte", "lt", "lte");
  return ops;
}

/** Same as {@link operatorsForFieldType} but by kind. */
export function operatorsForKind(kind: FilterKind): FilterOp[] {
  return [...OPS_BY_KIND[kind]];
}

const LABELS: Record<FilterOp, string> = {
  eq: "is",
  neq: "is not",
  contains: "contains",
  notContains: "does not contain",
  startsWith: "starts with",
  endsWith: "ends with",
  gt: ">",
  gte: "≥",
  lt: "<",
  lte: "≤",
  empty: "is empty",
  notEmpty: "is not empty",
  anyOf: "is any of",
  noneOf: "is none of",
  hasAnyOf: "has any of",
  hasAllOf: "has all of",
  isWithin: "is within",
  isBefore: "is before",
  isAfter: "is after",
  isOnOrBefore: "is on or before",
  isOnOrAfter: "is on or after",
  isMe: "is me",
};

/** Human label for an operator; pass the field type for type-specific wording. */
export function operatorLabel(op: FilterOp, type?: string, config?: Record<string, unknown> | null): string {
  if (type) {
    const kind = filterKindForField(type, config);
    if (kind === "number") {
      if (op === "eq") return "=";
      if (op === "neq") return "≠";
    }
    if (kind === "multi_select" || kind === "collaborator") {
      if (op === "eq") return "is exactly";
      if (op === "noneOf") return "has none of";
    }
    if (kind === "link" && op === "noneOf") return "has none of";
    if (kind === "checkbox" && op === "eq") return "is";
  }
  return LABELS[op] ?? op;
}

/** Operators that take no operand. */
export function operatorNeedsValue(op: FilterOp): boolean {
  return op !== "empty" && op !== "notEmpty" && op !== "isMe";
}

/** Relative-date options for date operand pickers. */
export const RELATIVE_DATE_OPTIONS: { value: string; label: string; needsDate?: boolean; needsN?: boolean }[] = [
  { value: "today", label: "today" },
  { value: "tomorrow", label: "tomorrow" },
  { value: "yesterday", label: "yesterday" },
  { value: "oneWeekAgo", label: "one week ago" },
  { value: "oneWeekFromNow", label: "one week from now" },
  { value: "oneMonthAgo", label: "one month ago" },
  { value: "oneMonthFromNow", label: "one month from now" },
  { value: "nDaysAgo", label: "number of days ago", needsN: true },
  { value: "nDaysFromNow", label: "number of days from now", needsN: true },
  { value: "exactDate", label: "exact date", needsDate: true },
];

/** `isWithin` range options. */
export const WITHIN_RANGE_OPTIONS: { value: string; label: string; needsN?: boolean }[] = [
  { value: "pastWeek", label: "the past week" },
  { value: "pastMonth", label: "the past month" },
  { value: "pastYear", label: "the past year" },
  { value: "nextWeek", label: "the next week" },
  { value: "nextMonth", label: "the next month" },
  { value: "nextYear", label: "the next year" },
  { value: "thisWeek", label: "this week" },
  { value: "thisMonth", label: "this month" },
  { value: "thisYear", label: "this year" },
  { value: "pastNDays", label: "the past number of days", needsN: true },
  { value: "nextNDays", label: "the next number of days", needsN: true },
];
