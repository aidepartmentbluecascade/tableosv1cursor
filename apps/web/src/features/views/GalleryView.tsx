import { formatCellDisplay } from "@tabula/field-ui";
import type { RecordDto, TableDto } from "../../lib/api.ts";
import styles from "./views.module.css";

export function GalleryView({
  table,
  records,
}: {
  table: TableDto;
  records: RecordDto[];
}) {
  const primaryId = table.primaryFieldId;
  const primaryField = table.fields.find((f) => f.id === primaryId);

  return (
    <div className={styles.gallery}>
      {records.map((record) => {
        const raw = record.fields[primaryId];
        const title = primaryField
          ? formatCellDisplay(primaryField.type, raw, primaryField.config)
          : String(raw ?? "Untitled");
        return (
          <article key={record.id} className={styles.card}>
            <div className={styles.cardTitle}>{title || "Untitled"}</div>
            {table.fields
              .filter((f) => f.id !== primaryId)
              .slice(0, 3)
              .map((field) => (
                <div key={field.id} style={{ fontSize: "var(--tabula-font-size-sm)" }}>
                  <span style={{ color: "var(--tabula-color-text-muted)" }}>
                    {field.name}:{" "}
                  </span>
                  {formatCellDisplay(
                    field.type,
                    record.fields[field.id],
                    field.config,
                  )}
                </div>
              ))}
          </article>
        );
      })}
    </div>
  );
}
