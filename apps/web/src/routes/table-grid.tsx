import { useMutation, useQueryClient } from "@tanstack/react-query";
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
import { useViewConfig, useViewRecords } from "../features/views/view-hooks.ts";
import type { ViewKind } from "../features/views/view-types.ts";
import { toRootGroup } from "../features/views/view-utils.ts";
import { RecordExpandDrawer } from "../features/record/RecordExpandDrawer.tsx";
import { AddFieldDialog } from "../features/schema/AddFieldDialog.tsx";
import { api, type FilterAst, type TableDto, type ViewDto } from "../lib/api.ts";
import type { ViewConfig } from "../lib/api-areas/views.ts";
import styles from "../features/grid/grid.module.css";

function conditionsFromFilter(filter: FilterAst | null) {
  const conds = toRootGroup(filter).children.filter(
    (c): c is Extract<FilterAst, { kind: "condition" }> => c.kind === "condition",
  );
  if (conds.length === 0) {
    return [{ fieldId: "", op: "contains", value: "" }];
  }
  return conds.map((c) => ({
    fieldId: c.fieldId,
    op: c.op,
    value: typeof c.value === "string" ? c.value : c.value == null ? "" : String(c.value),
  }));
}

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
  const { config, update } = useViewConfig(baseId, table.id, activeView);
  const [searchQuery, setSearchQuery] = useState("");
  const [drawerRecordId, setDrawerRecordId] = useState<string | null>(null);
  const [addFieldOpen, setAddFieldOpen] = useState(false);

  useEffect(() => {
    if (manageFieldsSignal > 0) setAddFieldOpen(true);
  }, [manageFieldsSignal]);

  useEffect(() => {
    void onOpenImport;
  }, [onOpenImport]);

  const hiddenFieldIds = config.hiddenFieldIds;
  const visibleFields = useMemo(
    () => fields.filter((f) => !hiddenFieldIds.includes(f.id)),
    [fields, hiddenFieldIds],
  );
  const tableForGrid = useMemo(
    () => ({ ...table, fields: visibleFields }),
    [table, visibleFields],
  );

  const filter = config.filter ?? undefined;
  const sort =
    config.sorts.length > 0
      ? config.sorts
          .filter((s) => s.fieldId)
          .map((s) => ({ field: s.fieldId, direction: s.direction }))
      : undefined;
  const groupFieldId = config.groups[0]?.fieldId ?? "";
  const colorFieldId = config.color.mode === "select" ? config.color.fieldId : "";
  const rowHeight = config.rowHeight;
  const filterConditions = useMemo(
    () => conditionsFromFilter(config.filter),
    [config.filter],
  );

  const recordsQuery = useViewRecords(
    baseId,
    table,
    activeView?.id,
    config,
    searchQuery,
    { enabled: viewKind !== "grid" },
  );
  const records = recordsQuery.records;

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
        onHiddenFieldsChange={(ids) => update({ hiddenFieldIds: ids })}
        filterConditions={filterConditions}
        onFilterChange={(conditions) =>
          update({ filter: (buildFilterAst(conditions) ?? null) as ViewConfig["filter"] })
        }
        groupFieldId={groupFieldId}
        onGroupChange={(fieldId) =>
          update({ groups: fieldId ? [{ fieldId, direction: "asc" }] : [] })
        }
        sortFieldId={config.sorts[0]?.fieldId ?? ""}
        sortDirection={config.sorts[0]?.direction ?? "asc"}
        onSortChange={(fieldId, direction) =>
          update({ sorts: fieldId ? [{ fieldId, direction }] : [] })
        }
        colorFieldId={colorFieldId}
        onColorChange={(fieldId) =>
          update({
            color: fieldId ? { mode: "select", fieldId } : { mode: "none" },
          })
        }
        rowHeight={rowHeight}
        onRowHeightChange={(height) => update({ rowHeight: height })}
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
          filter={filter}
          sort={sort}
          search={searchQuery}
        />
      ) : null}

      {viewKind === "gallery" ? (
        <GalleryView
          table={table}
          records={records}
          onOpenRecord={setDrawerRecordId}
        />
      ) : null}
      {viewKind === "kanban" ? (
        <KanbanView
          table={table}
          records={records}
          stackFieldId={config.kanban?.stackFieldId ?? null}
          onOpenRecord={setDrawerRecordId}
        />
      ) : null}
      {viewKind === "calendar" ? (
        <CalendarView
          table={table}
          records={records}
          dateFieldId={config.calendar?.dateFieldId ?? null}
          onOpenRecord={setDrawerRecordId}
        />
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
