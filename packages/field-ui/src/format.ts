import type {
  AttachmentValue,
  FieldLike,
  LinkRef,
  SelectOption,
  UserRef,
} from "./types.js";

type Config = Record<string, unknown>;

export function cfg(field: { config?: Record<string, unknown> | null | undefined }): Config {
  return (field.config ?? {}) as Config;
}

export function selectOptions(field: FieldLike): SelectOption[] {
  const raw = cfg(field)["options"];
  return Array.isArray(raw) ? (raw as SelectOption[]) : [];
}

function precisionOf(config: Config, fallback: number | undefined): number | undefined {
  const p = config["precision"];
  return typeof p === "number" && p >= 0 && p <= 8 ? p : fallback;
}

export function formatNumber(n: number, precision: number | undefined): string {
  if (!Number.isFinite(n)) return "";
  if (precision === undefined) {
    return n.toLocaleString(undefined, { maximumFractionDigits: 8 });
  }
  return n.toLocaleString(undefined, {
    minimumFractionDigits: precision,
    maximumFractionDigits: precision,
  });
}

export function toNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Seconds → "h:mm" or "h:mm:ss". */
export function formatDuration(seconds: number, format: string = "h:mm"): string {
  const neg = seconds < 0;
  let s = Math.round(Math.abs(seconds));
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return `${neg ? "-" : ""}${h}:${mm}${format === "h:mm:ss" ? `:${ss}` : ""}`;
}

/** "1:30", "1:30:15", "90" (minutes), "1.5h" → seconds. */
export function parseDuration(text: string): number | null {
  const t = text.trim();
  if (!t) return null;
  const parts = t.split(":");
  if (parts.length >= 2 && parts.length <= 3 && parts.every((p) => /^\d+(\.\d+)?$/.test(p))) {
    const [h, m, s] = parts.map(Number) as [number, number, number?];
    return h * 3600 + m * 60 + (s ?? 0);
  }
  const hMatch = /^(\d+(?:\.\d+)?)\s*h$/i.exec(t);
  if (hMatch) return Math.round(Number(hMatch[1]) * 3600);
  if (/^\d+(\.\d+)?$/.test(t)) return Math.round(Number(t) * 60);
  return null;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** Format a "YYYY-MM-DD" date string per config.format. */
export function formatDate(value: string, format: unknown): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!m) return value;
  const [, y, mo, d] = m as unknown as [string, string, string, string];
  switch (format) {
    case "iso":
      return `${y}-${mo}-${d}`;
    case "us":
      return `${Number(mo)}/${Number(d)}/${y}`;
    case "eu":
      return `${Number(d)}/${Number(mo)}/${y}`;
    default: {
      const dt = new Date(Number(y), Number(mo) - 1, Number(d));
      return dt.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
    }
  }
}

export function formatDateTime(value: string, config: Config): string {
  const dt = new Date(value);
  if (Number.isNaN(dt.getTime())) return value;
  const tz = typeof config["timeZone"] === "string" ? (config["timeZone"] as string) : undefined;
  const hour12 = config["timeFormat"] !== "24h";
  const datePart =
    config["format"] && config["format"] !== "local"
      ? formatDate(
          `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`,
          config["format"],
        )
      : dt.toLocaleDateString(undefined, {
          year: "numeric",
          month: "short",
          day: "numeric",
          ...(tz ? { timeZone: tz } : {}),
        });
  const timePart = dt.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
    hour12,
    ...(tz ? { timeZone: tz } : {}),
  });
  return `${datePart} ${timePart}`;
}

/** ISO → value for <input type="datetime-local">. */
export function isoToLocalInput(iso: string): string {
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return "";
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}T${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
}

export function localInputToIso(local: string): string | null {
  if (!local) return null;
  const dt = new Date(local);
  return Number.isNaN(dt.getTime()) ? null : dt.toISOString();
}

export function userLabel(u: UserRef): string {
  return u.name || u.email || u.id;
}

export function asArray<T>(value: unknown): T[] {
  if (value === null || value === undefined) return [];
  return (Array.isArray(value) ? value : [value]) as T[];
}

function scalarText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "boolean") return v ? "checked" : "";
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o["name"] === "string") return o["name"] as string;
    if (typeof o["filename"] === "string") return o["filename"] as string;
    if (typeof o["text"] === "string") return o["text"] as string;
    if (typeof o["label"] === "string") return o["label"] as string;
    return JSON.stringify(v);
  }
  return String(v);
}

