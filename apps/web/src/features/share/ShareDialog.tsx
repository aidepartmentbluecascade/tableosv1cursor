import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Button, Input, Label } from "@tabula/ui";
import { api } from "../../lib/api.ts";
import styles from "./share-dialog.module.css";

const PUBLIC_ORIGIN =
  import.meta.env.VITE_PUBLIC_APP_URL ?? "http://localhost:5174";

export function ShareDialog({
  baseId,
  tableId,
  viewId,
  viewType,
  onClose,
}: {
  baseId: string;
  tableId: string;
  viewId?: string;
  viewType?: string;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [shareUrl, setShareUrl] = useState<string | null>(null);

  const createShare = useMutation({
    mutationFn: () => {
      const body: { viewId?: string; kind?: "table" | "form" } = {
        kind: viewType === "form" ? "form" : "table",
      };
      if (viewId) body.viewId = viewId;
      return api.createShare(baseId, tableId, body);
    },
    onSuccess: (data) => {
      setShareUrl(`${PUBLIC_ORIGIN}/s/${data.token}`);
    },
  });

  return (
    <div className={styles.backdrop} role="presentation" onClick={onClose}>
      <div
        className={styles.dialog}
        role="dialog"
        aria-labelledby="share-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="share-title" className={styles.title}>
          Share view
        </h2>
        <p className={styles.hint}>
          Create a link others can open on the public Tabula site (read-only
          table or submit form).
        </p>
        {!shareUrl ? (
          <Button
            type="button"
            onClick={() => createShare.mutate()}
            disabled={createShare.isPending}
          >
            {createShare.isPending ? "Creating…" : "Create link"}
          </Button>
        ) : (
          <div className={styles.urlRow}>
            <Label htmlFor="share-url">Share URL</Label>
            <Input id="share-url" readOnly value={shareUrl} />
            <Button
              type="button"
              variant="secondary"
              onClick={async () => {
                await navigator.clipboard.writeText(shareUrl);
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              }}
            >
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
        )}
        <div className={styles.actions}>
          <Button type="button" variant="secondary" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </div>
  );
}
