import type { ReactElement } from "react";
import type { CellValue, FieldConfig } from "@tabula/fields";
import { getFieldEditorMeta } from "./metadata.js";

export interface SimpleFieldEditorProps {
  type: string;
  value: CellValue | null | undefined;
  config?: FieldConfig;
  draft: string;
  onDraftChange: (draft: string) => void;
  onCommit: () => void;
  onCancel: () => void;
  autoFocus?: boolean;
}

export function SimpleFieldEditor({
  type,
  draft,
  onDraftChange,
  onCommit,
  onCancel,
  autoFocus,
}: SimpleFieldEditorProps): ReactElement {
  const meta = getFieldEditorMeta(type);

  if (meta.input === "checkbox") {
    const checked = draft === "true";
    return (
      <input
        type="checkbox"
        checked={checked}
        autoFocus={autoFocus}
        onChange={(e) => {
          onDraftChange(e.target.checked ? "true" : "false");
          onCommit();
        }}
      />
    );
  }

  if (meta.input === "multiline") {
    return (
      <textarea
        value={draft}
        autoFocus={autoFocus}
        placeholder={meta.placeholder}
        rows={3}
        style={{ width: "100%", font: "inherit" }}
        onChange={(e) => onDraftChange(e.target.value)}
        onBlur={onCommit}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
      />
    );
  }

  const inputType = meta.input === "number" ? "number" : meta.input === "date" ? "date" : "text";

  return (
    <input
      type={inputType}
      value={draft}
      autoFocus={autoFocus}
      placeholder={meta.placeholder}
      style={{ width: "100%", font: "inherit" }}
      onChange={(e) => onDraftChange(e.target.value)}
      onBlur={onCommit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          onCommit();
        }
        if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        }
      }}
    />
  );
}
