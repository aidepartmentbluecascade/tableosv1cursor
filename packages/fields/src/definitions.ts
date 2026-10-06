import type {
  FieldConfig,
  FieldTypeDefinition,
  FieldTypeKey,
  NormalizeContext,
  NormalizeResult,
  SelectOption,
  StoredValue,
} from "./types.js";
import {
  fieldValidationError,
  isEmptyRaw,
  newOptionId,
  optionColorAt,
  OPTION_COLOR_NAMES,
  toRawId,
} from "./utils.js";

const absent = (): NormalizeResult => ({});

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

function cfgInt(
  input: Record<string, unknown>,
  key: string,
  def: number,
  min: number,
  max: number,
): number {
  const v = input[key];
  if (v === undefined || v === null) return def;
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isInteger(n) || n < min || n > max) {
    fieldValidationError(`config.${key} must be an integer between ${min} and ${max}`);
  }
  return n;
}

function cfgEnum<T extends string>(
  input: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
  def: T,
): T {
  const v = input[key];
  if (v === undefined || v === null) return def;
  if (typeof v !== "string" || !allowed.includes(v as T)) {
    fieldValidationError(`config.${key} must be one of ${allowed.join(", ")}`);
  }
  return v as T;
}

function cfgBool(input: Record<string, unknown>, key: string, def: boolean): boolean {
  const v = input[key];
  if (v === undefined || v === null) return def;
  if (typeof v !== "boolean") fieldValidationError(`config.${key} must be a boolean`);
  return v;
}

function cfgString(
  input: Record<string, unknown>,
  key: string,
  def: string | undefined,
  maxLen = 1000,
): string | undefined {
  const v = input[key];
  if (v === undefined || v === null) return def;
  if (typeof v !== "string" || v.length > maxLen) {
    fieldValidationError(`config.${key} must be a string`);
  }
  return v;
}

function cfgRequiredId(input: Record<string, unknown>, key: string, ...aliases: string[]): string {
  for (const k of [key, ...aliases]) {
    const v = input[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return fieldValidationError(`config.${key} is required`);
}

export function normalizeSelectOptions(raw: unknown): SelectOption[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) fieldValidationError("config.options must be an array");
  const out: SelectOption[] = [];
  const seenIds = new Set<string>();
  const seenLabels = new Set<string>();
  raw.forEach((item, i) => {
    let label: string;
    let id: string | undefined;
    let color: string | undefined;
    if (typeof item === "string") {
      label = item;
    } else if (item && typeof item === "object") {
      const o = item as Record<string, unknown>;
      const l = o["label"] ?? o["name"];
      if (typeof l !== "string") fieldValidationError("Select option label must be a string");
      label = l;
      if (typeof o["id"] === "string" && o["id"].length > 0) id = o["id"];
      if (typeof o["color"] === "string" && o["color"].length > 0) color = o["color"];
    } else {
      return fieldValidationError("Select option must be an object or string");
    }
    label = label.trim();
    if (label.length === 0) fieldValidationError("Select option label cannot be empty");
    if (label.length > 255) fieldValidationError("Select option label is too long");
    const lk = label.toLowerCase();
    if (seenLabels.has(lk)) fieldValidationError(`Duplicate select option "${label}"`);
    seenLabels.add(lk);
    if (!id || seenIds.has(id)) id = newOptionId();
    seenIds.add(id);
    out.push({ id, label, color: color ?? optionColorAt(i) });
  });
  return out;
}

// ---------------------------------------------------------------------------
// Value helpers
// ---------------------------------------------------------------------------

function asString(raw: unknown, maxLen: number, label: string, typecast = false): string {
  let s: string;
  if (typeof raw === "string") s = raw;
  else if (typeof raw === "number" || typeof raw === "boolean") s = String(raw);
  else if (typecast && Array.isArray(raw)) s = raw.map((x) => plainText(x)).join(", ");
  else if (typecast && raw && typeof raw === "object") s = plainText(raw);
  else return fieldValidationError(`${label} must be a string`);
  if (s.length > maxLen) fieldValidationError(`${label} exceeds max length ${maxLen}`);
  return s;
}

function plainText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return v.map(plainText).join(", ");
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    for (const k of ["name", "label", "text", "filename", "email", "id"]) {
      if (typeof o[k] === "string") return o[k] as string;
    }
    return JSON.stringify(v);
  }
  return String(v);
}

