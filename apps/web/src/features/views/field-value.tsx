import * as fieldUi from "@tabula/field-ui";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, type ComponentType, type ReactNode } from "react";
import { request, type FieldDto } from "../../lib/api.ts";
import { colorOf, selectOptions, valueToText } from "./view-utils.ts";
import styles from "./views.module.css";

/* Prefer C's shared field UI (CONTRACTS §8) when it is available. */
const ui = fieldUi as unknown as {
  FieldValueEditor?: ComponentType<{
    field: FieldDto;
    value: unknown;
    onChange: (v: unknown) => void;
    baseId?: string;
  }>;
  renderCellValue?: (field: FieldDto, value: unknown) => ReactNode;
};

export const hasSharedEditor = Boolean(ui.FieldValueEditor);

export function Chip({ label, color }: { label: string; color?: string | undefined }) {
  const c = colorOf(color);
  return (
    <span className={styles.chip} style={{ background: c.bg, color: c.fg }}>
      {label}
    </span>
  );
}

/** Read-only rendering of a record value (wire format, CONTRACTS §3). */
export function CellValueDisplay({ field, value }: { field: FieldDto; value: unknown }) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  if (ui.renderCellValue) {
    try {
      return <>{ui.renderCellValue(field, value)}</>;
    } catch {
      /* fall through */
    }
  }
  switch (field.type) {
    case "single_select": {
      const o = selectOptions(field).find((x) => x.id === value);
      return <Chip label={o?.label ?? String(value)} color={o?.color} />;
    }
    case "multi_select": {
      const opts = selectOptions(field);
      const ids = Array.isArray(value) ? value : [value];
      return (
        <span className={styles.chipRow}>
          {ids.map((id) => {
            const o = opts.find((x) => x.id === id);
            return <Chip key={String(id)} label={o?.label ?? String(id)} color={o?.color} />;
          })}
        </span>
      );
    }
    case "checkbox":
      return <span aria-label="checked">✓</span>;
    case "rating": {
      const n = Number(value) || 0;
      return <span className={styles.rating}>{"★".repeat(n)}</span>;
    }
    case "attachment": {
      const items = Array.isArray(value) ? (value as { id: string; filename?: string; thumbnailUrl?: string | null; url?: string; mime?: string }[]) : [];
      return (
        <span className={styles.chipRow}>
          {items.map((a) =>
            a.mime?.startsWith("image/") && (a.thumbnailUrl || a.url) ? (
              <img key={a.id} className={styles.attThumb} src={a.thumbnailUrl ?? a.url} alt={a.filename ?? ""} />
            ) : (
              <span key={a.id} className={styles.chipPlain}>{a.filename ?? "file"}</span>
            ),
          )}
        </span>
      );
    }
    case "collaborator":
    case "created_by":
    case "modified_by":
    case "link": {
      const items = Array.isArray(value) ? value : [value];
      return (
        <span className={styles.chipRow}>
          {items.map((u, i) => {
            const o = (u ?? {}) as { id?: string; name?: string; email?: string };
            return (
              <span key={o.id ?? i} className={styles.chipPlain}>
                {o.name ?? o.email ?? o.id ?? String(u)}
              </span>
            );
          })}
        </span>
      );
    }
    default:
      return <span>{valueToText(field, value)}</span>;
  }
}

interface Collaborator {
  id: string;
  name: string;
  email: string;
}

export function useCollaborators(baseId: string, enabled = true) {
  return useQuery({
    queryKey: ["collaborators", baseId],
    queryFn: async () => {
      try {
        const res = await request<{ collaborators: Collaborator[] }>(
          `/v1/bases/${baseId}/collaborators`,
        );
        return res.collaborators ?? [];
      } catch {
        return [] as Collaborator[];
      }
    },
    enabled,
    staleTime: 60_000,
  });
}

/**
 * Editable input for a field value. Uses C's `FieldValueEditor` when present,
 * otherwise a typed native input. Value is in wire/input-shorthand form.
 */
