import { useMemo, useState } from "react";
import type { ViewDto } from "../../lib/api.ts";
import { VIEW_CREATE_OPTIONS, type ViewKind } from "./view-types.ts";
import styles from "./views-sidebar.module.css";

export function ViewsSidebar({
  views,
  activeViewId,
  onSelectView,
  onCreateView,
  onToggleFavorite,
  onJumpToOriginal,
}: {
  views: ViewDto[];
  activeViewId: string | null;
  onSelectView: (viewId: string) => void;
  onCreateView: (type: ViewKind, visibility: "personal" | "collaborative") => void;
  onToggleFavorite: (view: ViewDto) => void;
  onJumpToOriginal: (view: ViewDto) => void;
}) {
  const [query, setQuery] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [menuViewId, setMenuViewId] = useState<string | null>(null);
  const [sectionsOpen, setSectionsOpen] = useState({
    favorites: true,
    personal: true,
    collaborative: true,
  });

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return views;
    return views.filter((v) => v.name.toLowerCase().includes(q));
  }, [views, query]);

  const favorites = filtered.filter((v) => v.isFavorite);
  const personal = filtered.filter(
    (v) => v.visibility === "personal" || (v.isMine && v.visibility !== "collaborative"),
  );
  const collaborative = filtered.filter(
    (v) =>
      (v.visibility ?? "collaborative") === "collaborative" ||
      v.visibility === "locked",
  );

  function renderViewRow(view: ViewDto, favoriteMenu: boolean) {
    const active = view.id === activeViewId;
    return (
      <div
        key={view.id}
        className={active ? `${styles.viewItem} ${styles.viewItemActive}` : styles.viewItem}
      >
        <button
          type="button"
          className={styles.viewBtn}
          onClick={() => onSelectView(view.id)}
        >
          <span className={styles.viewIcon} aria-hidden data-type={view.type ?? "grid"}>
            ▦
          </span>
          <span className={styles.viewName}>{view.name}</span>
        </button>
        <button
          type="button"
          className={styles.moreBtn}
          aria-label={`Options for ${view.name}`}
          onClick={(e) => {
            e.stopPropagation();
            setMenuViewId(menuViewId === view.id ? null : view.id);
          }}
        >
          ⋯
        </button>
        {menuViewId === view.id ? (
          <div className={styles.menu} role="menu">
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                onToggleFavorite(view);
                setMenuViewId(null);
              }}
            >
              {view.isFavorite || favoriteMenu
                ? "Remove from ‘My favorites’"
                : "Add to ‘My favorites’"}
            </button>
            {(view.isFavorite || favoriteMenu) && view.visibility === "personal" ? (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  onJumpToOriginal(view);
                  setMenuViewId(null);
                }}
              >
                Jump to original…
              </button>
            ) : null}
            {view.isMine ? (
              <button
                type="button"
                role="menuitem"
                onClick={() => setMenuViewId(null)}
              >
                Rename view
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <aside className={styles.sidebar}>
      <div className={styles.createWrap}>
        <button
          type="button"
          className={styles.createBtn}
          onClick={() => setCreateOpen((o) => !o)}
        >
          + Create new…
        </button>
        {createOpen ? (
          <div className={styles.createMenu} role="menu">
            {VIEW_CREATE_OPTIONS.map((opt) => (
              <button
                key={opt.id}
                type="button"
                role="menuitem"
                className={styles.createItem}
                onClick={() => {
                  onCreateView(opt.id, "personal");
                  setCreateOpen(false);
                }}
              >
                <span className={styles.createIcon} style={{ color: opt.color }}>
                  {opt.icon}
                </span>
                {opt.label}
              </button>
            ))}
            <hr className={styles.divider} />
            <button
              type="button"
              role="menuitem"
              className={styles.createItem}
              onClick={() => {
                onCreateView("grid", "collaborative");
                setCreateOpen(false);
              }}
            >
              <span className={styles.createIcon}>▦</span>
              Collaborative grid
            </button>
          </div>
        ) : null}
      </div>

      <div className={styles.findRow}>
        <input
          className={styles.findInput}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Find a view"
          aria-label="Find a view"
        />
      </div>

      <section className={styles.section}>
        <button
          type="button"
          className={styles.sectionHead}
          onClick={() =>
            setSectionsOpen((s) => ({ ...s, favorites: !s.favorites }))
          }
        >
          <span className={styles.star}>★</span> My favorites
        </button>
        {sectionsOpen.favorites
          ? favorites.map((v) => renderViewRow(v, true))
          : null}
      </section>

      <section className={styles.section}>
        <button
          type="button"
          className={styles.sectionHead}
          onClick={() =>
            setSectionsOpen((s) => ({ ...s, personal: !s.personal }))
          }
        >
          ▾ My personal views
        </button>
        {sectionsOpen.personal
          ? personal.map((v) => renderViewRow(v, false))
          : null}
      </section>

      <section className={styles.section}>
        <button
          type="button"
          className={styles.sectionHead}
          onClick={() =>
            setSectionsOpen((s) => ({
              ...s,
              collaborative: !s.collaborative,
            }))
          }
        >
          ▾ Collaborative views
        </button>
        {sectionsOpen.collaborative
          ? collaborative.map((v) => renderViewRow(v, false))
          : null}
      </section>
    </aside>
  );
}
