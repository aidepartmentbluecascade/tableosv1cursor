import { useState } from "react";
import { Button } from "@tabula/ui";
import { getFieldEditorMeta } from "@tabula/field-ui";
import type { TableDto } from "../../lib/api.ts";
import styles from "./views.module.css";

export function FormView({
  table,
  onCreate,
  pending,
}: {
  table: TableDto;
  onCreate: (fields: Record<string, unknown>) => void;
  pending: boolean;
}) {
  const editable = table.fields.filter(
    (f) => !f.type.startsWith("created_") && !f.type.startsWith("modified_"),
  );
  const [values, setValues] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const f of editable) init[f.id] = "";
    return init;
  });

  return (
    <form
      className={styles.formView}
      onSubmit={(e) => {
        e.preventDefault();
        const payload: Record<string, unknown> = {};
        for (const f of editable) {
          const raw = values[f.id]?.trim();
          if (!raw && getFieldEditorMeta(f.type).input !== "checkbox") continue;
          if (f.type === "checkbox") payload[f.id] = values[f.id] === "true";
          else if (f.type === "number") payload[f.id] = Number(raw);
          else payload[f.id] = raw;
        }
        onCreate(payload);
      }}
    >
      {editable.map((field) => (
        <div key={field.id} className={styles.formField}>
          <label htmlFor={`form-${field.id}`}>{field.name}</label>
          {getFieldEditorMeta(field.type).input === "multiline" ? (
            <textarea
              id={`form-${field.id}`}
              value={values[field.id] ?? ""}
              onChange={(e) =>
                setValues((v) => ({ ...v, [field.id]: e.target.value }))
              }
            />
          ) : (
            <input
              id={`form-${field.id}`}
              type={
                getFieldEditorMeta(field.type).input === "number"
                  ? "number"
                  : "text"
              }
              value={values[field.id] ?? ""}
              onChange={(e) =>
                setValues((v) => ({ ...v, [field.id]: e.target.value }))
              }
            />
          )}
        </div>
      ))}
      <Button type="submit" disabled={pending}>
        {pending ? "Creating…" : "Create record"}
      </Button>
    </form>
  );
}