/** Parse a number from numbers or numeric strings ("1,234.5", "$12", "50%"). */
export function parseNumberLoose(raw: unknown, opts: { percent?: boolean } = {}): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw === "boolean") return raw ? 1 : 0;
  if (typeof raw !== "string") return null;
  let s = raw.trim();
  if (s === "") return null;
  let pct = false;
  if (s.endsWith("%")) {
    pct = true;
    s = s.slice(0, -1);
  }
  let neg = false;
  if (/^\(.*\)$/.test(s)) {
    neg = true;
    s = s.slice(1, -1);
  }
  s = s.replace(/[\s,]/g, "").replace(/^[^\d+\-.]+/, "");
  if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(s)) return null;
  let n = Number(s);
  if (!Number.isFinite(n)) return null;
  if (neg) n = -n;
  if (pct && opts.percent) n = n / 100;
  return n;
}

function normalizeNumber(raw: unknown, label: string, opts: { percent?: boolean } = {}): NormalizeResult {
  if (isEmptyRaw(raw)) return absent();
  const n = parseNumberLoose(raw, opts);
  if (n === null) return fieldValidationError(`${label} must be a number`);
  return { value: n };
}

const pad2 = (n: number) => (n < 10 ? `0${n}` : String(n));

function ymd(d: Date): string {
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

function isValidYmd(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** Parse many date spellings into "YYYY-MM-DD" (null if unparseable). */
export function parseDateLoose(raw: unknown): string | null {
  if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? null : ymd(raw);
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) return null;
    return ymd(new Date(raw));
  }
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    return isValidYmd(y, mo, d) ? `${y}-${pad2(mo)}-${pad2(d)}` : null;
  }
  m = /^(\d{4})-(\d{2})-(\d{2})[T ]/.exec(s);
  if (m) {
    const t = Date.parse(s);
    if (Number.isNaN(t)) return null;
    // Keep the calendar date as written when no offset/zone conversion is implied.
    return /[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? ymd(new Date(t)) : `${m[1]}-${m[2]}-${m[3]}`;
  }
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/.exec(s);
  if (m) {
    let y = Number(m[3]);
    if (y < 100) y += y >= 70 ? 1900 : 2000;
    const mo = Number(m[1]);
    const d = Number(m[2]);
    if (isValidYmd(y, mo, d)) return `${y}-${pad2(mo)}-${pad2(d)}`;
    // Fall back to D/M/Y when M/D/Y is impossible.
    if (isValidYmd(y, d, mo)) return `${y}-${pad2(d)}-${pad2(mo)}`;
    return null;
  }
  const t = Date.parse(s);
  if (Number.isNaN(t)) return null;
  return ymd(new Date(t));
}

/** Parse into ISO-8601 UTC datetime string (null if unparseable). */
export function parseDateTimeLoose(raw: unknown): string | null {
  if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? null : raw.toISOString();
  if (typeof raw === "number") return Number.isFinite(raw) ? new Date(raw).toISOString() : null;
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const d = parseDateLoose(s);
    return d ? `${d}T00:00:00.000Z` : null;
  }
  const t = Date.parse(s);
  if (!Number.isNaN(t)) return new Date(t).toISOString();
  const d = parseDateLoose(s);
  return d ? `${d}T00:00:00.000Z` : null;
}

/** Parse "h:mm", "h:mm:ss", "1.5" (hours? no: seconds) into seconds. */
export function parseDurationLoose(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (s === "") return null;
  const m = /^(-)?(\d+):(\d{1,2})(?::(\d{1,2}(?:\.\d+)?))?$/.exec(s);
  if (m) {
    const secs = Number(m[2]) * 3600 + Number(m[3]) * 60 + (m[4] ? Number(m[4]) : 0);
    return m[1] ? -secs : secs;
  }
  return parseNumberLoose(s);
}

export function formatDuration(seconds: number, format: string): string {
  const neg = seconds < 0;
  let s = Math.abs(seconds);
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  const body =
    format === "h:mm"
      ? `${h}:${pad2(m)}`
      : `${h}:${pad2(m)}:${pad2(Math.floor(s))}`;
  return (neg ? "-" : "") + body;
}

function parseBooleanLoose(raw: unknown): boolean {
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "number") return raw !== 0;
  if (typeof raw === "string") {
    return ["true", "yes", "y", "1", "checked", "x", "on", "✓", "✔"].includes(
      raw.trim().toLowerCase(),
    );
  }
  return false;
}

