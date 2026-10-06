import type { CellsRecord } from "@tabula/fields";
import type { FormulaAst, FormulaValue } from "./ast.js";

export interface FormulaContext {
  /** Field name (as in `{Name}`) → slot string. */
  fieldNameToSlot: Record<string, string>;
  cells: CellsRecord;
  /** Current record id (for RECORD_ID). */
  recordId?: string;
  /** Clock override for tests (TODAY/NOW). */
  now?: Date;
}

function isBlankValue(v: FormulaValue | undefined): boolean {
  return v === null || v === undefined || v === "";
}

function toNumber(v: FormulaValue | undefined): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string" && v !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function toString(v: FormulaValue | undefined): string {
  if (v === null || v === undefined) return "";
  return String(v);
}

function toBool(v: FormulaValue | undefined): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") return v.length > 0;
  return false;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function formatDate(d: Date, pattern: string): string {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  const h = d.getUTCHours();
  const min = d.getUTCMinutes();
  const s = d.getUTCSeconds();
  return pattern
    .replace(/YYYY/g, String(y))
    .replace(/MM/g, pad2(m))
    .replace(/DD/g, pad2(day))
    .replace(/HH/g, pad2(h))
    .replace(/mm/g, pad2(min))
    .replace(/ss/g, pad2(s));
}

function parseDateInput(raw: string): Date | null {
  const t = Date.parse(raw);
  if (Number.isNaN(t)) return null;
  return new Date(t);
}

function evalAst(ast: FormulaAst, ctx: FormulaContext): FormulaValue {
  switch (ast.kind) {
    case "number":
      return ast.value;
    case "string":
      return ast.value;
    case "boolean":
      return ast.value;
    case "blank":
      return null;
    case "field": {
      const slot = ctx.fieldNameToSlot[ast.name];
      if (slot === undefined) return null;
      const raw = ctx.cells[slot];
      if (raw === undefined) return null;
      return raw as FormulaValue;
    }
    case "unary":
      if (ast.op === "not") return !toBool(evalAst(ast.expr, ctx));
      return -toNumber(evalAst(ast.expr, ctx));
    case "binary": {
      const l = evalAst(ast.left, ctx);
      const r = evalAst(ast.right, ctx);
      switch (ast.op) {
        case "&":
          return toString(l) + toString(r);
        case "+":
          return toNumber(l) + toNumber(r);
        case "-":
          return toNumber(l) - toNumber(r);
        case "*":
          return toNumber(l) * toNumber(r);
        case "/": {
          const denom = toNumber(r);
          return denom === 0 ? null : toNumber(l) / denom;
        }
        default:
          return null;
      }
    }
    case "call":
      return evalCall(ast.name, ast.args, ctx);
    default:
      return null;
  }
}

