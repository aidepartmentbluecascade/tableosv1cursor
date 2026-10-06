import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Button, Input } from "@tabula/ui";
import { api } from "../../lib/api.ts";
import styles from "./record-drawer.module.css";

export function RecordExpandDrawer({
  baseId,
  tableId,
  recordId,
  onClose,
}: {
  baseId: string;
  tableId: string;
  recordId: string;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [comment, setComment] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  const commentsQuery = useQuery({
    queryKey: ["comments", baseId, tableId, recordId],
    queryFn: () => api.listComments(baseId, tableId, recordId),
  });

  const attachmentsQuery = useQuery({
    queryKey: ["attachments", baseId, tableId, recordId],
    queryFn: () => api.listAttachments(baseId, tableId, recordId),
  });

  const addCommentMutation = useMutation({
    mutationFn: (body: string) =>
      api.addComment(baseId, tableId, recordId, body),
    onSuccess: () => {
      setComment("");
      void queryClient.invalidateQueries({
        queryKey: ["comments", baseId, tableId, recordId],
      });
    },
  });

  async function onFileSelected(file: File) {
    setUploading(true);
    try {
      const presign = await api.presignAttachment(
        baseId,
        tableId,
        recordId,
        {
          fileName: file.name,
          contentType: file.type || "application/octet-stream",
          size: file.size,
        },
      );
      await api.uploadPresigned(presign, file);
      await api.completeAttachment(baseId, tableId, recordId, {
        uploadId: presign.uploadId,
        fileName: file.name,
        size: file.size,
      });
      void queryClient.invalidateQueries({
        queryKey: ["attachments", baseId, tableId, recordId],
      });
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className={styles.backdrop} role="presentation" onClick={onClose}>
      <aside
        className={styles.drawer}
        role="dialog"
        aria-label="Record details"
        onClick={(e) => e.stopPropagation()}
      >
        <header className={styles.header}>
          <h2 className={styles.title}>Record</h2>
          <button type="button" className={styles.close} onClick={onClose}>
            ×
          </button>
        </header>
        <p className={styles.recordId}>{recordId}</p>

        <section className={styles.section}>
          <h3>Comments</h3>
          <ul className={styles.list}>
            {(commentsQuery.data?.comments ?? []).map((c) => (
              <li key={c.id} className={styles.comment}>
                <strong>{c.authorName}</strong>
                <span className={styles.muted}>
                  {new Date(c.createdAt).toLocaleString()}
                </span>
                <p>{c.body}</p>
              </li>
            ))}
            {(commentsQuery.data?.comments ?? []).length === 0 ? (
              <li className={styles.muted}>No comments yet.</li>
            ) : null}
          </ul>
          <form
            className={styles.commentForm}
            onSubmit={(e) => {
              e.preventDefault();
              const text = comment.trim();
              if (text) addCommentMutation.mutate(text);
            }}
          >
            <Input
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder="Add a comment…"
              aria-label="Comment"
            />
            <Button type="submit" disabled={addCommentMutation.isPending}>
              Post
            </Button>
          </form>
        </section>

        <section className={styles.section}>
          <h3>Attachments</h3>
          <ul className={styles.list}>
            {(attachmentsQuery.data?.attachments ?? []).map((a) => (
              <li key={a.id}>
                <a href={a.url} target="_blank" rel="noreferrer">
                  {a.fileName}
                </a>
                <span className={styles.muted}>
                  {" "}
                  ({Math.round(a.size / 1024)} KB)
                </span>
              </li>
            ))}
          </ul>
          <input
            ref={fileRef}
            type="file"
            className={styles.hiddenFile}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void onFileSelected(file);
              e.target.value = "";
            }}
          />
          <Button
            type="button"
            variant="secondary"
            disabled={uploading}
            onClick={() => fileRef.current?.click()}
          >
            {uploading ? "Uploading…" : "Upload file"}
          </Button>
        </section>
      </aside>
    </div>
  );
}
