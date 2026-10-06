import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type ViewDto } from "../lib/api.ts";
import { BaseSessionProvider } from "../features/base/BaseSessionProvider.tsx";
import { PresenceAvatars } from "../features/base/PresenceAvatars.tsx";
import { ToolsMenu } from "../features/base/ToolsMenu.tsx";
import { NotificationsBell } from "../features/notifications/NotificationsBell.tsx";
import { ImportWizard } from "../features/import/ImportWizard.tsx";
import { ShareDialog } from "../features/share/ShareDialog.tsx";
import { ViewsSidebar } from "../features/views/ViewsSidebar.tsx";
import type { ViewKind } from "../features/views/view-types.ts";
import { AutomationsPanel } from "../features/automations/AutomationsPanel.tsx";
import { TableGridPage } from "./table-grid.tsx";
import styles from "./base.module.css";

type BaseTab = "data" | "automations" | "interfaces" | "forms";

export function BasePage({ baseId }: { baseId: string }) {
  const queryClient = useQueryClient();
  const baseQuery = useQuery({
    queryKey: ["bases", baseId],
    queryFn: () => api.getBase(baseId),
  });

  const undoMutation = useMutation({
    mutationFn: () => api.undoBase(baseId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["bases", baseId] });
      void queryClient.invalidateQueries({ queryKey: ["records", baseId] });
    },
  });

  const createTableMutation = useMutation({
    mutationFn: (name: string) => api.createTable(baseId, name),
    onSuccess: async (res) => {
      await queryClient.invalidateQueries({ queryKey: ["bases", baseId] });
      setActiveTableId(res.table.id);
      setBaseTab("data");
    },
  });

  const tables = baseQuery.data?.tables ?? [];
  const [baseTab, setBaseTab] = useState<BaseTab>("data");
  const [activeTableId, setActiveTableId] = useState<string | null>(null);
  const [activeViewId, setActiveViewId] = useState<string | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [manageFieldsSignal, setManageFieldsSignal] = useState(0);

  const resolvedTableId = activeTableId ?? tables[0]?.id ?? null;
  const activeTable = tables.find((t) => t.id === resolvedTableId) ?? null;

  const viewsQuery = useQuery({
    queryKey: ["views", baseId, resolvedTableId],
    queryFn: () => api.listViews(baseId, resolvedTableId!),
    enabled: Boolean(resolvedTableId) && baseTab === "data",
  });

  const views: ViewDto[] = useMemo(() => {
    if (viewsQuery.data?.views?.length) return viewsQuery.data.views;
    return activeTable?.views ?? [];
  }, [viewsQuery.data, activeTable]);

  useEffect(() => {
    if (!views.length) {
      setActiveViewId(null);
      return;
    }
    if (!activeViewId || !views.some((v) => v.id === activeViewId)) {
      const fav = views.find((v) => v.isFavorite);
      setActiveViewId(fav?.id ?? views[0]?.id ?? null);
    }
  }, [views, activeViewId]);

  const activeView = views.find((v) => v.id === activeViewId) ?? views[0];

  const createViewMutation = useMutation({
    mutationFn: (args: {
      type: ViewKind;
      visibility: "personal" | "collaborative";
    }) => {
      if (!resolvedTableId) throw new Error("No table");
      const label =
        args.type.charAt(0).toUpperCase() + args.type.slice(1).replace("_", " ");
      return api.createView(baseId, resolvedTableId, {
        name: `${label} view`,
        type: args.type === "timeline" || args.type === "gantt" || args.type === "list"
          ? "grid"
          : args.type,
        visibility: args.visibility,
      });
    },
    onSuccess: async (res) => {
      await queryClient.invalidateQueries({
        queryKey: ["views", baseId, resolvedTableId],
      });
      await queryClient.invalidateQueries({ queryKey: ["bases", baseId] });
      setActiveViewId(res.view.id);
    },
  });

  const favoriteMutation = useMutation({
    mutationFn: async (view: ViewDto) => {
      if (!resolvedTableId) throw new Error("No table");
      if (view.isFavorite) {
        return api.unfavoriteView(baseId, resolvedTableId, view.id);
      }
      return api.favoriteView(baseId, resolvedTableId, view.id);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ["views", baseId, resolvedTableId],
      });
      await queryClient.invalidateQueries({ queryKey: ["bases", baseId] });
    },
  });

  const onResync = useCallback(() => {
    void baseQuery.refetch();
    void queryClient.invalidateQueries({ queryKey: ["records", baseId] });
  }, [baseId, baseQuery, queryClient]);

  if (baseQuery.isLoading) {
    return <p className={styles.empty}>Loading base…</p>;
  }

  if (baseQuery.isError || !baseQuery.data) {
    return <p className={styles.empty}>Could not load this base.</p>;
  }

  return (
    <BaseSessionProvider baseId={baseId} onResync={onResync}>
      <div className={styles.shell}>
        <header className={styles.topBar}>
          <div className={styles.brand}>
            <Link to="/" className={styles.homeLink} title="Home">
              ←
            </Link>
            <span className={styles.logo} aria-hidden>
              T
            </span>
            <h1 className={styles.baseTitle}>{baseQuery.data.name}</h1>
          </div>

          <nav className={styles.navTabs} aria-label="Base sections">
            {(
              [
                ["data", "Data"],
                ["automations", "Automations"],
                ["interfaces", "Interfaces"],
                ["forms", "Forms"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                className={
                  baseTab === id
                    ? `${styles.navTab} ${styles.navTabActive}`
                    : styles.navTab
                }
                onClick={() => setBaseTab(id)}
              >
                {label}
              </button>
            ))}
          </nav>

          <div className={styles.topActions}>
            <PresenceAvatars />
            <NotificationsBell />
            <button
              type="button"
              className={styles.ghostBtn}
              disabled={undoMutation.isPending}
              onClick={() => undoMutation.mutate()}
            >
              Undo
            </button>
            {activeTable ? (
              <button
                type="button"
                className={styles.shareBtn}
                onClick={() => setShareOpen(true)}
              >
                Share
              </button>
            ) : null}
          </div>
        </header>

        {baseTab === "data" ? (
          <>
            <div className={styles.tableBar} role="tablist" aria-label="Tables">
              {tables.map((table) => (
                <button
                  key={table.id}
                  type="button"
                  role="tab"
                  aria-selected={table.id === resolvedTableId}
                  className={
                    table.id === resolvedTableId
                      ? `${styles.tableTab} ${styles.tableTabActive}`
                      : styles.tableTab
                  }
                  onClick={() => {
                    setActiveTableId(table.id);
                    setActiveViewId(null);
                  }}
                >
                  {table.name}
                </button>
              ))}
              <button
                type="button"
                className={styles.addTableBtn}
                title="Add table"
                disabled={createTableMutation.isPending}
                onClick={() => {
                  const name = window.prompt(
                    "New table name",
                    `Table ${tables.length + 1}`,
                  );
                  if (name?.trim()) {
                    createTableMutation.mutate(name.trim());
                  }
                }}
              >
                +
              </button>
              <div className={styles.tableBarSpacer} />
              <ToolsMenu
                onManageFields={() => setManageFieldsSignal((n) => n + 1)}
              />
            </div>

            <div className={styles.workspace}>
              {activeTable ? (
                <>
                  <ViewsSidebar
                    views={views}
                    activeViewId={activeView?.id ?? null}
                    onSelectView={setActiveViewId}
                    onCreateView={(type, visibility) =>
                      createViewMutation.mutate({ type, visibility })
                    }
                    onToggleFavorite={(view) => favoriteMutation.mutate(view)}
                    onJumpToOriginal={(view) => setActiveViewId(view.id)}
                  />
                  <div className={styles.content}>
                    <TableGridPage
                      baseId={baseId}
                      table={activeTable}
                      {...(activeView ? { activeView } : {})}
                      manageFieldsSignal={manageFieldsSignal}
                      onOpenShare={() => setShareOpen(true)}
                      onOpenImport={() => setImportOpen(true)}
                      onSchemaChange={() => {
                        void baseQuery.refetch();
                      }}
                    />
                  </div>
                </>
              ) : (
                <p className={styles.empty}>
                  This base has no tables yet. Click + to add one.
                </p>
              )}
            </div>
          </>
        ) : null}

        {baseTab === "automations" ? (
          <AutomationsPanel baseId={baseId} />
        ) : null}

        {baseTab === "interfaces" ? (
          <p className={styles.empty}>
            Interfaces builder ships in a later phase. Use Data views for now.
          </p>
        ) : null}

        {baseTab === "forms" ? (
          <p className={styles.empty}>
            Create a Form view from the views sidebar to collect submissions.
          </p>
        ) : null}
      </div>

      {shareOpen && activeTable ? (
        <ShareDialog
          baseId={baseId}
          tableId={activeTable.id}
          {...(activeView?.id ? { viewId: activeView.id } : {})}
          {...(activeView?.type ? { viewType: activeView.type } : {})}
          onClose={() => setShareOpen(false)}
        />
      ) : null}
      {importOpen && activeTable ? (
        <ImportWizard
          baseId={baseId}
          tableId={activeTable.id}
          onClose={() => setImportOpen(false)}
          onDone={() => {
            void queryClient.invalidateQueries({
              queryKey: ["records", baseId],
            });
          }}
        />
      ) : null}
    </BaseSessionProvider>
  );
}