function evalCall(name: string, args: FormulaAst[], ctx: FormulaContext): FormulaValue {
  const upper = name.toUpperCase();
  const values = args.map((a) => evalAst(a, ctx));
  const now = ctx.now ?? new Date();

  const str0 = toString(values[0]);
  const str1 = toString(values[1]);

  switch (upper) {
    case "CONCATENATE":
      return values.map((v) => toString(v)).join("");
    case "LEFT": {
      const len = Math.max(0, Math.floor(toNumber(values[1])));
      return str0.slice(0, len);
    }
    case "RIGHT": {
      const len = Math.max(0, Math.floor(toNumber(values[1])));
      return str0.slice(-len);
    }
    case "LEN":
      return toString(values[0]).length;
    case "LOWER":
      return str0.toLowerCase();
    case "UPPER":
      return str0.toUpperCase();
    case "TRIM":
      return str0.trim();
    case "IF":
      return toBool(values[0]) ? (values[1] ?? null) : (values[2] ?? null);
    case "AND":
      return values.every((v) => toBool(v));
    case "OR":
      return values.some((v) => toBool(v));
    case "NOT":
      return !toBool(values[0]);
    case "BLANK":
      return null;
    case "TRUE":
      return true;
    case "FALSE":
      return false;
    case "ABS":
      return Math.abs(toNumber(values[0]));
    case "ROUND": {
      const digits = values[1] !== undefined ? Math.floor(toNumber(values[1])) : 0;
      const f = 10 ** digits;
      return Math.round(toNumber(values[0]) * f) / f;
    }
    case "FLOOR":
      return Math.floor(toNumber(values[0]));
    case "CEILING":
      return Math.ceil(toNumber(values[0]));
    case "MIN":
      return values.length === 0 ? null : Math.min(...values.map((v) => toNumber(v)));
    case "MAX":
      return values.length === 0 ? null : Math.max(...values.map((v) => toNumber(v)));
    case "SUM": {
      let sum = 0;
      for (const v of values) sum += toNumber(v);
      return sum;
    }
    case "AVERAGE": {
      if (values.length === 0) return null;
      let sum = 0;
      for (const v of values) sum += toNumber(v);
      return sum / values.length;
    }
    case "VALUE":
      return toNumber(values[0]);
    case "T":
      return toString(values[0]);
    case "DATETIME_FORMAT": {
      const d = parseDateInput(str0);
      if (!d) return null;
      const pattern = str1 || "YYYY-MM-DD";
      return formatDate(d, pattern);
    }
    case "DATETIME_PARSE": {
      const d = parseDateInput(str0);
      return d ? d.toISOString() : null;
    }
    case "TODAY": {
      const d = new Date(now);
      return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
    }
    case "NOW":
      return now.toISOString();
    case "YEAR":
      return parseDateInput(str0)?.getUTCFullYear() ?? null;
    case "MONTH":
      return parseDateInput(str0) ? parseDateInput(str0)!.getUTCMonth() + 1 : null;
    case "DAY":
      return parseDateInput(str0)?.getUTCDate() ?? null;
    case "WEEKDAY": {
      const d = parseDateInput(str0);
      return d ? d.getUTCDay() : null;
    }
    case "SWITCH": {
      const expr = values[0];
      for (let i = 1; i + 1 < values.length; i += 2) {
        const when = values[i];
        if (when === expr || toString(when) === toString(expr)) {
          return values[i + 1] ?? null;
        }
      }
      return values.length >= 2 && values.length % 2 === 0
        ? (values[values.length - 1] ?? null)
        : null;
    }
    case "FIND": {
      const needle = str0;
      const haystack = str1;
      const start = values[2] !== undefined ? Math.max(0, Math.floor(toNumber(values[2])) - 1) : 0;
      const idx = haystack.indexOf(needle, start);
      return idx < 0 ? null : idx + 1;
    }
    case "SUBSTITUTE": {
      let out = str0;
      const search = str1;
      const replace = toString(values[2]);
      const max = values[3] !== undefined ? Math.max(0, Math.floor(toNumber(values[3]))) : undefined;
      if (max === 0) return out;
      let count = 0;
      while (search && out.includes(search)) {
        out = out.replace(search, replace);
        count++;
        if (max !== undefined && count >= max) break;
      }
      return out;
    }
    case "REPLACE": {
      const start = Math.max(1, Math.floor(toNumber(values[1])));
      const count = Math.max(0, Math.floor(toNumber(values[2])));
      const insert = toString(values[3]);
      const idx = start - 1;
      return str0.slice(0, idx) + insert + str0.slice(idx + count);
    }
    case "REPT": {
      const n = Math.max(0, Math.floor(toNumber(values[1])));
      return str0.repeat(n);
    }
    case "ISBLANK":
      return isBlankValue(values[0]);
    case "ERROR":
      return null;
    case "RECORD_ID":
      return ctx.recordId ?? null;
    default:
      return null;
  }
}

export function evaluateFormula(ast: FormulaAst, ctx: FormulaContext): FormulaValue {
  return evalAst(ast, ctx);
}

export { isBlankValue as isBlank };
