import { useState } from "react";
import type { FieldDto } from "../../lib/api.ts";
import type { FilterAst } from "../../lib/api.ts";
import styles from "./views.module.css";

export interface ViewToolbarProps {
  viewName: string;
  fields: FieldDto[];
  hiddenFieldIds: string[];
  onHiddenFieldsChange: (ids: string[]) => void;
  filterConditions: Array<{
    fieldId: string;
    op: string;
    value: string;
  }>;
  onFilterChange: (
    conditions: Array<{ fieldId: string; op: string; value: string }>,
  ) => void;
  groupFieldId: string;
  onGroupChange: (fieldId: string) => void;
  sortFieldId: string;
  sortDirection: "asc" | "desc";
  onSortChange: (fieldId: string, direction: "asc" | "desc") => void;
  colorFieldId: string;
  onColorChange: (fieldId: string) => void;
  rowHeight: "short" | "medium" | "tall" | "extra";
  onRowHeightChange: (height: "short" | "medium" | "tall" | "extra") => void;
  searchQuery: string;
  onSearchChange: (q: string) => void;
  onShare: () => void;
}

export function buildFilterAst(
  conditions: Array<{ fieldId: string; op: string; value: string }>,
): FilterAst | undefined {
  const children = conditions
    .filter((c) => c.fieldId)
    .map(
      (c): FilterAst => ({
        kind: "condition",
        fieldId: c.fieldId,
        op: c.op,
        value: c.value || undefined,
      }),
    );
  if (children.length === 0) return undefined;
  return { kind: "and", children };
}

type Panel =
  | null
  | "hide"
  | "filter"
  | "group"
  | "sort"
  | "color"
  | "height"
  | "search";

