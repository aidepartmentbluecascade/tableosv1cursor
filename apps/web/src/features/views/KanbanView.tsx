import { formatCellDisplay } from "@tabula/field-ui";
import type { FieldDto, RecordDto, TableDto } from "../../lib/api.ts";
import styles from "./views.module.css";

function findKanbanField(fields: FieldDto[]): FieldDto | undefined {
  return fields.find((f) => f.type === "single_select");
}

export function KanbanView({
  table,
  records,
}: {
  table: TableDto;
  records: RecordDto[];
}) {
  const groupField = findKanbanField(table.fields);
  const primaryId = table.primaryFieldId;
  const options = groupField?.config.options ?? [];
  const columns =
    options.length > 0
      ? options.map((o) => o.id)
      : ["__ungrouped__"];

  const labelFor = (optionId: string) => {
    if (optionId === "__ungrouped__") return "No status";
    return options.find((o) => o.id === optionId)?.label ?? optionId;
  };

  return (
    <div className={styles.kanban}>
      {columns.map((colId) => {
        const colRecords = records.filter((r) => {
          if (!groupField) return colId === "__ungrouped__";
          const v = r.fields[groupField.id];
          const key = typeof v === "string" ? v : null;
          if (colId === "__ungrouped__") return !key;
          return key === colId;
        });
        return (
          <section key={colId} className={styles.kanbanCol}>
            <h3 className={styles.kanbanColTitle}>
              {labelFor(colId)} ({colRecords.length})
            </h3>
            {colRecords.map((record) => {
              const pf = table.fields.find((f) => f.id === primaryId);
              const title = pf
                ? formatCellDisplay(
                    pf.type,
                    record.fields[primaryId],
                    pf.config,
                  )
                : String(record.fields[primaryId] ?? "Row");
              return (
                <div key={record.id} className={styles.kanbanCard}>
                  {title || "Untitled"}
                </div>
              );
            })}
          </section>
        );
      })}
    </div>
  );
}
