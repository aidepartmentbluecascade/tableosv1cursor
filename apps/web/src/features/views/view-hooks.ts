import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FilterAst, TableDto, ViewDto } from "../../lib/api.ts";
import {
  viewConfigOf,
  viewRecordsApi,
  viewsApi,
  type ViewConfig,
  type ViewRecord,
  type ViewWire,
} from "../../lib/api-areas/views.ts";
import { andFilters, cleanFilter, patchViewInCaches } from "./view-utils.ts";

const SAVE_DEBOUNCE_MS = 450;

/**
 * View configuration state. The React Query cache is the source of truth;
 * edits are applied optimistically to `["bases", baseId]` and
 * `["views", baseId, tableId]` and persisted with a debounced PATCH.
 */
export function useViewConfig(baseId: string, tableId: string, view: ViewDto | undefined) {
  const qc = useQueryClient();
  const viewId = view?.id ?? null;
  const pendingRef = useRef<{ viewId: string; patch: Partial<ViewConfig> } | null>(null);
  const timerRef = useRef<number | null>(null);
  const [overlay, setOverlay] = useState<{ viewId: string; patch: Partial<ViewConfig> } | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const flush = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const pending = pendingRef.current;
    if (!pending) return;
    pendingRef.current = null;
    const sent = pending.patch;
    viewsApi
      .patch(baseId, tableId, pending.viewId, { config: sent })
      .then(() => {
        setSaveError(null);
        setOverlay((cur) => {
          if (!cur || cur.viewId !== pending.viewId) return cur;
          // Drop keys that weren't changed again since this save.
          const rest: Partial<ViewConfig> = { ...cur.patch };
          for (const k of Object.keys(sent) as (keyof ViewConfig)[]) {
            if (rest[k] === sent[k]) delete rest[k];
          }
          return Object.keys(rest).length ? { viewId: cur.viewId, patch: rest } : null;
        });
      })
      .catch((err: unknown) => {
        setSaveError(err instanceof Error ? err.message : "Could not save view");
        setOverlay(null);
        void qc.invalidateQueries({ queryKey: ["bases", baseId] });
        void qc.invalidateQueries({ queryKey: ["views", baseId, tableId] });
      });
  }, [baseId, tableId, qc]);

  // Save immediately when switching views/tables or unmounting.
  useEffect(() => {
    return () => flush();
  }, [viewId, flush]);

  const serverConfig = useMemo(() => viewConfigOf(view), [view]);
  const config: ViewConfig = useMemo(
    () =>
      overlay && overlay.viewId === viewId
        ? { ...serverConfig, ...overlay.patch }
        : serverConfig,
    [serverConfig, overlay, viewId],
  );
  const canEdit = (view as ViewWire | undefined)?.canEdit !== false;

  const update = useCallback(
    (patch: Partial<ViewConfig>) => {
      if (!viewId || !canEdit) return;
      const prev = pendingRef.current?.viewId === viewId ? pendingRef.current.patch : {};
      pendingRef.current = { viewId, patch: { ...prev, ...patch } };
      setOverlay((cur) => ({
        viewId,
        patch: { ...(cur && cur.viewId === viewId ? cur.patch : {}), ...patch },
      }));
      patchViewInCaches(qc, baseId, tableId, viewId, (v) => ({
        ...v,
        config: { ...viewConfigOf(v), ...(v.config ?? {}), ...patch },
      }));
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(flush, SAVE_DEBOUNCE_MS);
    },
    [viewId, canEdit, qc, baseId, tableId, flush],
  );

  return { config, update, canEdit, saveError };
}

/** Effective query inputs derived from config + search. */
export function effectiveQuery(config: ViewConfig, extraFilter?: FilterAst | null) {
  const filter = andFilters(cleanFilter(config.filter), extraFilter ?? null);
  const sort = config.sorts
    .filter((s) => s.fieldId)
    .map((s) => ({ field: s.fieldId, direction: s.direction }));
  return { filter, sort };
}

/** Records for non-grid views (filter/sort from config, server-side search). */
export function useViewRecords(
  baseId: string,
  table: TableDto,
  viewId: string | undefined,
  config: ViewConfig,
  search: string,
  opts: { extraFilter?: FilterAst | null; enabled?: boolean } = {},
) {
  const { filter, sort } = effectiveQuery(config, opts.extraFilter);
  const term = search.trim();
  const queryKey = ["records", baseId, table.id, "view", viewId ?? null, filter, sort, term];
  const query = useQuery({
    queryKey,
    queryFn: () =>
      viewRecordsApi.queryAll(baseId, table.id, {
        filter,
        sort,
        search: term,
        ...(viewId ? { viewId } : {}),
      }),
    enabled: opts.enabled !== false,
    placeholderData: (prev) => prev,
  });
  const records = useMemo(() => {
    const raw = query.data ?? [];
    if (!term) return raw;
    // Client-side guard in case the server ignores `search`.
    const q = term.toLowerCase();
    return raw.filter((r) =>
      Object.values(r.fields).some((v) => JSON.stringify(v ?? "").toLowerCase().includes(q)),
    );
  }, [query.data, term]);
  return { ...query, records, queryKey };
}

/** Optimistically update one record in a records query cache. */
export function useRecordCacheUpdater(queryKey: unknown[]) {
  const qc = useQueryClient();
  return useCallback(
    (recordId: string, fn: (r: ViewRecord) => ViewRecord) => {
      qc.setQueryData<ViewRecord[]>(queryKey, (old) =>
        old ? old.map((r) => (r.id === recordId ? fn(r) : r)) : old,
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [qc, JSON.stringify(queryKey)],
  );
}
