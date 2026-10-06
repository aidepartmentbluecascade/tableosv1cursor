import type { ReactNode } from "react";
import {
  asArray,
  cellValueToText,
  cfg,
  formatDate,
  formatDateTime,
  formatDuration,
  formatNumber,
  selectOptions,
  toNumber,
  userLabel,
} from "./format.js";
import { optionColor } from "./metadata.js";
import { ensureFieldUiStyles } from "./styles.js";
import type { AttachmentValue, FieldLike, LinkRef, UserRef } from "./types.js";

export interface RenderCellOptions {
  /** Formula/compute error for this cell (`record.errors[fieldId]`). */
  error?: string | null | undefined;
  /** Whole record, used by buttons to template URLs (`{Field Name}`). */
  record?: { id?: string; fields: Record<string, unknown> } | undefined;
  /** All fields of the table (button URL templating, lookup formatting). */
  fields?: FieldLike[] | undefined;
  /** Wrap pills/text onto multiple lines (tall rows, drawer). */
  wrap?: boolean | undefined;
}

export function initials(u: UserRef): string {
  const label = userLabel(u).trim();
  const parts = label.split(/[\s@._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? "")).toUpperCase();
}

export function OptionPill({ label, color }: { label: string; color?: string | undefined }) {
  const c = optionColor(color);
  return (
    <span className="tfu-pill" style={{ background: c.bg, color: c.fg }} title={label}>
      {label}
    </span>
  );
}

export function UserChip({ user }: { user: UserRef }) {
  return (
    <span className="tfu-user" title={user.email ?? userLabel(user)}>
      <span className="tfu-avatar">{initials(user)}</span>
      {userLabel(user)}
    </span>
  );
}