/** Turn input into a list of id-ish strings (accepts arrays, single, `{id}` objects). */
function idList(raw: unknown, label: string, splitStrings = false): string[] {
  const items: unknown[] = Array.isArray(raw) ? raw : [raw];
  const out: string[] = [];
  for (const item of items) {
    if (item === null || item === undefined || item === "") continue;
    if (typeof item === "string") {
      if (splitStrings && item.includes(",")) {
        out.push(...item.split(",").map((s) => s.trim()).filter(Boolean));
      } else {
        out.push(item.trim());
      }
    } else if (typeof item === "object" && typeof (item as { id?: unknown }).id === "string") {
      out.push((item as { id: string }).id);
    } else {
      fieldValidationError(`${label} must be an id or array of ids`);
    }
  }
  return out;
}

function selectOptions(config: FieldConfig): Array<{ id: string; label: string; color?: string }> {
  return Array.isArray(config.options) ? config.options : [];
}

function resolveOption(item: string, config: FieldConfig, ctx: NormalizeContext | undefined): string {
  const opts = selectOptions(config);
  const byId = opts.find((o) => o.id === item);
  if (byId) return byId.id;
  const lk = item.trim().toLowerCase();
  const byLabel = opts.find((o) => o.label.toLowerCase() === lk);
  if (byLabel) return byLabel.id;
  if (ctx?.typecast && ctx.createOption && item.trim().length > 0) {
    return ctx.createOption(item.trim());
  }
  return fieldValidationError(`Unknown select option "${item}"`);
}

// ---------------------------------------------------------------------------
// Definition builder
// ---------------------------------------------------------------------------

interface DefSpec {
  key: FieldTypeKey;
  label: string;
  isComputed?: boolean;
  readOnly?: boolean;
  creatable?: boolean;
  config?: (input: Record<string, unknown>) => FieldConfig;
  normalize?: (raw: unknown, config: FieldConfig, ctx?: NormalizeContext) => NormalizeResult;
  format?: (value: unknown, config: FieldConfig) => string;
}

function def(spec: DefSpec): FieldTypeDefinition {
  const normalizeConfig = (input: Record<string, unknown>): FieldConfig =>
    spec.config ? spec.config(input ?? {}) : {};
  const normalize =
    spec.normalize ??
    ((raw: unknown) => {
      if (spec.readOnly) {
        if (raw === undefined) return absent();
        return fieldValidationError(`${spec.label} fields are read-only`);
      }
      return isEmptyRaw(raw) ? absent() : { value: raw as StoredValue };
    });
  return {
    key: spec.key,
    label: spec.label,
    ...(spec.isComputed ? { isComputed: true } : {}),
    ...(spec.readOnly ? { readOnly: true } : {}),
    creatable: spec.creatable ?? true,
    defaultConfig: () => normalizeConfig({}),
    normalizeConfig,
    normalize,
    validate(raw, config, ctx) {
      normalize(raw, config, ctx);
    },
    format: spec.format ?? ((value) => plainText(value)),
  };
}

const readOnlyNormalize =
  (label: string) =>
  (raw: unknown): NormalizeResult => {
    if (raw === undefined) return absent();
    return fieldValidationError(`${label} fields are computed and read-only`);
  };

const DATE_FORMATS = ["local", "iso", "us", "eu", "friendly"] as const;
const TIME_FORMATS = ["12h", "24h"] as const;

function dateConfig(input: Record<string, unknown>): FieldConfig {
  return { format: cfgEnum(input, "format", DATE_FORMATS, "local") };
}

function datetimeConfig(input: Record<string, unknown>): FieldConfig {
  const cfg: FieldConfig = {
    format: cfgEnum(input, "format", DATE_FORMATS, "local"),
    timeFormat: cfgEnum(input, "timeFormat", TIME_FORMATS, "12h"),
  };
  const tz = cfgString(input, "timeZone", undefined, 64);
  if (tz) cfg["timeZone"] = tz;
  return cfg;
}

function formatDateValue(value: unknown, config: FieldConfig): string {
  if (typeof value !== "string" || value === "") return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!m) return value;
  switch (config["format"]) {
    case "us":
      return `${Number(m[2])}/${Number(m[3])}/${m[1]}`;
    case "eu":
      return `${Number(m[3])}/${Number(m[2])}/${m[1]}`;
    default:
      return `${m[1]}-${m[2]}-${m[3]}`;
  }
}