/** Plain-text representation of a cell (copy, search, CSV, kanban titles). */
export function cellValueToText(field: FieldLike, value: unknown): string {
  if (value === null || value === undefined) return "";
  const config = cfg(field);
  switch (field.type) {
    case "number":
    case "rating":
    case "autonumber":
    case "count": {
      const n = toNumber(value);
      return n === null ? scalarText(value) : formatNumber(n, precisionOf(config, undefined)).replace(/,/g, "");
    }
    case "currency": {
      const n = toNumber(value);
      if (n === null) return scalarText(value);
      const sym = typeof config["symbol"] === "string" ? (config["symbol"] as string) : "$";
      return `${sym}${n.toFixed(precisionOf(config, 2) ?? 2)}`;
    }
    case "percent": {
      const n = toNumber(value);
      if (n === null) return scalarText(value);
      return `${(n * 100).toFixed(precisionOf(config, 0) ?? 0)}%`;
    }
    case "duration": {
      const n = toNumber(value);
      return n === null ? scalarText(value) : formatDuration(n, config["format"] as string | undefined);
    }
    case "checkbox":
      return value === true ? "checked" : "";
    case "date":
      return typeof value === "string" ? formatDate(value, config["format"] ?? "iso") : scalarText(value);
    case "datetime":
    case "created_time":
    case "modified_time":
      return typeof value === "string" ? formatDateTime(value, config) : scalarText(value);
    case "single_select": {
      const opt = selectOptions(field).find((o) => o.id === value);
      return opt ? opt.label : scalarText(value);
    }
    case "multi_select": {
      const opts = selectOptions(field);
      return asArray<string>(value)
        .map((id) => opts.find((o) => o.id === id)?.label ?? id)
        .join(", ");
    }
    case "collaborator":
    case "contact":
    case "created_by":
    case "modified_by":
      return asArray<UserRef | string>(value)
        .map((u) => (typeof u === "string" ? u : userLabel(u)))
        .join(", ");
    case "attachment":
      return asArray<AttachmentValue>(value)
        .map((a) => (a.url ? `${a.filename} (${a.url})` : a.filename))
        .join(", ");
    case "link":
      return asArray<LinkRef | string>(value)
        .map((l) => (typeof l === "string" ? l : l.name || l.id))
        .join(", ");
    case "lookup":
      return asArray<unknown>(value).map(scalarText).join(", ");
    case "barcode":
      return scalarText(value);
    case "json":
      return typeof value === "string" ? value : JSON.stringify(value);
    default:
      if (Array.isArray(value)) return value.map(scalarText).join(", ");
      return scalarText(value);
  }
}

/** Display string (formatted) — legacy API kept for older callers. */
export function formatCellDisplay(
  type: string,
  value: unknown,
  config: Record<string, unknown> = {},
): string {
  return cellValueToText({ id: "", name: "", type, config }, value);
}

/**
 * Convert pasted / typed text to a cell value for a field (client-side
 * typecast). Returns `undefined` when the text cannot be converted and the
 * caller should send the raw text with `typecast: true`.
 */
export function parseTextToValue(field: FieldLike, text: string): unknown {
  const t = text.trim();
  const config = cfg(field);
  if (t === "") return null;
  switch (field.type) {
    case "number":
    case "rating": {
      const n = Number(t.replace(/[,\s]/g, ""));
      if (!Number.isFinite(n)) return undefined;
      if (field.type === "rating") {
        const max = typeof config["max"] === "number" ? (config["max"] as number) : 5;
        return Math.max(0, Math.min(max, Math.round(n))) || null;
      }
      return n;
    }
    case "currency": {
      const n = Number(t.replace(/[^0-9.\-]/g, ""));
      return Number.isFinite(n) && /\d/.test(t) ? n : undefined;
    }
    case "percent": {
      const hasPct = t.endsWith("%");
      const n = Number(t.replace(/[%,\s]/g, ""));
      if (!Number.isFinite(n)) return undefined;
      return hasPct || Math.abs(n) > 1 ? n / 100 : n;
    }
    case "duration":
      return parseDuration(t) ?? undefined;
    case "checkbox":
      return /^(true|yes|y|1|checked|x|✓|☑)$/i.test(t) ? true : null;
    case "date": {
      if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
      const dt = new Date(t);
      if (Number.isNaN(dt.getTime())) return undefined;
      return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
    }
    case "datetime": {
      const dt = new Date(t);
      return Number.isNaN(dt.getTime()) ? undefined : dt.toISOString();
    }
    case "single_select": {
      const opt = selectOptions(field).find(
        (o) => o.label.toLowerCase() === t.toLowerCase() || o.id === t,
      );
      return opt ? opt.id : undefined;
    }
    case "multi_select": {
      const opts = selectOptions(field);
      const ids: string[] = [];
      for (const part of t.split(",").map((s) => s.trim()).filter(Boolean)) {
        const opt = opts.find((o) => o.label.toLowerCase() === part.toLowerCase() || o.id === part);
        if (!opt) return undefined;
        ids.push(opt.id);
      }
      return ids;
    }
    case "barcode":
      return { text: t };
    case "json":
      try {
        return JSON.parse(t);
      } catch {
        return undefined;
      }
    case "text":
    case "long_text":
    case "email":
    case "url":
    case "phone":
      return text;
    default:
      return undefined;
  }
}

/** True when a value counts as empty (absent in the wire format). */
export function isEmptyValue(value: unknown): boolean {
  return (
    value === null ||
    value === undefined ||
    value === "" ||
    value === false ||
    (Array.isArray(value) && value.length === 0)
  );
}

/**
 * Convert a rich (output-shaped) value to the input shape the API accepts:
 * attachments/links/collaborators → id arrays; checkbox false → false.
 */
export function toInputValue(field: FieldLike, value: unknown): unknown {
  if (value === undefined) return null;
  switch (field.type) {
    case "attachment":
    case "link":
    case "collaborator":
    case "contact":
      return asArray<unknown>(value).map((v) =>
        typeof v === "object" && v !== null ? (v as { id: string }).id : v,
      );
    case "checkbox":
      return value === true;
    default:
      return value;
  }
}
