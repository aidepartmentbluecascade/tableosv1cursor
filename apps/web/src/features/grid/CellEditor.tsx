import type { FieldDto } from "../../lib/api.ts";
import type { CellValue } from "@tabula/fields";
import { useEffect, useRef } from "react";

function formatDisplay(value: CellValue | null | undefined): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value)) return value.join(", ");
  return String(value);
}

export interface CellEditorProps {
  field: FieldDto;
  value: CellValue | null | undefined;
  editing: boolean;
  draft: string;
  onDraftChange: (next: string) => void;
  onCommit: () => void;
  onCancel: () => void;
  onAdvance?: () => void;
}

export function CellEditor({
  field,
  value,
  editing,
  draft,
  onDraftChange,
  onCommit,
  onCancel,
  onAdvance,
}: CellEditorProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const selectRef = useRef<HTMLSelectElement>(null);

  useEffect(() => {
    if (!editing) return;
    const el = inputRef.current ?? selectRef.current;
    el?.focus();
    if (el instanceof HTMLInputElement && (el.type === "text" || el.type === "email" || el.type === "url" || el.type === "number")) {
      el.select();
    }
  }, [editing]);

  if (!editing) {
    const display =
      field.type === "checkbox"
        ? value === true
          ? "☑"
          : "☐"
        : formatDisplay(value as CellValue | null | undefined);
    return <>{display || "\u00a0"}</>;
  }

  if (field.type === "checkbox") {
    return (
      <input
        ref={inputRef}
        type="checkbox"
        checked={draft === "true"}
        onChange={(e) => {
          onDraftChange(e.target.checked ? "true" : "false");
          onCommit();
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
          if (e.key === "Tab") {
            e.preventDefault();
            onAdvance?.();
          }
        }}
      />
    );
  }

  if (field.type === "single_select") {
    const options = field.config.options ?? [];
    return (
      <select
        ref={selectRef}
        value={draft}
        onChange={(e) => {
          onDraftChange(e.target.value);
          onCommit();
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
          if (e.key === "Tab") {
            e.preventDefault();
            onAdvance?.();
          }
        }}
        style={{ width: "100%", border: "none", background: "transparent" }}
      >
        <option value="">—</option>
        {options.map((opt) => (
          <option key={opt.id} value={opt.label}>
            {opt.label}
          </option>
        ))}
      </select>
    );
  }

  return (
    <input
      ref={inputRef}
      className="cellEditorInput"
      type={
        field.type === "number" ||
        field.type === "currency" ||
        field.type === "percent" ||
        field.type === "rating"
          ? "number"
          : field.type === "date"
            ? "date"
            : field.type === "email"
              ? "email"
              : field.type === "url"
                ? "url"
                : "text"
      }
      value={draft}
      onChange={(e) => onDraftChange(e.target.value)}
      onBlur={() => onCommit()}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          (onAdvance ?? onCommit)();
        }
        if (e.key === "Tab") {
          e.preventDefault();
          (onAdvance ?? onCommit)();
        }
        if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        }
      }}
      style={{
        width: "100%",
        border: "none",
        outline: "none",
        background: "transparent",
        padding: "4px 8px",
        font: "inherit",
      }}
    />
  );
}
