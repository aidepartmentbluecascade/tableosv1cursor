import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { DomGrid } from "../features/grid/DomGrid.tsx";
import { CalendarView } from "../features/views/CalendarView.tsx";
import { FormView } from "../features/views/FormView.tsx";
import { GalleryView } from "../features/views/GalleryView.tsx";
import { KanbanView } from "../features/views/KanbanView.tsx";
import {
  ViewToolbar,
  buildFilterAst,
} from "../features/views/ViewToolbar.tsx";
import type { ViewKind } from "../features/views/view-types.ts";
import { RecordExpandDrawer } from "../features/record/RecordExpandDrawer.tsx";
import { AddFieldDialog } from "../features/schema/AddFieldDialog.tsx";
import { api, type TableDto, type ViewDto } from "../lib/api.ts";
import styles from "../features/grid/grid.module.css";

export function TableGridPage({
  baseId,
  table,
  activeView,
  manageFieldsSignal = 0,
  onOpenShare,
  onOpenImport,
  onSchemaChange,
}: {
  baseId: string;
  table: TableDto;
  activeView?: ViewDto;
  manageFieldsSignal?: number;
  onOpenShare?: () => void;
  onOpenImport?: () => void;
  onSchemaChange: () => void;
}) {
  const queryClient = useQueryClient();
  const fields = useMemo(
    () => [...table.fields].sort((a, b) => a.slot - b.slot),
    [table.fields],
  );
  const viewKind = (activeView?.type as ViewKind | undefined) ?? "grid";
  const [filterConditions, setFilterConditions] = useState([
    { fieldId: "", op: "contains", value: "" },
  ]);
  const [sortFieldId, setSortFieldId] = useState("");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("asc");
  const [groupFieldId, setGroupFieldId] = useState("");
  const [colorFieldId, setColorFieldId] = useState("");
  const [rowHeight, setRowHeight] = useState<
    "short" | "medium" | "tall" | "extra"
  >("short");
  const [hiddenFieldIds, setHiddenFieldIds] = useState<string[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [drawerRecordId, setDrawerRecordId] = useState<string | null>(null);
  const [addFieldOpen, setAddFieldOpen] = useState(false);

  useEffect(() => {
    if (manageFieldsSignal > 0) setAddFieldOpen(true);
  }, [manageFieldsSignal]);

  useEffect(() => {
    void onOpenImport;
  }, [onOpenImport]);

  const visibleFields = useMemo(
    () => fields.filter((f) => !hiddenFieldIds.includes(f.id)),
    [fields, hiddenFieldIds],
  );
  const tableForGrid = useMemo(
    () => ({ ...table, fields: visibleFields }),
    [table, visibleFields],
  );

  const filter = buildFilterAst(filterConditions);
  const sort =
    sortFieldId.length > 0
      ? [{ field: sortFieldId, direction: sortDirection }]
      : undefined;

  const recordsQuery = useQuery({
    queryKey: [
      "records",
      baseId,
      table.id,
      filter,
      sort,
      viewKind,
      searchQuery,
    ],
    queryFn: () => {
      const body: Parameters<typeof api.queryRecords>[2] = {
        pageSize: 200,
        fields: fields.map((f) => f.id),
      };
      if (filter) body.filter = filter;
      if (sort) body.sort = sort;
      return api.queryRecords(baseId, table.id, body);
    },
    enabled: viewKind !== "grid",
  });

  const records = useMemo(() => {
    const raw = recordsQuery.data?.records ?? [];
    const q = searchQuery.trim().toLowerCase();
    if (!q) return raw;
    return raw.filter((r) =>
      Object.values(r.fields).some((v) =>
        String(v ?? "")
          .toLowerCase()
          .includes(q),
      ),
    );
  }, [recordsQuery.data, searchQuery]);

  const createRecord = useMutation({
    mutationFn: (payload: Record<string, unknown> = {}) => {
      const initial: Record<string, unknown> = { ...payload };
      if (Object.keys(initial).length === 0) {
        const primary = fields.find((f) => f.id === table.primaryFieldId);
        if (primary) initial[primary.id] = "";
      }
      return api.createRecord(baseId, table.id, initial);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["records", baseId, table.id],
      });
    },
  });

  const createField = useMutation({
    mutationFn: (body: {
      name: string;
      type: string;
      config?: Record<string, unknown>;
    }) => api.createField(baseId, table.id, body),
    onSuccess: () => {
      setAddFieldOpen(false);
      onSchemaChange();
      void queryClient.invalidateQueries({ queryKey: ["bases", baseId] });
    },
  });

  return (
    <div
      className={styles.wrap}
      style={{ paddingTop: 0 }}
      data-row-height={rowHeight}
      data-group={groupFieldId || undefined}
      data-color={colorFieldId || undefined}
    >
      <ViewToolbar
        viewName={activeView?.name ?? "Grid view"}
        fields={fields}
        hiddenFieldIds={hiddenFieldIds}
        onHiddenFieldsChange={setHiddenFieldIds}
        filterConditions={filterConditions}
        onFilterChange={setFilterConditions}
        groupFieldId={groupFieldId}
        onGroupChange={setGroupFieldId}
        sortFieldId={sortFieldId}
        sortDirection={sortDirection}
        onSortChange={(fieldId, direction) => {
          setSortFieldId(fieldId);
          setSortDirection(direction);
        }}
        colorFieldId={colorFieldId}
        onColorChange={setColorFieldId}
        rowHeight={rowHeight}
        onRowHeightChange={setRowHeight}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        onShare={() => onOpenShare?.()}
      />

      {viewKind === "grid" ? (
        <div className={styles.toolbar}>
          <button
            type="button"
            className={styles.primaryAction}
            disabled={createRecord.isPending || fields.length === 0}
            onClick={() => createRecord.mutate({})}
          >
            {createRecord.isPending ? "Adding row…" : "+ Add row"}
          </button>
          <button
            type="button"
            className={styles.secondaryAction}
            onClick={() => setAddFieldOpen(true)}
          >
            + Add field
          </button>
          {createRecord.isError ? (
            <span className={styles.statusError}>Could not add row. Try again.</span>
          ) : null}
          {createField.isError ? (
            <span className={styles.statusError}>Could not add field. Try again.</span>
          ) : null}
        </div>
      ) : null}

      {viewKind === "grid" ? (
        <DomGrid
          baseId={baseId}
          table={tableForGrid}
          onSchemaChange={onSchemaChange}
          hideChrome
        />
      ) : null}

      {viewKind === "gallery" ? (
        <GalleryView table={table} records={records} />
      ) : null}
      {viewKind === "kanban" ? (
        <KanbanView table={table} records={records} />
      ) : null}
      {viewKind === "calendar" ? (
        <CalendarView table={table} records={records} />
      ) : null}
      {viewKind === "form" ? (
        <FormView
          table={table}
          pending={createRecord.isPending}
          onCreate={(payload) => createRecord.mutate(payload)}
        />
      ) : null}
      {viewKind === "timeline" || viewKind === "list" || viewKind === "gantt" ? (
        <p className={styles.status}>
          {viewKind} layout is saved as a view; the spreadsheet grid is used for editing.
        </p>
      ) : null}

      {drawerRecordId ? (
        <RecordExpandDrawer
          baseId={baseId}
          tableId={table.id}
          recordId={drawerRecordId}
          onClose={() => setDrawerRecordId(null)}
        />
      ) : null}

      <AddFieldDialog
        open={addFieldOpen}
        pending={createField.isPending}
        onClose={() => setAddFieldOpen(false)}
        onSubmit={(body) => createField.mutate(body)}
      />
    </div>
  );
}
