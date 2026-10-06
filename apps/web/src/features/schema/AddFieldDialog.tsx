import { useMemo, useState } from "react";
import { Button, Input, Label } from "@tabula/ui";
import type { FieldTypeKey } from "@tabula/fields";
import styles from "./add-field.module.css";

const STANDARD_FIELDS: Array<{
  value: FieldTypeKey;
  label: string;
  icon: string;
  group: "standard" | "computed";
}> = [
  { value: "link", label: "Link to another record", icon: "⇄", group: "standard" },
  { value: "text", label: "Single line text", icon: "A", group: "standard" },
  { value: "long_text", label: "Long text", icon: "¶", group: "standard" },
  { value: "checkbox", label: "Checkbox", icon: "☑", group: "standard" },
  { value: "multi_select", label: "Multiple select", icon: "≡", group: "standard" },
  { value: "single_select", label: "Single select", icon: "◉", group: "standard" },
  { value: "contact", label: "User", icon: "☺", group: "standard" },
  { value: "date", label: "Date", icon: "📅", group: "standard" },
  { value: "phone", label: "Phone number", icon: "☎", group: "standard" },
  { value: "email", label: "Email", icon: "✉", group: "standard" },
  { value: "url", label: "URL", icon: "🔗", group: "standard" },
  { value: "number", label: "Number", icon: "#", group: "standard" },
  { value: "currency", label: "Currency", icon: "$", group: "standard" },
  { value: "percent", label: "Percent", icon: "%", group: "standard" },
  { value: "datetime", label: "Duration", icon: "◷", group: "standard" },
  { value: "rating", label: "Rating", icon: "★", group: "standard" },
  { value: "formula", label: "Formula", icon: "ƒ", group: "computed" },
  { value: "rollup", label: "Rollup", icon: "∑", group: "computed" },
  { value: "count", label: "Count", icon: "▣", group: "computed" },
];

const SELECT_DEFAULTS = {
  options: [
    { id: "opt_1", label: "Option A", color: "#2563eb" },
    { id: "opt_2", label: "Option B", color: "#16a34a" },
  ],
};

export function AddFieldDialog({
  open,
  onClose,
  onSubmit,
  pending,
}: {
  open: boolean;
  onClose: () => void;
  onSubmit: (body: {
    name: string;
    type: string;
    config?: Record<string, unknown>;
  }) => void;
  pending: boolean;
}) {
  const [name, setName] = useState("");
  const [query, setQuery] = useState("");
  const [type, setType] = useState<FieldTypeKey>("text");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return STANDARD_FIELDS;
    return STANDARD_FIELDS.filter((t) => t.label.toLowerCase().includes(q));
  }, [query]);

  const standard = filtered.filter((t) => t.group === "standard");
  const computed = filtered.filter((t) => t.group === "computed");

  if (!open) return null;

  return (
    <div
      className={styles.backdrop}
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <form
        className={styles.panel}
        aria-labelledby="add-field-title"
        onSubmit={(e) => {
          e.preventDefault();
          const trimmed = name.trim() || STANDARD_FIELDS.find((t) => t.value === type)?.label || "Field";
          const config =
            type === "single_select" || type === "multi_select"
              ? SELECT_DEFAULTS
              : undefined;
          onSubmit({
            name: trimmed,
            type,
            ...(config ? { config } : {}),
          });
          setName("");
          setQuery("");
          setType("text");
        }}
      >
        <h2 id="add-field-title">Add field</h2>
        <Label htmlFor="field-name">Name</Label>
        <Input
          id="field-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Field name"
          autoFocus
        />
        <Label htmlFor="field-type-search">Find a field type</Label>
        <Input
          id="field-type-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Find a field type"
        />
        <div className={styles.list}>
          {standard.length > 0 ? (
            <>
              <p className={styles.group}>Standard fields</p>
              {standard.map((t) => (
                <button
                  key={t.value}
                  type="button"
                  className={
                    type === t.value
                      ? `${styles.typeBtn} ${styles.typeBtnActive}`
                      : styles.typeBtn
                  }
                  onClick={() => {
                    setType(t.value);
                    if (!name.trim()) setName(t.label);
                  }}
                >
                  <span className={styles.icon} aria-hidden>
                    {t.icon}
                  </span>
                  {t.label}
                </button>
              ))}
            </>
          ) : null}
          {computed.length > 0 ? (
            <>
              <p className={styles.group}>Computed fields</p>
              {computed.map((t) => (
                <button
                  key={t.value}
                  type="button"
                  className={
                    type === t.value
                      ? `${styles.typeBtn} ${styles.typeBtnActive}`
                      : styles.typeBtn
                  }
                  onClick={() => {
                    setType(t.value);
                    if (!name.trim()) setName(t.label);
                  }}
                >
                  <span className={styles.icon} aria-hidden>
                    {t.icon}
                  </span>
                  {t.label}
                </button>
              ))}
            </>
          ) : null}
          {filtered.length === 0 ? (
            <p className={styles.empty}>No matching field types</p>
          ) : null}
        </div>
        <p className={styles.selected}>Selected: {STANDARD_FIELDS.find((t) => t.value === type)?.label}</p>
        <div className={styles.actions}>
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={pending}>
            {pending ? "Adding…" : "Add field"}
          </Button>
        </div>
      </form>
    </div>
  );
}
