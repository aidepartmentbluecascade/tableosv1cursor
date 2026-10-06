import * as filterPkg from "@tabula/filter";
import type { QueryClient } from "@tanstack/react-query";
import type { BaseDetail, FieldDto, FilterAst, TableDto, ViewDto } from "../../lib/api.ts";
import type { ViewConfig, ViewWire } from "../../lib/api-areas/views.ts";

/* ------------------------------------------------------------------ */
/* Filter operators (CONTRACTS §6). Prefer A's exports from @tabula/filter;
 * fall back to a local table with the same semantics until it ships. */

export type FilterOp =
  | "eq" | "neq" | "contains" | "notContains" | "startsWith" | "endsWith"
  | "gt" | "gte" | "lt" | "lte" | "empty" | "notEmpty" | "anyOf" | "noneOf"
  | "hasAnyOf" | "hasAllOf" | "isWithin" | "isBefore" | "isAfter"
  | "isOnOrBefore" | "isOnOrAfter" | "isMe";

const TEXT_OPS: FilterOp[] = ["contains", "notContains", "eq", "neq", "startsWith", "endsWith", "empty", "notEmpty"];
const NUM_OPS: FilterOp[] = ["eq", "neq", "gt", "gte", "lt", "lte", "empty", "notEmpty"];
const DATE_OPS: FilterOp[] = ["eq", "isBefore", "isAfter", "isOnOrBefore", "isOnOrAfter", "isWithin", "neq", "empty", "notEmpty"];

function localOperatorsForFieldType(type: string): FilterOp[] {
  switch (type) {
    case "number": case "currency": case "percent": case "rating": case "duration":
    case "autonumber": case "count":
      return NUM_OPS;
    case "checkbox":
      return ["eq"];
    case "date": case "datetime": case "created_time": case "modified_time":
      return DATE_OPS;
    case "single_select":
      return ["eq", "neq", "anyOf", "noneOf", "empty", "notEmpty"];
    case "multi_select":
      return ["hasAnyOf", "hasAllOf", "noneOf", "eq", "empty", "notEmpty"];
    case "collaborator": case "created_by": case "modified_by":
      return ["hasAnyOf", "noneOf", "isMe", "empty", "notEmpty"];
    case "attachment":
      return ["empty", "notEmpty"];
    case "link": case "lookup":
      return ["contains", "notContains", "empty", "notEmpty"];
    default:
      return TEXT_OPS;
  }
}

const LABELS: Record<FilterOp, string> = {
  eq: "is", neq: "is not", contains: "contains", notContains: "does not contain",
  startsWith: "starts with", endsWith: "ends with", gt: ">", gte: "≥", lt: "<", lte: "≤",
  empty: "is empty", notEmpty: "is not empty", anyOf: "is any of", noneOf: "is none of",
  hasAnyOf: "has any of", hasAllOf: "has all of", isWithin: "is within",
  isBefore: "is before", isAfter: "is after", isOnOrBefore: "is on or before",
  isOnOrAfter: "is on or after", isMe: "is me",
};

const pkg = filterPkg as unknown as {
  operatorsForFieldType?: (type: string) => string[];
  operatorLabel?: (op: string) => string;
};

export function operatorsForFieldType(type: string): FilterOp[] {
  try {
    const ops = pkg.operatorsForFieldType?.(type);
    if (ops && ops.length) return ops as FilterOp[];
  } catch {
    /* fall back */
  }
  return localOperatorsForFieldType(type);
}

export function operatorLabel(op: string): string {
  try {
    const l = pkg.operatorLabel?.(op);
    if (l) return l;
  } catch {
    /* fall back */
  }
  return LABELS[op as FilterOp] ?? op;
}

export const VALUELESS_OPS = new Set(["empty", "notEmpty", "isMe"]);
export const MULTI_VALUE_OPS = new Set(["anyOf", "noneOf", "hasAnyOf", "hasAllOf"]);
export const DATE_FIELD_TYPES = new Set(["date", "datetime", "created_time", "modified_time"]);

export const RELATIVE_DATES: { id: string; label: string }[] = [
  { id: "today", label: "today" },
  { id: "tomorrow", label: "tomorrow" },
  { id: "yesterday", label: "yesterday" },
  { id: "oneWeekAgo", label: "one week ago" },
  { id: "oneWeekFromNow", label: "one week from now" },
  { id: "oneMonthAgo", label: "one month ago" },
  { id: "oneMonthFromNow", label: "one month from now" },
  { id: "exactDate", label: "exact date" },
];

export const WITHIN_RANGES: { id: string; label: string }[] = [
  { id: "pastWeek", label: "the past week" },
  { id: "pastMonth", label: "the past month" },
  { id: "pastYear", label: "the past year" },
  { id: "nextWeek", label: "the next week" },
  { id: "nextMonth", label: "the next month" },
  { id: "nextYear", label: "the next year" },
  { id: "thisWeek", label: "this week" },
  { id: "thisMonth", label: "this month" },
  { id: "pastNDays", label: "the past number of days" },
  { id: "nextNDays", label: "the next number of days" },
];

