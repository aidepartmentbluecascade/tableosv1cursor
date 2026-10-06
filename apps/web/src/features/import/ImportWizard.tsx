import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@tabula/ui";
import { api, type ImportResult } from "../../lib/api.ts";
import styles from "./import-wizard.module.css";

export function ImportWizard({
  baseId,
  tableId,
  onClose,
  onDone,
}: {
  baseId: string;
  tableId: string;
  onClose: () => void;
  onDone?: () => void;
}) {
  const [csv, setCsv] = useState("");
  const [result, setResult] = useState<ImportResult | null>(null);

  const importMutation = useMutation({
    mutationFn: () => api.importCsv(baseId, tableId, { csv, hasHeader: true }),
    onSuccess: (data) => {
      setResult(data);
      onDone?.();
    },
  });

  return (
    <div className={styles.backdrop} role="presentation" onClick={onClose}>
      <div
        className={styles.panel}
        role="dialog"
        aria-labelledby="import-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="import-title">Import CSV</h2>
        <p className={styles.hint}>
          Paste CSV text or choose a file. First row is treated as headers.
        </p>
        <textarea
          className={styles.textarea}
          value={csv}
          onChange={(e) => setCsv(e.target.value)}
          placeholder="name,email&#10;Ada,ada@example.com"
          rows={8}
        />
        <input
          type="file"
          accept=".csv,text/csv"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            void file.text().then(setCsv);
          }}
        />
        {result ? (
          <p className={styles.success}>
            Imported {result.imported} row(s). Job {result.jobId}
          </p>
        ) : null}
        <div className={styles.actions}>
          <Button type="button" variant="secondary" onClick={onClose}>
            Close
          </Button>
          <Button
            type="button"
            disabled={!csv.trim() || importMutation.isPending}
            onClick={() => importMutation.mutate()}
          >
            {importMutation.isPending ? "Importing…" : "Import"}
          </Button>
        </div>
      </div>
    </div>
  );
}