export function ValueEditor({
  baseId,
  field,
  value,
  onChange,
  autoFocus,
  id,
  compact,
}: {
  baseId: string;
  field: FieldDto;
  value: unknown;
  onChange: (v: unknown) => void;
  autoFocus?: boolean;
  id?: string;
  compact?: boolean;
}) {
  const ref = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);
  const collabs = useCollaborators(baseId, field.type === "collaborator");
  if (ui.FieldValueEditor) {
    const Editor = ui.FieldValueEditor;
    return <Editor field={field} value={value} onChange={onChange} baseId={baseId} />;
  }
  const cls = compact ? styles.inputCompact : styles.input;
  switch (field.type) {
    case "long_text":
      return (
        <textarea
          id={id}
          className={cls}
          rows={3}
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case "number":
    case "currency":
    case "percent":
    case "duration":
      return (
        <input
          id={id}
          ref={ref}
          className={cls}
          type="number"
          value={value === undefined || value === null ? "" : String(value)}
          onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
        />
      );
    case "rating": {
      const max = Number((field.config as { max?: number }).max ?? 5);
      const n = Number(value) || 0;
      return (
        <span className={styles.ratingInput}>
          {Array.from({ length: max }, (_, i) => (
            <button
              key={i}
              type="button"
              className={i < n ? styles.starOn : styles.starOff}
              onClick={() => onChange(i + 1 === n ? null : i + 1)}
              aria-label={`${i + 1} stars`}
            >
              ★
            </button>
          ))}
        </span>
      );
    }
    case "checkbox":
      return (
        <input
          id={id}
          type="checkbox"
          checked={value === true}
          onChange={(e) => onChange(e.target.checked)}
        />
      );
    case "date":
      return (
        <input
          id={id}
          ref={ref}
          className={cls}
          type="date"
          value={typeof value === "string" ? value.slice(0, 10) : ""}
          onChange={(e) => onChange(e.target.value || null)}
        />
      );
    case "datetime": {
      const d = typeof value === "string" && value ? new Date(value) : null;
      const local = d && !Number.isNaN(d.getTime())
        ? new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16)
        : "";
      return (
        <input
          id={id}
          ref={ref}
          className={cls}
          type="datetime-local"
          value={local}
          onChange={(e) => onChange(e.target.value ? new Date(e.target.value).toISOString() : null)}
        />
      );
    }
    case "single_select":
      return (
        <select
          id={id}
          className={cls}
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value || null)}
        >
          <option value="">—</option>
          {selectOptions(field).map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
      );
    case "multi_select": {
      const sel = new Set(Array.isArray(value) ? (value as string[]) : []);
      return (
        <span className={styles.chipRow}>
          {selectOptions(field).map((o) => {
            const on = sel.has(o.id);
            const c = colorOf(o.color);
            return (
              <button
                key={o.id}
                type="button"
                className={on ? styles.optToggleOn : styles.optToggle}
                style={on ? { background: c.bg, color: c.fg } : undefined}
                onClick={() => {
                  const next = new Set(sel);
                  if (on) next.delete(o.id);
                  else next.add(o.id);
                  onChange([...next]);
                }}
              >
                {o.label}
              </button>
            );
          })}
        </span>
      );
    }
    case "collaborator": {
      const sel = new Set(
        (Array.isArray(value) ? value : value ? [value] : []).map((u) =>
          typeof u === "string" ? u : (u as { id: string }).id,
        ),
      );
      const list = collabs.data ?? [];
      if (list.length === 0) {
        return <span className={styles.muted}>No collaborators available</span>;
      }
      return (
        <span className={styles.chipRow}>
          {list.map((u) => {
            const on = sel.has(u.id);
            return (
              <button
                key={u.id}
                type="button"
                className={on ? styles.optToggleOn : styles.optToggle}
                onClick={() => {
                  const next = new Set(sel);
                  if (on) next.delete(u.id);
                  else next.add(u.id);
                  onChange([...next]);
                }}
              >
                {u.name || u.email}
              </button>
            );
          })}
        </span>
      );
    }
    case "attachment":
    case "link":
      return <span className={styles.muted}>Edit this field from the record.</span>;
    default:
      return (
        <input
          id={id}
          ref={ref}
          className={cls}
          type={field.type === "email" ? "email" : field.type === "url" ? "url" : "text"}
          value={typeof value === "string" ? value : value == null ? "" : valueToText(field, value)}
          onChange={(e) => onChange(e.target.value)}
        />
      );
  }
}
