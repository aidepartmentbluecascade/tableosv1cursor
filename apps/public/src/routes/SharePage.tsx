import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@tabula/ui";
import { formatCellDisplay } from "@tabula/field-ui";
import {
  fetchShare,
  submitShareForm,
  submitViaShareHeader,
  type PublicSharePayload,
} from "../lib/public-api.ts";
import shell from "../app/shell.module.css";

function ReadOnlyTable({ share }: { share: PublicSharePayload }) {
  const cols = share.fields;
  const rows = share.records ?? [];
  return (
    <div className={shell.card}>
      <h1 className={shell.title}>{share.title}</h1>
      <table className={shell.table}>
        <thead>
          <tr>
            {cols.map((c) => (
              <th key={c.id}>{c.name}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              {cols.map((c) => (
                <td key={c.id}>
                  {formatCellDisplay(
                    c.type,
                    row.fields[c.id] as never,
                    {},
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 ? (
        <p className={shell.muted}>No records in this view.</p>
      ) : null}
    </div>
  );
}

function PublicForm({
  token,
  share,
}: {
  token: string;
  share: PublicSharePayload;
}) {
  const editable = share.fields.filter(
    (f) => !f.type.startsWith("created_") && !f.type.startsWith("modified_"),
  );
  const [values, setValues] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const f of editable) init[f.id] = "";
    return init;
  });
  const [done, setDone] = useState(false);

  const submit = useMutation({
    mutationFn: async () => {
      const payload: Record<string, unknown> = {};
      for (const f of editable) {
        const raw = values[f.id]?.trim();
        if (!raw && f.type !== "checkbox") continue;
        if (f.type === "checkbox") payload[f.id] = values[f.id] === "true";
        else if (f.type === "number") payload[f.id] = Number(raw);
        else payload[f.id] = raw;
      }
      try {
        await submitShareForm(token, payload);
      } catch {
        await submitViaShareHeader(
          token,
          share.baseId,
          share.tableId,
          payload,
        );
      }
    },
    onSuccess: () => setDone(true),
  });

  return (
    <div className={shell.card}>
      <h1 className={shell.title}>{share.title}</h1>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit.mutate();
        }}
      >
        {editable.map((field) => (
          <div key={field.id} className={shell.formField}>
            <label htmlFor={field.id}>{field.name}</label>
            {field.type === "long_text" ? (
              <textarea
                id={field.id}
                value={values[field.id] ?? ""}
                onChange={(e) =>
                  setValues((v) => ({ ...v, [field.id]: e.target.value }))
                }
              />
            ) : (
              <input
                id={field.id}
                type={field.type === "number" ? "number" : "text"}
                value={values[field.id] ?? ""}
                onChange={(e) =>
                  setValues((v) => ({ ...v, [field.id]: e.target.value }))
                }
              />
            )}
          </div>
        ))}
        <Button type="submit" disabled={submit.isPending || done}>
          {done ? "Submitted" : submit.isPending ? "Submitting…" : "Submit"}
        </Button>
        {done ? (
          <p className={shell.success}>Thank you — your response was recorded.</p>
        ) : null}
      </form>
    </div>
  );
}

export function SharePage({ token, forceForm }: { token: string; forceForm?: boolean }) {
  const shareQuery = useQuery({
    queryKey: ["public-share", token],
    queryFn: () => fetchShare(token),
  });

  return (
    <div className={shell.shell}>
      <header className={shell.header}>
        <span className={shell.logo}>Tabula</span>
        <span className={shell.tagline}>Shared view</span>
      </header>
      <main className={shell.main}>
        {shareQuery.isLoading ? (
          <p className={shell.muted}>Loading…</p>
        ) : shareQuery.isError ? (
          <p className={shell.muted}>This link is invalid or has expired.</p>
        ) : shareQuery.data ? (
          forceForm || shareQuery.data.kind === "form" ? (
            <PublicForm token={token} share={shareQuery.data} />
          ) : (
            <ReadOnlyTable share={shareQuery.data} />
          )
        ) : null}
      </main>
    </div>
  );
}
