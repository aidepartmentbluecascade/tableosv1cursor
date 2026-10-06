import { FilterError } from "./ast.js";

/**
 * Date helpers shared by the SQL compiler and the in-memory evaluator, so both
 * resolve relative dates identically. All dates are calendar dates
 * `"YYYY-MM-DD"`; "today" is computed in the requested IANA time zone.
 */

export interface DateContext {
  now?: Date | undefined;
  timeZone?: string | undefined;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_PREFIX_RE = /^\d{4}-\d{2}-\d{2}/;

export function isValidTimeZone(tz: string | undefined | null): tz is string {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function resolveTimeZone(...candidates: (string | undefined | null)[]): string {
  for (const c of candidates) if (isValidTimeZone(c)) return c;
  return "UTC";
}

/** Calendar date of an instant in a time zone. */
export function dateInTimeZone(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function todayIn(ctx: DateContext): string {
  return dateInTimeZone(ctx.now ?? new Date(), resolveTimeZone(ctx.timeZone));
}

function toUtc(d: string): Date {
  const m = DATE_RE.exec(d);
  if (!m) throw new FilterError(`Invalid date: ${d}`, "INVALID_FILTER_VALUE");
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

function fmt(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function addDays(d: string, n: number): string {
  const x = toUtc(d);
  x.setUTCDate(x.getUTCDate() + n);
  return fmt(x);
}

export function addMonths(d: string, n: number): string {
  const x = toUtc(d);
  const day = x.getUTCDate();
  x.setUTCDate(1);
  x.setUTCMonth(x.getUTCMonth() + n);
  const last = new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth() + 1, 0)).getUTCDate();
  x.setUTCDate(Math.min(day, last));
  return fmt(x);
}

export function isValidDateString(s: string): boolean {
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return fmt(d) === s && Number(m[1]) >= 1;
}

function intN(v: unknown, what: string): number {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  if (!Number.isInteger(n) || n < 0 || n > 100000) {
    throw new FilterError(`${what} requires a non-negative integer "n"`, "INVALID_FILTER_VALUE");
  }
  return n;
}

/**
 * Resolve a date operand to `"YYYY-MM-DD"`, or `null` when the operand is
 * incomplete (the condition is then ignored, like Airtable).
 */
export function resolveDateOperand(value: unknown, ctx: DateContext): string | null {
  if (value === undefined || value === null || value === "") return null;
  const tz = resolveTimeZone(ctx.timeZone);
  if (typeof value === "string") {
    if (DATE_RE.test(value)) {
      if (!isValidDateString(value)) throw new FilterError(`Invalid date: ${value}`, "INVALID_FILTER_VALUE");
      return value;
    }
    if (ISO_PREFIX_RE.test(value)) {
      const d = new Date(value);
      if (!Number.isNaN(d.getTime())) return dateInTimeZone(d, tz);
    }
    // Shorthand: a bare relative keyword.
    return resolveDateOperand({ relative: value }, ctx);
  }
  if (typeof value === "object" && !Array.isArray(value)) {
    const o = value as Record<string, unknown>;
    const rel = o["relative"] ?? o["mode"];
    const today = todayIn(ctx);
    switch (rel) {
      case "today":
        return today;
      case "tomorrow":
        return addDays(today, 1);
      case "yesterday":
        return addDays(today, -1);
      case "oneWeekAgo":
        return addDays(today, -7);
      case "oneWeekFromNow":
        return addDays(today, 7);
      case "oneMonthAgo":
        return addMonths(today, -1);
      case "oneMonthFromNow":
        return addMonths(today, 1);
      case "nDaysAgo":
      case "numberOfDaysAgo":
        if (o["n"] === undefined || o["n"] === null || o["n"] === "") return null;
        return addDays(today, -intN(o["n"], String(rel)));
      case "nDaysFromNow":
      case "numberOfDaysFromNow":
        if (o["n"] === undefined || o["n"] === null || o["n"] === "") return null;
        return addDays(today, intN(o["n"], String(rel)));
      case "exactDate": {
        const d = o["date"];
        if (d === undefined || d === null || d === "") return null;
        if (typeof d !== "string") throw new FilterError("exactDate requires a date string", "INVALID_FILTER_VALUE");
        return resolveDateOperand(d, ctx);
      }
      default:
        break;
    }
  }
  throw new FilterError(`Invalid date operand: ${JSON.stringify(value)}`, "INVALID_FILTER_VALUE");
}

/** Resolve an `isWithin` operand to an inclusive `[start, end]` date range, or null if incomplete. */
export function resolveWithinRange(value: unknown, ctx: DateContext): [string, string] | null {
  if (value === undefined || value === null || value === "") return null;
  const o: Record<string, unknown> =
    typeof value === "string" ? { range: value } : typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const range = o["range"];
  const today = todayIn(ctx);
  switch (range) {
    case "pastWeek":
      return [addDays(today, -7), today];
    case "pastMonth":
      return [addMonths(today, -1), today];
    case "pastYear":
      return [addMonths(today, -12), today];
    case "nextWeek":
      return [today, addDays(today, 7)];
    case "nextMonth":
      return [today, addMonths(today, 1)];
    case "nextYear":
      return [today, addMonths(today, 12)];
    case "thisWeek": {
      const dow = toUtc(today).getUTCDay(); // 0 = Sunday
      const start = addDays(today, -dow);
      return [start, addDays(start, 6)];
    }
    case "thisMonth": {
      const start = `${today.slice(0, 7)}-01`;
      return [start, addDays(addMonths(start, 1), -1)];
    }
    case "thisYear":
      return [`${today.slice(0, 4)}-01-01`, `${today.slice(0, 4)}-12-31`];
    case "pastNDays":
      if (o["n"] === undefined || o["n"] === null || o["n"] === "") return null;
      return [addDays(today, -intN(o["n"], "pastNDays")), today];
    case "nextNDays":
      if (o["n"] === undefined || o["n"] === null || o["n"] === "") return null;
      return [today, addDays(today, intN(o["n"], "nextNDays"))];
    default:
      throw new FilterError(`Invalid isWithin range: ${JSON.stringify(value)}`, "INVALID_FILTER_VALUE");
  }
}