/** Default value for a newly chosen field/op. */
export function defaultFilterValue(field: FieldDto | undefined, op: string): unknown {
  if (!field || VALUELESS_OPS.has(op)) return undefined;
  if (op === "isWithin") return { range: "pastWeek" };
  if (DATE_FIELD_TYPES.has(field.type)) return { relative: "today" };
  if (MULTI_VALUE_OPS.has(op)) return [];
  if (field.type === "checkbox") return true;
  return "";
}

export type FilterGroup = { kind: "and" | "or"; children: FilterAst[] };
export type FilterCondition = Extract<FilterAst, { kind: "condition" }>;

export function emptyGroup(kind: "and" | "or" = "and"): FilterGroup {
  return { kind, children: [] };
}

/** Normalise any saved filter into a root group for the builder. */
export function toRootGroup(filter: FilterAst | null | undefined): FilterGroup {
  if (!filter) return emptyGroup();
  if (filter.kind === "condition") return { kind: "and", children: [filter] };
  return filter as FilterGroup;
}

function isConditionComplete(c: FilterCondition): boolean {
  if (!c.fieldId || !c.op) return false;
  if (VALUELESS_OPS.has(c.op)) return true;
  const v = c.value;
  if (v === undefined || v === null || v === "") return false;
  if (Array.isArray(v) && v.length === 0) return false;
  if (typeof v === "object" && v && "relative" in v) {
    const r = v as { relative: string; date?: string };
    return r.relative !== "exactDate" || Boolean(r.date);
  }
  return true;
}

/** Remove incomplete conditions / empty groups; null when nothing remains. */
export function cleanFilter(node: FilterAst | null | undefined): FilterAst | null {
  if (!node) return null;
  if (node.kind === "condition") return isConditionComplete(node) ? node : null;
  const children = node.children
    .map((c) => cleanFilter(c))
    .filter((c): c is FilterAst => c !== null);
  if (children.length === 0) return null;
  return { kind: node.kind, children };
}

export function countConditions(node: FilterAst | null | undefined): number {
  if (!node) return 0;
  if (node.kind === "condition") return 1;
  return node.children.reduce((n, c) => n + countConditions(c), 0);
}

export function andFilters(...filters: (FilterAst | null | undefined)[]): FilterAst | null {
  const parts = filters.filter((f): f is FilterAst => Boolean(f));
  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0]!;
  return { kind: "and", children: parts };
}

/* ------------------------------------------------------------------ */
/* Fields */

export const NON_EDITABLE_TYPES = new Set([
  "formula", "lookup", "rollup", "count", "autonumber", "created_time",
  "modified_time", "created_by", "modified_by", "button", "ai_generated",
]);

export function isEditableField(f: FieldDto): boolean {
  return !NON_EDITABLE_TYPES.has(f.type) && !(f as { isComputed?: boolean }).isComputed;
}

/** Table fields in view order (primary first, then fieldOrder, then the rest). */
export function orderedFields(table: TableDto, config: Pick<ViewConfig, "fieldOrder">): FieldDto[] {
  const byId = new Map(table.fields.map((f) => [f.id, f]));
  const out: FieldDto[] = [];
  const seen = new Set<string>();
  const primary = byId.get(table.primaryFieldId);
  if (primary) {
    out.push(primary);
    seen.add(primary.id);
  }
  for (const id of config.fieldOrder ?? []) {
    const f = byId.get(id);
    if (f && !seen.has(id)) {
      out.push(f);
      seen.add(id);
    }
  }
  const rest = table.fields
    .filter((f) => !seen.has(f.id))
    .sort((a, b) => a.slot - b.slot);
  return [...out, ...rest];
}

export function visibleFields(table: TableDto, config: ViewConfig): FieldDto[] {
  const hidden = new Set(config.hiddenFieldIds);
  return orderedFields(table, config).filter(
    (f) => f.id === table.primaryFieldId || !hidden.has(f.id),
  );
}

export interface SelectOptionLike {
  id: string;
  label: string;
  color?: string;
}

export function selectOptions(field: FieldDto | undefined): SelectOptionLike[] {
  const opts = (field?.config as { options?: unknown } | undefined)?.options;
  if (!Array.isArray(opts)) return [];
  return opts
    .filter((o): o is { id: string; label?: string; name?: string; color?: string } =>
      Boolean(o && typeof o === "object" && "id" in o),
    )
    .map((o) => ({ id: o.id, label: o.label ?? o.name ?? o.id, ...(o.color ? { color: o.color } : {}) }));
}