export function CheckboxGlyph({ checked }: { checked: boolean }) {
  return (
    <span className={`tfu-check ${checked ? "on" : "off"}`} data-tfu-checkbox="1" role="checkbox" aria-checked={checked}>
      {checked ? (
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
          <path d="M2.5 6.2 5 8.6l4.6-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : null}
    </span>
  );
}

export function RatingGlyph({ value, max, icon }: { value: number; max: number; icon?: string | undefined }) {
  const ch = icon === "heart" ? "♥" : icon === "check" ? "✔" : "★";
  return (
    <span className="tfu-stars">
      {Array.from({ length: max }, (_, i) => (
        <span key={i} className={`tfu-star ${i < value ? "on" : ""}`} data-tfu-rating={i + 1}>
          {ch}
        </span>
      ))}
    </span>
  );
}

function extOf(a: AttachmentValue): string {
  const m = /\.([a-z0-9]{1,5})$/i.exec(a.filename);
  return m ? m[1]! : (a.mime?.split("/")[1] ?? "file").slice(0, 4);
}

export function AttachmentThumb({ a }: { a: AttachmentValue }) {
  const isImage = (a.mime ?? "").startsWith("image/") || /\.(png|jpe?g|gif|webp|svg)$/i.test(a.filename);
  const src = a.thumbnailUrl ?? (isImage ? a.url : null);
  if (src) return <img className="tfu-thumb" src={src} alt={a.filename} title={a.filename} loading="lazy" />;
  return (
    <span className="tfu-file" title={a.filename}>
      {extOf(a)}
    </span>
  );
}

function safeHref(url: string): string {
  if (/^(https?:|mailto:|tel:)/i.test(url)) return url;
  return `https://${url}`;
}

/** Replace `{Field Name}` in a template with record values. */
export function templateWithRecord(
  template: string,
  record: RenderCellOptions["record"],
  fields: FieldLike[] | undefined,
): string {
  if (!record || !fields) return template;
  return template.replace(/\{([^}]+)\}/g, (_, name: string) => {
    const f = fields.find((x) => x.name === name || x.id === name);
    if (!f) return "";
    return encodeURIComponent(cellValueToText(f, record.fields[f.id]));
  });
}

function stop(e: { stopPropagation(): void }) {
  e.stopPropagation();
}

/** Read-only rendering of a cell value for any field type. */
export function renderCellValue(
  field: FieldLike,
  value: unknown,
  opts: RenderCellOptions = {},
): ReactNode {
  ensureFieldUiStyles();
  const config = cfg(field);
  if (opts.error) {
    return (
      <span className="tfu-error" title={opts.error}>
        {opts.error.startsWith("#") ? opts.error : `#ERROR ${opts.error}`}
      </span>
    );
  }
  if (field.type === "button") {
    const label = typeof config["label"] === "string" && config["label"] ? (config["label"] as string) : field.name;
    const action = (config["action"] ?? {}) as { type?: string; url?: string };
    const url = action.type === "open_url" && action.url ? templateWithRecord(action.url, opts.record, opts.fields) : null;
    return (
      <button
        type="button"
        className={`tfu-btn ${config["style"] === "primary" ? "tfu-btn-primary" : ""}`}
        disabled={!url}
        title={url ?? "No URL configured"}
        onMouseDown={stop}
        onClick={(e) => {
          e.stopPropagation();
          if (url) window.open(safeHref(url), "_blank", "noopener,noreferrer");
        }}
      >
        {label}
      </button>
    );
  }
  if (field.type === "checkbox") return <CheckboxGlyph checked={value === true} />;
  if (field.type === "rating") {
    const max = typeof config["max"] === "number" ? (config["max"] as number) : 5;
    return <RatingGlyph value={toNumber(value) ?? 0} max={max} icon={config["icon"] as string | undefined} />;
  }
  if (value === null || value === undefined || value === "") return null;

  switch (field.type) {
    case "number":
    case "autonumber":
    case "count": {
      const n = toNumber(value);
      const p = typeof config["precision"] === "number" ? (config["precision"] as number) : undefined;
      return <span className="tfu-num">{n === null ? String(value) : formatNumber(n, field.type === "number" ? p : 0)}</span>;
    }
    case "currency": {
      const n = toNumber(value);
      const sym = typeof config["symbol"] === "string" ? (config["symbol"] as string) : "$";
      const p = typeof config["precision"] === "number" ? (config["precision"] as number) : 2;
      return <span className="tfu-num">{n === null ? String(value) : `${n < 0 ? "-" : ""}${sym}${formatNumber(Math.abs(n), p)}`}</span>;
    }
    case "percent": {
      const n = toNumber(value);
      const p = typeof config["precision"] === "number" ? (config["precision"] as number) : 0;
      return <span className="tfu-num">{n === null ? String(value) : `${formatNumber(n * 100, p)}%`}</span>;
    }
    case "duration": {
      const n = toNumber(value);
      return <span className="tfu-num">{n === null ? String(value) : formatDuration(n, config["format"] as string | undefined)}</span>;
    }
    case "date":
      return typeof value === "string" ? formatDate(value, config["format"]) : String(value);
    case "datetime":
    case "created_time":
    case "modified_time":
      return typeof value === "string" ? formatDateTime(value, config) : String(value);
    case "single_select": {
      const opt = selectOptions(field).find((o) => o.id === value);
      return opt ? <OptionPill label={opt.label} color={opt.color} /> : <OptionPill label={String(value)} />;
    }
    case "multi_select": {
      const opts = selectOptions(field);
      return (
        <span className="tfu-pills">
          {asArray<string>(value).map((id) => {
            const opt = opts.find((o) => o.id === id);
            return <OptionPill key={id} label={opt?.label ?? id} color={opt?.color} />;
          })}
        </span>
      );
    }
    case "collaborator":
    case "contact":
    case "created_by":
    case "modified_by":
      return (
        <span className="tfu-pills">
          {asArray<UserRef | string>(value).map((u) => {
            const user = typeof u === "string" ? { id: u } : u;
            return <UserChip key={user.id} user={user} />;
          })}
        </span>
      );
    case "attachment":
      return (
        <span className="tfu-pills">
          {asArray<AttachmentValue>(value).map((a) => (
            <AttachmentThumb key={a.id} a={a} />
          ))}
        </span>
      );
    case "link":
      return (
        <span className="tfu-pills">
          {asArray<LinkRef | string>(value).map((l) => {
            const ref = typeof l === "string" ? { id: l } : l;
            return (
              <span key={ref.id} className="tfu-chip" title={ref.name ?? ref.id}>
                {ref.name || "Unnamed record"}
              </span>
            );
          })}
        </span>
      );
    case "lookup": {
      const items = asArray<unknown>(value);
      return (
        <span className="tfu-pills">
          {items.map((v, i) => (
            <span key={i} className="tfu-chip" style={{ background: "#eef2f7", color: "#334155" }}>
              {cellValueToText({ id: "", name: "", type: "unknown" }, v)}
            </span>
          ))}
        </span>
      );
    }
    case "email":
      return (
        <a className="tfu-link" href={`mailto:${String(value)}`} onMouseDown={stop} onClick={stop}>
          {String(value)}
        </a>
      );
    case "url":
      return (
        <a className="tfu-link" href={safeHref(String(value))} target="_blank" rel="noreferrer noopener" onMouseDown={stop} onClick={stop}>
          {String(value)}
        </a>
      );
    case "phone":
      return (
        <a className="tfu-link" href={`tel:${String(value).replace(/[^\d+]/g, "")}`} onMouseDown={stop} onClick={stop}>
          {String(value)}
        </a>
      );
    case "barcode":
      return <span style={{ fontFamily: "ui-monospace,monospace" }}>{cellValueToText(field, value)}</span>;
    case "formula":
    case "rollup": {
      if (typeof value === "boolean") return <CheckboxGlyph checked={value} />;
      if (typeof value === "number") {
        const p = typeof config["precision"] === "number" ? (config["precision"] as number) : undefined;
        return <span className="tfu-num">{formatNumber(value, p)}</span>;
      }
      return cellValueToText(field, value);
    }
    case "long_text":
      return (
        <span style={{ whiteSpace: opts.wrap ? "pre-wrap" : "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {String(value)}
        </span>
      );
    default:
      return cellValueToText(field, value);
  }
}
