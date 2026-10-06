import { formatCellDisplay } from "@tabula/field-ui";
import { CanvasGrid } from "@tabula/grid";
import type { RecordStore } from "@tabula/record-store";
import {
  useCallback,
  useMemo,
  useSyncExternalStore,
  useState,
} from "react";
import type { CellValue } from "@tabula/fields";
import { generateUuidV7 } from "@tabula/types";
import type { FieldDto, RecordDto, TableDto } from "../../lib/api.ts";
import { SimpleFieldEditor } from "@tabula/field-ui";
import styles from "./grid.module.css";

function draftFromValue(value: CellValue | null | undefined, type: string): string {
  if (value === null || value === undefined) return "";
  if (type === "checkbox") return value === true ? "true" : "false";
  if (Array.isArray(value)) return value.join(", ");
  return String(value);
}

export function CanvasTableGrid({
  table,
  store,
  queryHash,
  recordIds,
  fields,
  onRequestWindow,
  onCommitCell,
  onSelectRecord,
}: {
  table: TableDto;
  store: RecordStore;
  queryHash: string;
  recordIds: string[];
  fields: FieldDto[];
  onRequestWindow: (start: number, end: number) => void;
  onSelectRecord?: (recordId: string | null) => void;
  onCommitCell: (args: {
    recordId: string;
    fieldId: string;
    value: CellValue | null;
    version: number;
    clientMutationId: string;
  }) => void;
}) {
  const snap = useSyncExternalStore(
    (cb) => store.subscribe(cb),
    () => store.getSnapshot(),
    () => store.getSnapshot(),
  );

  const columns = useMemo(
    () =>
      fields.map((f) => ({
        id: f.id,
        title: f.name,
        width: f.id === table.primaryFieldId ? 180 : 120,
      })),
    [fields, table.primaryFieldId],
  );

  const [editor, setEditor] = useState<{
    row: number;
    col: number;
    draft: string;
  } | null>(null);

  const getCellDisplay = useCallback(
    (row: number, col: number) => {
      void snap.version;
      const recordId = recordIds[row];
      const field = fields[col];
      if (!recordId || !field) return "";
      const value = store.getFieldValue(recordId, field.id);
      return formatCellDisplay(field.type, value, field.config);
    },
    [snap.version, recordIds, fields, store],
  );

  const requestWindow = useCallback(
    (start: number, end: number) => {
      onRequestWindow(start, end);
    },
    [onRequestWindow],
  );

  return (
    <div className={styles.canvasWrap}>
      <CanvasGrid
        columns={columns}
        rowCount={recordIds.length}
        getCellDisplay={getCellDisplay}
        requestWindow={requestWindow}
        frozenFirstColumn
        onSelectionChange={(sel) => {
          if (!onSelectRecord) return;
          if (!sel) {
            onSelectRecord(null);
            return;
          }
          const recordId = recordIds[sel.focus.row];
          onSelectRecord(recordId ?? null);
        }}
        onEditRequest={(row, col) => {
          const recordId = recordIds[row];
          const field = fields[col];
          if (!recordId || !field) return;
          const value = store.getFieldValue(recordId, field.id);
          setEditor({
            row,
            col,
            draft: draftFromValue(value, field.type),
          });
        }}
      />
      {editor ? (
        <div
          className={styles.editorOverlay}
          style={{
            top: 80 + editor.row * 32,
            left: 48 + editor.col * 120,
          }}
        >
          <SimpleFieldEditor
            type={fields[editor.col]?.type ?? "text"}
            value={null}
            draft={editor.draft}
            autoFocus
            onDraftChange={(draft) => setEditor((e) => (e ? { ...e, draft } : e))}
            onCommit={() => {
              const recordId = recordIds[editor.row];
              const field = fields[editor.col];
              if (!recordId || !field) {
                setEditor(null);
                return;
              }
              const rec = store.getRecord(recordId);
              const clientMutationId = generateUuidV7();
              let value: CellValue | null = editor.draft.trim();
              if (field.type === "checkbox") value = editor.draft === "true";
              if (field.type === "number") {
                const n = Number(editor.draft);
                value = Number.isFinite(n) ? n : null;
              }
              if (field.type !== "checkbox" && !editor.draft.trim()) value = null;
              onCommitCell({
                recordId,
                fieldId: field.id,
                value,
                version: rec?.version ?? 0,
                clientMutationId,
              });
              setEditor(null);
            }}
            onCancel={() => setEditor(null)}
          />
        </div>
      ) : null}
    </div>
  );
}

/** Sync record ids from DTO list into store window. */
export function syncStoreWindow(
  store: RecordStore,
  queryHash: string,
  records: RecordDto[],
  startRow: number,
): string[] {
  store.ingestQueryPage(
    queryHash,
    startRow,
    records.map((r) => ({
      id: r.id,
      version: r.version,
      fields: r.fields as Record<string, CellValue | null>,
    })),
  );
  return records.map((r) => r.id);
}
