import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@tabula/ui";
import type { CellValue } from "@tabula/fields";
import { api, type FilterAst, type RecordDto, type TableDto } from "../../lib/api.ts";
import { useUiStore } from "../../stores/ui.ts";
import { AddFieldDialog } from "../schema/AddFieldDialog.tsx";
import { FieldHeader } from "../schema/FieldHeader.tsx";
import { CellEditor } from "./CellEditor.tsx";
import styles from "./grid.module.css";

function cellToDraft(value: CellValue | null | undefined, fieldType: string): string {
  if (value === null || value === undefined) return "";
  if (fieldType === "checkbox") return value === true ? "true" : "false";
  if (Array.isArray(value)) return value.join(", ");
  return String(value);
}

function draftToValue(draft: string, fieldType: string): CellValue | null {
  if (fieldType === "checkbox") return draft === "true";
  if (fieldType === "number" || fieldType === "currency" || fieldType === "percent" || fieldType === "rating") {
    const trimmed = draft.trim();
    if (!trimmed) return null;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : trimmed;
  }
  if (fieldType === "multi_select") {
    const items = draft
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    return items.length ? items : null;
  }
  const trimmed = draft.trim();
  if (!trimmed) return null;
  return trimmed;
}

function nextCell(
  records: RecordDto[],
  fields: TableDto["fields"],
  recordId: string,
  fieldId: string,
): { recordId: string; fieldId: string; wrap: boolean } | null {
  const row = records.findIndex((r) => r.id === recordId);
  const col = fields.findIndex((f) => f.id === fieldId);
  if (row < 0 || col < 0) return null;
  if (col + 1 < fields.length) {
    return { recordId: records[row]!.id, fieldId: fields[col + 1]!.id, wrap: false };
  }
  if (row + 1 < records.length) {
    return { recordId: records[row + 1]!.id, fieldId: fields[0]!.id, wrap: false };
  }
  return { recordId, fieldId, wrap: true };
}

