import { formatCellDisplay } from "@tabula/field-ui";
import type { FieldDto, RecordDto, TableDto } from "../../lib/api.ts";
import styles from "./views.module.css";

function findDateField(fields: FieldDto[]): FieldDto | undefined {
  return fields.find((f) => f.type === "date" || f.type === "datetime");
}

export function CalendarView({
  table,
  records,
}: {
  table: TableDto;
  records: RecordDto[];
}) {
  const dateField = findDateField(table.fields);
  const primaryId = table.primaryFieldId;
  const primaryField = table.fields.find((f) => f.id === primaryId);

  const buckets = new Map<string, RecordDto[]>();
  for (const record of records) {
    const raw = dateField ? record.fields[dateField.id] : record.createdAt;
    const day =
      typeof raw === "string" && raw.length >= 10
        ? raw.slice(0, 10)
        : "No date";
    const list = buckets.get(day) ?? [];
    list.push(record);
    buckets.set(day, list);
  }

  const days = [...buckets.keys()].sort();

  return (
    <div className={styles.calendar}>
      {!dateField ? (
        <p style={{ color: "var(--tabula-color-text-muted)" }}>
          No date field — listing by created date.
        </p>
      ) : null}
      {days.map((day) => (
        <section key={day} className={styles.calendarDay}>
          <h3 className={styles.calendarDayTitle}>{day}</h3>
          <ul>
            {(buckets.get(day) ?? []).map((record) => {
              const title = primaryField
                ? formatCellDisplay(
                    primaryField.type,
                    record.fields[primaryId],
                    primaryField.config,
                  )
                : record.id;
              return <li key={record.id}>{title || "Untitled"}</li>;
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