function formatNumber(value: unknown, precision: number | undefined): string {
  if (typeof value !== "number") return value === undefined || value === null ? "" : String(value);
  if (precision === undefined) return String(value);
  return value.toLocaleString("en-US", {
    minimumFractionDigits: precision,
    maximumFractionDigits: precision,
  });
}

const RATING_ICONS = ["star", "heart", "check", "thumbs-up", "flag"] as const;
const ROLLUP_AGGS = [
  "sum",
  "avg",
  "min",
  "max",
  "count",
  "counta",
  "countall",
  "concat",
  "and",
  "or",
  "unique",
] as const;

function linkConfig(input: Record<string, unknown>): FieldConfig {
  const inv = input["inverseFieldId"];
  return {
    linkedTableId: cfgRequiredId(input, "linkedTableId"),
    inverseFieldId: typeof inv === "string" && inv.length > 0 ? inv : null,
    allowMultiple: cfgBool(input, "allowMultiple", true),
  };
}

function linkNormalize(raw: unknown, config: FieldConfig, ctx?: NormalizeContext): NormalizeResult {
  if (isEmptyRaw(raw)) return { value: [] };
  const ids = idList(raw, "Link", ctx?.typecast === true);
  const out: string[] = [];
  for (const id of ids) {
    const r = toRawId(id, "rec");
    if (!r) fieldValidationError(`Invalid linked record id "${id}"`);
    if (!out.includes(r)) out.push(r);
  }
  if (config["allowMultiple"] === false && out.length > 1) {
    if (ctx?.typecast) return { value: out.slice(0, 1) };
    fieldValidationError("This link field allows only one linked record");
  }
  return { value: out };
}