export function DomGrid({
  baseId,
  table,
  onSchemaChange,
  hideChrome = false,
  filter,
  sort,
  search,
}: {
  baseId: string;
  table: TableDto;
  onSchemaChange: () => void;
  hideChrome?: boolean;
  filter?: FilterAst | undefined;
  sort?: Array<{ field: string; direction: "asc" | "desc" }> | undefined;
  search?: string;
}) {
  const queryClient = useQueryClient();
  const fields = [...table.fields].sort((a, b) => a.slot - b.slot);
  const primaryFieldId = table.primaryFieldId;
  const pendingNav = useRef<{ fieldId: string } | null>(null);

  const recordsQuery = useQuery({
    queryKey: ["records", baseId, table.id, filter, sort, search ?? ""],
    queryFn: () => {
      const body: Parameters<typeof api.queryRecords>[2] = {
        pageSize: 200,
        fields: fields.map((f) => f.id),
      };
      if (filter) body.filter = filter;
      if (sort && sort.length > 0) body.sort = sort;
      return api.queryRecords(baseId, table.id, body);
    },
  });

  const [editing, setEditing] = useState<{
    recordId: string;
    fieldId: string;
    draft: string;
  } | null>(null);
  const [addFieldOpen, setAddFieldOpen] = useState(false);

  const gridSelection = useUiStore((s) => s.gridSelection);
  const setGridSelection = useUiStore((s) => s.setGridSelection);

  const patchRecord = useMutation({
    mutationFn: (args: {
      recordId: string;
      version: number;
      fieldId: string;
      value: CellValue | null;
    }) =>
      api.patchRecord(baseId, table.id, args.recordId, {
        version: args.version,
        fields: { [args.fieldId]: args.value },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["records", baseId, table.id],
      });
    },
  });

  const createRecord = useMutation({
    mutationFn: () => {
      const initial: Record<string, unknown> = {};
      const primary = fields.find((f) => f.id === primaryFieldId);
      if (primary) initial[primary.id] = "";
      return api.createRecord(baseId, table.id, initial);
    },
    onSuccess: (record) => {
      void queryClient.invalidateQueries({
        queryKey: ["records", baseId, table.id],
      });
      const firstField = fields[0];
      if (firstField) {
        pendingNav.current = { fieldId: firstField.id };
        setGridSelection({ recordId: record.id, fieldId: firstField.id });
        setEditing({
          recordId: record.id,
          fieldId: firstField.id,
          draft: "",
        });
      }
    },
  });

  const createField = useMutation({
    mutationFn: (body: { name: string; type: string; config?: Record<string, unknown> }) =>
      api.createField(baseId, table.id, body),
    onSuccess: () => {
      setAddFieldOpen(false);
      onSchemaChange();
      void queryClient.invalidateQueries({
        queryKey: ["records", baseId, table.id],
      });
    },
  });

  const records = (() => {
    const raw = recordsQuery.data?.records ?? [];
    const q = search?.trim().toLowerCase();
    if (!q) return raw;
    return raw.filter((r) =>
      Object.values(r.fields).some((v) => JSON.stringify(v ?? "").toLowerCase().includes(q)),
    );
  })();

  const startEdit = useCallback(
    (record: RecordDto, fieldId: string, fieldType: string) => {
      const raw = record.fields[fieldId] as CellValue | null | undefined;
      setEditing({
        recordId: record.id,
        fieldId,
        draft: cellToDraft(raw, fieldType),
      });
      setGridSelection({ recordId: record.id, fieldId });
    },
    [setGridSelection],
  );

  const moveAfterCommit = useCallback(
    (fromRecordId: string, fromFieldId: string) => {
      const next = nextCell(records, fields, fromRecordId, fromFieldId);
      if (!next) return;
      if (next.wrap) {
        pendingNav.current = { fieldId: fields[0]?.id ?? fromFieldId };
        createRecord.mutate();
        return;
      }
      const record = records.find((r) => r.id === next.recordId);
      const field = fields.find((f) => f.id === next.fieldId);
      if (record && field) startEdit(record, field.id, field.type);
    },
    [records, fields, createRecord, startEdit],
  );

  const commitEdit = useCallback(
    (advance: boolean) => {
      if (!editing) return;
      const record = records.find((r) => r.id === editing.recordId);
      const field = fields.find((f) => f.id === editing.fieldId);
      const from = { recordId: editing.recordId, fieldId: editing.fieldId };
      if (!record || !field) {
        setEditing(null);
        return;
      }
      const nextValue = draftToValue(editing.draft, field.type);
      const prev = record.fields[field.id];
      const prevNorm =
        prev === null || prev === undefined ? null : (prev as CellValue);
      if (JSON.stringify(prevNorm) !== JSON.stringify(nextValue)) {
        patchRecord.mutate({
          recordId: record.id,
          version: record.version,
          fieldId: field.id,
          value: nextValue,
        });
      }
      setEditing(null);
      if (advance) moveAfterCommit(from.recordId, from.fieldId);
    },
    [editing, records, fields, patchRecord, moveAfterCommit],
  );

  const cancelEdit = useCallback(() => {
    setEditing(null);
  }, []);

  useEffect(() => {
    if (!pendingNav.current || records.length === 0) return;
    const fieldId = pendingNav.current.fieldId;
    const last = records[records.length - 1];
    const field = fields.find((f) => f.id === fieldId);
    pendingNav.current = null;
    if (last && field) startEdit(last, field.id, field.type);
  }, [records, fields, startEdit]);

  return (
    <div className={hideChrome ? styles.embedded : styles.wrap}>
      {hideChrome ? null : (
        <div className={styles.toolbar}>
          <Button
            type="button"
            onClick={() => createRecord.mutate()}
            disabled={createRecord.isPending || fields.length === 0}
          >
            {createRecord.isPending ? "Adding row…" : "Add row"}
          </Button>
          <Button type="button" variant="secondary" onClick={() => setAddFieldOpen(true)}>
            Add field
          </Button>
          {recordsQuery.isFetching ? (
            <span className={styles.status}>Refreshing…</span>
          ) : null}
        </div>
      )}

      <div className={styles.scroll}>
        <table className={styles.table}>
          <thead className={styles.thead}>
            <tr>
              <th className={styles.rowNum}>#</th>
              {fields.map((field) => (
                <th
                  key={field.id}
                  className={
                    field.id === primaryFieldId
                      ? `${styles.th} ${styles.thPrimary}`
                      : styles.th
                  }
                >
                  <FieldHeader field={field} isPrimary={field.id === primaryFieldId} />
                </th>
              ))}
              <th className={styles.addCol}>
                <button
                  type="button"
                  className={styles.addColBtn}
                  onClick={() => setAddFieldOpen(true)}
                  title="Add field"
                >
                  +
                </button>
              </th>
            </tr>
          </thead>
          <tbody>
            {records.map((record, rowIndex) => (
              <tr
                key={record.id}
                className={rowIndex % 2 === 0 ? styles.rowEven : styles.rowOdd}
              >
                <td className={styles.rowNum}>{rowIndex + 1}</td>
                {fields.map((field) => {
                  const isSelected =
                    gridSelection?.recordId === record.id &&
                    gridSelection.fieldId === field.id;
                  const isEditing =
                    editing?.recordId === record.id &&
                    editing.fieldId === field.id;
                  const value = record.fields[field.id] as
                    | CellValue
                    | null
                    | undefined;
                  const isPrimary = field.id === primaryFieldId;

                  return (
                    <td
                      key={field.id}
                      className={
                        isSelected
                          ? `${styles.td} ${styles.cellSelected}`
                          : styles.td
                      }
                      onMouseDown={(e) => {
                        e.preventDefault();
                        startEdit(record, field.id, field.type);
                      }}
                    >
                      <div
                        className={
                          isPrimary
                            ? `${styles.cellInner} ${styles.cellPrimary}`
                            : styles.cellInner
                        }
                      >
                        <CellEditor
                          field={field}
                          value={value}
                          editing={isEditing}
                          draft={
                            isEditing
                              ? editing.draft
                              : cellToDraft(value, field.type)
                          }
                          onDraftChange={(draft) => {
                            setEditing((prev) =>
                              prev && prev.recordId === record.id && prev.fieldId === field.id
                                ? { ...prev, draft }
                                : prev,
                            );
                          }}
                          onCommit={() => commitEdit(false)}
                          onCancel={cancelEdit}
                          onAdvance={() => commitEdit(true)}
                        />
                      </div>
                    </td>
                  );
                })}
                <td className={styles.addCol} />
              </tr>
            ))}
            <tr>
              <td className={styles.rowNum} />
              <td colSpan={Math.max(1, fields.length)} className={styles.addRowCell}>
                <button
                  type="button"
                  className={styles.addRowBtn}
                  disabled={createRecord.isPending || fields.length === 0}
                  onClick={() => createRecord.mutate()}
                >
                  {createRecord.isPending ? "Adding…" : "+ Add row"}
                </button>
              </td>
              <td className={styles.addCol} />
            </tr>
          </tbody>
        </table>
        {recordsQuery.isLoading ? (
          <p className={styles.status} style={{ padding: 16 }}>
            Loading records…
          </p>
        ) : null}
        {recordsQuery.isError ? (
          <p className={styles.status} style={{ padding: 16, color: "var(--tabula-color-danger)" }}>
            Could not load records
          </p>
        ) : null}
      </div>

      <AddFieldDialog
        open={addFieldOpen}
        onClose={() => setAddFieldOpen(false)}
        pending={createField.isPending}
        onSubmit={(body) => createField.mutate(body)}
      />
    </div>
  );
}