export function ViewToolbar({
  viewName,
  fields,
  hiddenFieldIds,
  onHiddenFieldsChange,
  filterConditions,
  onFilterChange,
  groupFieldId,
  onGroupChange,
  sortFieldId,
  sortDirection,
  onSortChange,
  colorFieldId,
  onColorChange,
  rowHeight,
  onRowHeightChange,
  searchQuery,
  onSearchChange,
  onShare,
}: ViewToolbarProps) {
  const [panel, setPanel] = useState<Panel>(null);
  const activeFilters = filterConditions.filter((c) => c.fieldId).length;
  const hiddenCount = hiddenFieldIds.length;

  function togglePanel(next: Panel) {
    setPanel((p) => (p === next ? null : next));
  }

  return (
    <div className={styles.toolbarShell}>
      <div className={styles.toolbar}>
        <div className={styles.viewTitle}>
          <span className={styles.viewTitleIcon}>▦</span>
          <strong>{viewName}</strong>
        </div>

        <div className={styles.pillRow}>
          <button
            type="button"
            className={
              hiddenCount > 0
                ? `${styles.pill} ${styles.pillActiveBlue}`
                : styles.pill
            }
            onClick={() => togglePanel("hide")}
          >
            {hiddenCount > 0 ? `${hiddenCount} hidden fields` : "Hide fields"}
          </button>
          <button
            type="button"
            className={
              activeFilters > 0
                ? `${styles.pill} ${styles.pillActiveGreen}`
                : styles.pill
            }
            onClick={() => togglePanel("filter")}
          >
            {activeFilters > 0 ? "Filtered" : "Filter"}
          </button>
          <button
            type="button"
            className={groupFieldId ? `${styles.pill} ${styles.pillActive}` : styles.pill}
            onClick={() => togglePanel("group")}
          >
            Group
          </button>
          <button
            type="button"
            className={sortFieldId ? `${styles.pill} ${styles.pillActive}` : styles.pill}
            onClick={() => togglePanel("sort")}
          >
            Sort
          </button>
          <button
            type="button"
            className={colorFieldId ? `${styles.pill} ${styles.pillActive}` : styles.pill}
            onClick={() => togglePanel("color")}
          >
            Color
          </button>
          <button
            type="button"
            className={styles.pill}
            onClick={() => togglePanel("height")}
            title="Row height"
          >
            Row height
          </button>
          <button type="button" className={styles.pill} onClick={onShare}>
            Share and sync
          </button>
          <button
            type="button"
            className={styles.iconPill}
            aria-label="Search table"
            onClick={() => togglePanel("search")}
          >
            ⌕
          </button>
        </div>
      </div>

      {panel === "hide" ? (
        <div className={styles.panel}>
          {fields.map((f) => {
            const hidden = hiddenFieldIds.includes(f.id);
            return (
              <label key={f.id} className={styles.checkRow}>
                <input
                  type="checkbox"
                  checked={!hidden}
                  onChange={(e) => {
                    if (e.target.checked) {
                      onHiddenFieldsChange(
                        hiddenFieldIds.filter((id) => id !== f.id),
                      );
                    } else {
                      onHiddenFieldsChange([...hiddenFieldIds, f.id]);
                    }
                  }}
                />
                {f.name}
              </label>
            );
          })}
        </div>
      ) : null}

      {panel === "filter" ? (
        <div className={styles.panel}>
          {filterConditions.map((cond, index) => (
            <div key={index} className={styles.filterRow}>
              <select
                value={cond.fieldId}
                onChange={(e) => {
                  const next = [...filterConditions];
                  next[index] = { ...cond, fieldId: e.target.value };
                  onFilterChange(next);
                }}
              >
                <option value="">Field…</option>
                {fields.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
              <select
                value={cond.op}
                onChange={(e) => {
                  const next = [...filterConditions];
                  next[index] = { ...cond, op: e.target.value };
                  onFilterChange(next);
                }}
              >
                <option value="contains">contains</option>
                <option value="eq">equals</option>
                <option value="empty">empty</option>
                <option value="notEmpty">not empty</option>
              </select>
              <input
                type="text"
                placeholder="Value"
                value={cond.value}
                onChange={(e) => {
                  const next = [...filterConditions];
                  next[index] = { ...cond, value: e.target.value };
                  onFilterChange(next);
                }}
              />
              <button
                type="button"
                className={styles.removeCondition}
                aria-label={`Remove condition ${index + 1}`}
                title="Remove condition"
                onClick={() => {
                  const next = filterConditions.filter((_, i) => i !== index);
                  onFilterChange(
                    next.length > 0
                      ? next
                      : [{ fieldId: "", op: "contains", value: "" }],
                  );
                }}
              >
                ✕
              </button>
            </div>
          ))}
          <button
            type="button"
            className={styles.panelAction}
            onClick={() =>
              onFilterChange([
                ...filterConditions,
                { fieldId: "", op: "contains", value: "" },
              ])
            }
          >
            + Add condition
          </button>
          {activeFilters > 0 ? (
            <button
              type="button"
              className={styles.panelAction}
              onClick={() =>
                onFilterChange([{ fieldId: "", op: "contains", value: "" }])
              }
            >
              Clear filters
            </button>
          ) : null}
        </div>
      ) : null}

      {panel === "group" ? (
        <div className={styles.panel}>
          <select
            value={groupFieldId}
            onChange={(e) => onGroupChange(e.target.value)}
          >
            <option value="">No grouping</option>
            {fields.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </div>
      ) : null}

      {panel === "sort" ? (
        <div className={styles.panel}>
          <div className={styles.filterRow}>
            <select
              value={sortFieldId}
              onChange={(e) => onSortChange(e.target.value, sortDirection)}
            >
              <option value="">Default order</option>
              {fields.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
            <select
              value={sortDirection}
              onChange={(e) =>
                onSortChange(sortFieldId, e.target.value as "asc" | "desc")
              }
            >
              <option value="asc">A → Z</option>
              <option value="desc">Z → A</option>
            </select>
          </div>
        </div>
      ) : null}

      {panel === "color" ? (
        <div className={styles.panel}>
          <select
            value={colorFieldId}
            onChange={(e) => onColorChange(e.target.value)}
          >
            <option value="">No color</option>
            {fields
              .filter((f) => f.type === "single_select" || f.type === "status")
              .map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            {fields.every(
              (f) => f.type !== "single_select" && f.type !== "status",
            )
              ? fields.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))
              : null}
          </select>
        </div>
      ) : null}

      {panel === "height" ? (
        <div className={styles.panel}>
          {(["short", "medium", "tall", "extra"] as const).map((h) => (
            <label key={h} className={styles.checkRow}>
              <input
                type="radio"
                name="rowHeight"
                checked={rowHeight === h}
                onChange={() => onRowHeightChange(h)}
              />
              {h}
            </label>
          ))}
        </div>
      ) : null}

      {panel === "search" ? (
        <div className={styles.panel}>
          <input
            autoFocus
            className={styles.searchInput}
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Search this table…"
          />
        </div>
      ) : null}
    </div>
  );
}