export const fieldDefinitions: FieldTypeDefinition[] = [
  def({
    key: "text",
    label: "Single line text",
    normalize(raw, _c, ctx) {
      if (isEmptyRaw(raw)) return absent();
      const s = asString(raw, 100_000, "Text", ctx?.typecast).replace(/[\r\n]+/g, " ").trim();
      return s ? { value: s } : absent();
    },
  }),
  def({
    key: "long_text",
    label: "Long text",
    config: (i) => ({ richText: cfgBool(i, "richText", false) }),
    normalize(raw, _c, ctx) {
      if (isEmptyRaw(raw)) return absent();
      const s = asString(raw, 100_000, "Long text", ctx?.typecast);
      return s.trim() ? { value: s } : absent();
    },
  }),
  def({
    key: "number",
    label: "Number",
    config: (i) => ({ precision: cfgInt(i, "precision", 0, 0, 8) }),
    normalize: (raw) => normalizeNumber(raw, "Number"),
    format: (v, c) => formatNumber(v, c.precision),
  }),
  def({
    key: "currency",
    label: "Currency",
    config: (i) => ({
      symbol: cfgString(i, "symbol", "$", 8),
      precision: cfgInt(i, "precision", 2, 0, 8),
    }),
    normalize: (raw) => normalizeNumber(raw, "Currency"),
    format(v, c) {
      if (typeof v !== "number") return "";
      const sym = typeof c["symbol"] === "string" ? c["symbol"] : "$";
      const s = formatNumber(Math.abs(v), c.precision);
      return v < 0 ? `-${sym}${s}` : `${sym}${s}`;
    },
  }),
  def({
    key: "percent",
    label: "Percent",
    config: (i) => ({ precision: cfgInt(i, "precision", 0, 0, 8) }),
    normalize: (raw) => normalizeNumber(raw, "Percent", { percent: true }),
    format: (v, c) => (typeof v === "number" ? `${formatNumber(v * 100, c.precision)}%` : ""),
  }),
  def({
    key: "duration",
    label: "Duration",
    config: (i) => ({
      format: cfgEnum(i, "format", ["h:mm", "h:mm:ss", "h:mm:ss.S"] as const, "h:mm"),
    }),
    normalize(raw) {
      if (isEmptyRaw(raw)) return absent();
      const n = parseDurationLoose(raw);
      if (n === null) return fieldValidationError("Duration must be a number of seconds or h:mm[:ss]");
      return { value: n };
    },
    format: (v, c) => (typeof v === "number" ? formatDuration(v, String(c["format"] ?? "h:mm")) : ""),
  }),
  def({
    key: "checkbox",
    label: "Checkbox",
    config: (i) => ({
      icon: cfgString(i, "icon", "check", 32),
      color: cfgString(i, "color", "green", 32),
    }),
    normalize(raw, _c, ctx) {
      if (raw === true) return { value: true };
      if (isEmptyRaw(raw) || raw === false) return absent();
      if (ctx?.typecast || typeof raw === "string" || typeof raw === "number") {
        return parseBooleanLoose(raw) ? { value: true } : absent();
      }
      return fieldValidationError("Checkbox must be true or false");
    },
    format: (v) => (v === true ? "checked" : ""),
  }),
  def({
    key: "date",
    label: "Date",
    config: dateConfig,
    normalize(raw) {
      if (isEmptyRaw(raw)) return absent();
      const d = parseDateLoose(raw);
      if (!d) return fieldValidationError("Date must be YYYY-MM-DD");
      return { value: d };
    },
    format: formatDateValue,
  }),
  def({
    key: "datetime",
    label: "Date and time",
    config: datetimeConfig,
    normalize(raw) {
      if (isEmptyRaw(raw)) return absent();
      const d = parseDateTimeLoose(raw);
      if (!d) return fieldValidationError("Datetime must be ISO-8601");
      return { value: d };
    },
    format(v, c) {
      if (typeof v !== "string") return "";
      const d = formatDateValue(v, c);
      const t = /T(\d{2}):(\d{2})/.exec(v);
      if (!t) return d;
      const h = Number(t[1]);
      if (c["timeFormat"] === "24h") return `${d} ${t[1]}:${t[2]}`;
      return `${d} ${h % 12 === 0 ? 12 : h % 12}:${t[2]}${h < 12 ? "am" : "pm"}`;
    },
  }),
  def({
    key: "single_select",
    label: "Single select",
    config: (i) => ({ options: normalizeSelectOptions(i["options"]) }),
    normalize(raw, config, ctx) {
      if (isEmptyRaw(raw)) return absent();
      let item = raw;
      if (Array.isArray(raw)) {
        if (raw.length === 0) return absent();
        if (raw.length > 1 && !ctx?.typecast) fieldValidationError("Single select takes one option");
        item = raw[0];
      }
      if (item && typeof item === "object") {
        const o = item as Record<string, unknown>;
        item = o["id"] ?? o["label"] ?? o["name"];
      }
      const s = asString(item, 255, "Select option", ctx?.typecast);
      if (s.trim() === "") return absent();
      return { value: resolveOption(s, config, ctx) };
    },
    format(v, c) {
      if (typeof v !== "string") return "";
      return selectOptions(c).find((o) => o.id === v)?.label ?? "";
    },
  }),
  def({
    key: "multi_select",
    label: "Multiple select",
    config: (i) => ({ options: normalizeSelectOptions(i["options"]) }),
    normalize(raw, config, ctx) {
      if (isEmptyRaw(raw)) return absent();
      const items: unknown[] = Array.isArray(raw)
        ? raw
        : typeof raw === "string" && ctx?.typecast
          ? raw.split(",")
          : [raw];
      const out: string[] = [];
      for (let item of items) {
        if (item && typeof item === "object") {
          const o = item as Record<string, unknown>;
          item = o["id"] ?? o["label"] ?? o["name"];
        }
        const s = asString(item, 255, "Select option", ctx?.typecast).trim();
        if (!s) continue;
        const id = resolveOption(s, config, ctx);
        if (!out.includes(id)) out.push(id);
      }
      return out.length ? { value: out } : absent();
    },
    format(v, c) {
      if (!Array.isArray(v)) return "";
      const opts = selectOptions(c);
      return v
        .map((id) => opts.find((o) => o.id === id)?.label)
        .filter((l): l is string => !!l)
        .join(", ");
    },
  }),
  def({
    key: "email",
    label: "Email",
    normalize(raw, _c, ctx) {
      if (isEmptyRaw(raw)) return absent();
      const s = asString(raw, 320, "Email", ctx?.typecast).trim();
      if (!s) return absent();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) fieldValidationError("Invalid email address");
      return { value: s };
    },
  }),
  def({
    key: "url",
    label: "URL",
    normalize(raw, _c, ctx) {
      if (isEmptyRaw(raw)) return absent();
      const s = asString(raw, 2048, "URL", ctx?.typecast).trim();
      if (!s) return absent();
      if (/\s/.test(s)) fieldValidationError("URL cannot contain spaces");
      return { value: s };
    },
  }),
  def({
    key: "phone",
    label: "Phone number",
    normalize(raw, _c, ctx) {
      if (isEmptyRaw(raw)) return absent();
      const s = asString(raw, 64, "Phone", ctx?.typecast).trim();
      if (!s) return absent();
      if (!/^[0-9+().\-\s/xext#*]+$/i.test(s)) fieldValidationError("Invalid phone number");
      return { value: s };
    },
  }),
  def({
    key: "rating",
    label: "Rating",
    config: (i) => ({
      max: cfgInt(i, "max", 5, 1, 10),
      icon: cfgEnum(i, "icon", RATING_ICONS, "star"),
      color: cfgString(i, "color", "yellow", 32),
    }),
    normalize(raw, config, ctx) {
      if (isEmptyRaw(raw)) return absent();
      let n = parseNumberLoose(raw);
      if (n === null) return fieldValidationError("Rating must be a whole number");
      const max = typeof config.max === "number" ? config.max : 5;
      if (ctx?.typecast) n = Math.min(max, Math.max(0, Math.round(n)));
      if (!Number.isInteger(n) || n < 0 || n > max) {
        fieldValidationError(`Rating must be a whole number between 0 and ${max}`);
      }
      return n === 0 ? absent() : { value: n };
    },
    format: (v) => (typeof v === "number" ? "★".repeat(v) : ""),
  }),
  def({
    key: "collaborator",
    label: "User",
    config: (i) => ({
      allowMultiple: cfgBool(i, "allowMultiple", false),
      notify: cfgBool(i, "notify", true),
    }),
    normalize(raw, config, ctx) {
      if (isEmptyRaw(raw)) return absent();
      const ids = idList(raw, "Collaborator");
      const out: string[] = [];
      for (const id of ids) {
        const r = toRawId(id, "usr");
        if (!r) fieldValidationError(`Invalid user id "${id}"`);
        if (!out.includes(r)) out.push(r);
      }
      if (out.length === 0) return absent();
      if (config["allowMultiple"] === false && out.length > 1) {
        if (!ctx?.typecast) fieldValidationError("This user field allows only one user");
        return { value: out.slice(0, 1) };
      }
      return { value: out };
    },
  }),
  def({
    key: "attachment",
    label: "Attachment",
    normalize(raw) {
      if (isEmptyRaw(raw)) return absent();
      const ids = idList(raw, "Attachment");
      const out: string[] = [];
      for (const id of ids) {
        const r = toRawId(id, "att");
        if (!r) fieldValidationError(`Invalid attachment id "${id}"`);
        if (!out.includes(r)) out.push(r);
      }
      return out.length ? { value: out } : absent();
    },
    format: (v) => (Array.isArray(v) ? `${v.length} attachment${v.length === 1 ? "" : "s"}` : ""),
  }),
  def({
    key: "barcode",
    label: "Barcode",
    normalize(raw, _c, ctx) {
      if (isEmptyRaw(raw)) return absent();
      let text: unknown = raw;
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        text = (raw as Record<string, unknown>)["text"];
      }
      const s = asString(text, 1000, "Barcode", ctx?.typecast).trim();
      return s ? { value: { text: s } } : absent();
    },
    format: (v) =>
      v && typeof v === "object" && typeof (v as { text?: unknown }).text === "string"
        ? (v as { text: string }).text
        : "",
  }),
  def({
    key: "button",
    label: "Button",
    readOnly: true,
    config(i) {
      const label = cfgString(i, "label", "Open", 255) ?? "Open";
      const style = cfgString(i, "style", "primary", 32);
      const rawAction = i["action"];
      let action: Record<string, unknown> = { type: "open_url", url: "" };
      if (rawAction !== undefined && rawAction !== null) {
        if (typeof rawAction !== "object") fieldValidationError("config.action must be an object");
        const a = rawAction as Record<string, unknown>;
        if (a["type"] === "open_url") {
          action = { type: "open_url", url: typeof a["url"] === "string" ? a["url"] : "" };
        } else if (a["type"] === "run_automation") {
          if (typeof a["automationId"] !== "string") {
            fieldValidationError("config.action.automationId is required");
          }
          action = { type: "run_automation", automationId: a["automationId"] };
        } else {
          fieldValidationError("config.action.type must be open_url or run_automation");
        }
      }
      return { label, style, action };
    },
    normalize: readOnlyNormalize("Button"),
    format: () => "",
  }),
  def({
    key: "json",
    label: "JSON",
    normalize(raw, _c, ctx) {
      if (raw === undefined || raw === null) return absent();
      if (typeof raw === "string" && ctx?.typecast) {
        try {
          return { value: JSON.parse(raw) as StoredValue };
        } catch {
          return { value: raw };
        }
      }
      return { value: raw as StoredValue };
    },
    format: (v) => (v === undefined ? "" : JSON.stringify(v)),
  }),
  def({
    key: "link",
    label: "Link to another record",
    config: linkConfig,
    normalize: linkNormalize,
    format: (v) => (Array.isArray(v) ? v.map(plainText).join(", ") : ""),
  }),
  def({
    key: "contact",
    label: "Contact",
    config: linkConfig,
    normalize: linkNormalize,
    format: (v) => (Array.isArray(v) ? v.map(plainText).join(", ") : ""),
  }),
  def({
    key: "formula",
    label: "Formula",
    isComputed: true,
    readOnly: true,
    config(i) {
      const expr = cfgString(i, "expression", undefined, 20_000) ?? cfgString(i, "formula", "", 20_000);
      const cfg: FieldConfig = { expression: expr ?? "" };
      const rt = i["resultType"];
      if (rt !== undefined && rt !== null) {
        cfg["resultType"] = cfgEnum(i, "resultType", ["number", "text", "date", "boolean"] as const, "text");
      }
      for (const k of ["precision", "format", "timeFormat", "symbol"]) {
        if (i[k] !== undefined) cfg[k] = i[k];
      }
      return cfg;
    },
    normalize: readOnlyNormalize("Formula"),
  }),
  def({
    key: "lookup",
    label: "Lookup",
    isComputed: true,
    readOnly: true,
    config: (i) => ({
      linkFieldId: cfgRequiredId(i, "linkFieldId"),
      targetFieldId: cfgRequiredId(i, "targetFieldId", "lookupFieldId"),
    }),
    normalize: readOnlyNormalize("Lookup"),
  }),
  def({
    key: "rollup",
    label: "Rollup",
    isComputed: true,
    readOnly: true,
    config(i) {
      const agg = i["aggregation"] ?? i["function"];
      const alias: Record<string, string> = { average: "avg", mean: "avg", arrayjoin: "concat", arrayunique: "unique" };
      const a = typeof agg === "string" ? (alias[agg.toLowerCase()] ?? agg.toLowerCase()) : undefined;
      const cfg: FieldConfig = {
        linkFieldId: cfgRequiredId(i, "linkFieldId"),
        targetFieldId: cfgRequiredId(i, "targetFieldId", "rollupFieldId"),
        aggregation: cfgEnum({ aggregation: a }, "aggregation", ROLLUP_AGGS, "sum"),
      };
      if (i["precision"] !== undefined) cfg.precision = cfgInt(i, "precision", 0, 0, 8);
      return cfg;
    },
    normalize: readOnlyNormalize("Rollup"),
  }),
  def({
    key: "count",
    label: "Count",
    isComputed: true,
    readOnly: true,
    config: (i) => ({ linkFieldId: cfgRequiredId(i, "linkFieldId") }),
    normalize: readOnlyNormalize("Count"),
  }),
  def({
    key: "autonumber",
    label: "Autonumber",
    readOnly: true,
    normalize: readOnlyNormalize("Autonumber"),
  }),
  def({
    key: "created_time",
    label: "Created time",
    readOnly: true,
    config: datetimeConfig,
    normalize: readOnlyNormalize("Created time"),
  }),
  def({
    key: "modified_time",
    label: "Last modified time",
    readOnly: true,
    config: datetimeConfig,
    normalize: readOnlyNormalize("Last modified time"),
  }),
  def({
    key: "created_by",
    label: "Created by",
    readOnly: true,
    normalize: readOnlyNormalize("Created by"),
  }),
  def({
    key: "modified_by",
    label: "Last modified by",
    readOnly: true,
    normalize: readOnlyNormalize("Last modified by"),
  }),
  def({
    key: "ai_generated",
    label: "AI",
    isComputed: true,
    readOnly: true,
    creatable: false,
    normalize: readOnlyNormalize("AI"),
  }),
];

export { OPTION_COLOR_NAMES, plainText };