export const OPTION_COLORS: Record<string, { bg: string; fg: string }> = {
  blue: { bg: "#cfdfff", fg: "#102046" },
  cyan: { bg: "#d0f0fd", fg: "#04283f" },
  teal: { bg: "#c2f5e9", fg: "#012524" },
  green: { bg: "#d1f7c4", fg: "#0b1d05" },
  yellow: { bg: "#ffeab6", fg: "#3b2501" },
  orange: { bg: "#fee2d5", fg: "#6b2613" },
  red: { bg: "#ffdce5", fg: "#4c0c1c" },
  pink: { bg: "#ffdaf6", fg: "#400832" },
  purple: { bg: "#ede2fe", fg: "#280b42" },
  gray: { bg: "#eeeeee", fg: "#040404" },
};
export const COLOR_NAMES = Object.keys(OPTION_COLORS);

export function colorOf(color: string | null | undefined): { bg: string; fg: string } {
  if (!color) return OPTION_COLORS.gray!;
  if (OPTION_COLORS[color]) return OPTION_COLORS[color]!;
  if (/^#[0-9a-f]{6}$/i.test(color)) return { bg: `${color}33`, fg: "#1e293b" };
  return OPTION_COLORS.gray!;
}

/** Primary display string for a record. */
export function primaryText(table: TableDto, record: { fields: Record<string, unknown> }): string {
  const pf = table.fields.find((f) => f.id === table.primaryFieldId);
  if (!pf) return "";
  return valueToText(pf, record.fields[pf.id]);
}

export function valueToText(field: FieldDto, value: unknown): string {
  if (value === null || value === undefined) return "";
  if (field.type === "single_select") {
    return selectOptions(field).find((o) => o.id === value)?.label ?? String(value);
  }
  if (field.type === "multi_select" && Array.isArray(value)) {
    const opts = selectOptions(field);
    return value.map((v) => opts.find((o) => o.id === v)?.label ?? String(v)).join(", ");
  }
  if (Array.isArray(value)) {
    return value
      .map((v) => {
        if (v && typeof v === "object") {
          const o = v as { name?: string; filename?: string; email?: string; id?: string };
          return o.name ?? o.filename ?? o.email ?? o.id ?? "";
        }
        return String(v);
      })
      .join(", ");
  }
  if (typeof value === "object") {
    const o = value as { name?: string; text?: string; email?: string };
    return o.name ?? o.text ?? o.email ?? JSON.stringify(value);
  }
  if (typeof value === "boolean") return value ? "✓" : "";
  return String(value);
}

/* ------------------------------------------------------------------ */
/* Cache helpers */

export function patchViewInCaches(
  qc: QueryClient,
  baseId: string,
  tableId: string,
  viewId: string,
  fn: (v: ViewWire) => ViewWire,
): void {
  qc.setQueryData<BaseDetail>(["bases", baseId], (old) =>
    old
      ? {
          ...old,
          tables: old.tables.map((t) =>
            t.id === tableId
              ? { ...t, views: t.views.map((v) => (v.id === viewId ? (fn(v as ViewWire) as ViewDto) : v)) }
              : t,
          ),
        }
      : old,
  );
  qc.setQueryData<{ views: ViewWire[] }>(["views", baseId, tableId], (old) =>
    old ? { ...old, views: old.views.map((v) => (v.id === viewId ? fn(v) : v)) } : old,
  );
}

export function setViewsInCaches(
  qc: QueryClient,
  baseId: string,
  tableId: string,
  fn: (views: ViewWire[]) => ViewWire[],
): void {
  qc.setQueryData<BaseDetail>(["bases", baseId], (old) =>
    old
      ? {
          ...old,
          tables: old.tables.map((t) =>
            t.id === tableId ? { ...t, views: fn(t.views as ViewWire[]) as ViewDto[] } : t,
          ),
        }
      : old,
  );
  qc.setQueryData<{ views: ViewWire[] }>(["views", baseId, tableId], (old) =>
    old ? { ...old, views: fn(old.views) } : old,
  );
}

/* ------------------------------------------------------------------ */
/* Dates */

export function ymd(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

/** Parse a date/datetime wire value into a local Date (date-only = local midnight). */
export function parseDateValue(v: unknown): Date | null {
  if (typeof v !== "string" || !v) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const [y, m, d] = v.split("-").map(Number);
    return new Date(y!, m! - 1, d!);
  }
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

export function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export function dayDiff(a: Date, b: Date): number {
  return Math.round((startOfDay(a).getTime() - startOfDay(b).getTime()) / 86_400_000);
}

/** Shift a date/datetime wire value by n days, keeping its kind. */
export function shiftDateValue(field: FieldDto, value: unknown, days: number): string | null {
  const d = parseDateValue(value);
  if (!d) return null;
  const moved = addDays(d, days);
  return field.type === "datetime" ? moved.toISOString() : ymd(moved);
}

export function dateValueFor(field: FieldDto, day: Date): string {
  if (field.type === "datetime") {
    const d = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 9, 0, 0);
    return d.toISOString();
  }
  return ymd(day);
}
