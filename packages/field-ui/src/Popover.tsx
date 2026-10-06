import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { ensureFieldUiStyles } from "./styles.js";

/**
 * Fixed-position popover anchored to an element. Uses `position: fixed`, so it
 * escapes overflow clipping as long as no ancestor has a transform.
 */
export function Popover({
  anchor,
  onClose,
  children,
  width,
  align = "start",
}: {
  anchor: HTMLElement | null;
  onClose: () => void;
  children: ReactNode;
  width?: number;
  align?: "start" | "end";
}): ReactElement | null {
  ensureFieldUiStyles();
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useLayoutEffect(() => {
    if (!anchor) return;
    const place = () => {
      const r = anchor.getBoundingClientRect();
      const el = ref.current;
      const h = el?.offsetHeight ?? 260;
      const w = el?.offsetWidth ?? width ?? 240;
      let top = r.bottom + 4;
      if (top + h > window.innerHeight - 8 && r.top - h - 4 > 8) top = r.top - h - 4;
      let left = align === "end" ? r.right - w : r.left;
      left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
      setPos({ top, left });
    };
    place();
    const raf = requestAnimationFrame(place);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [anchor, width, align]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t)) return;
      if (anchor?.contains(t)) return;
      // Clicks inside another field-ui overlay (e.g. a modal opened from here) don't close.
      if ((t as Element).closest?.(".tfu-modal-back")) return;
      onCloseRef.current();
    };
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  }, [anchor]);

  if (!anchor) return null;
  return (
    <div
      ref={ref}
      className="tfu-pop"
      style={{
        top: pos?.top ?? -9999,
        left: pos?.left ?? -9999,
        ...(width ? { width } : {}),
      }}
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      {children}
    </div>
  );
}

export interface MenuItem {
  key: string;
  label: ReactNode;
  /** Text used for filtering. */
  text: string;
  selected?: boolean;
}

/** Searchable list used by select/collaborator pickers. */
export function SearchableList({
  items,
  onPick,
  onCreate,
  placeholder = "Find an option",
  emptyText = "No options",
  onEscape,
  createLabel,
}: {
  items: MenuItem[];
  onPick: (key: string) => void;
  onCreate?: ((text: string) => void) | undefined;
  placeholder?: string;
  emptyText?: string;
  onEscape?: () => void;
  createLabel?: (text: string) => string;
}): ReactElement {
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const query = q.trim().toLowerCase();
  const filtered = query ? items.filter((i) => i.text.toLowerCase().includes(query)) : items;
  const exact = items.some((i) => i.text.toLowerCase() === query);
  const canCreate = !!onCreate && query.length > 0 && !exact;
  const total = filtered.length + (canCreate ? 1 : 0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setActive(0);
  }, [query]);

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(".tfu-pop-item.active");
    el?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const pick = (idx: number) => {
    if (idx < filtered.length) onPick(filtered[idx]!.key);
    else if (canCreate) onCreate?.(q.trim());
  };

  return (
    <>
      <input
        className="tfu-input"
        autoFocus
        value={q}
        placeholder={placeholder}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((a) => Math.min(total - 1, a + 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((a) => Math.max(0, a - 1));
          } else if (e.key === "Enter") {
            e.preventDefault();
            if (total > 0) pick(active);
          } else if (e.key === "Escape") {
            e.preventDefault();
            onEscape?.();
          } else if (e.key === "Tab") {
            e.preventDefault();
            onEscape?.();
          }
        }}
      />
      <div className="tfu-pop-list" ref={listRef}>
        {filtered.map((item, idx) => (
          <button
            key={item.key}
            type="button"
            className={`tfu-pop-item ${idx === active ? "active" : ""}`}
            onMouseEnter={() => setActive(idx)}
            onClick={() => pick(idx)}
          >
            <span style={{ width: 14, flex: "none", color: "#0d9488" }}>{item.selected ? "✓" : ""}</span>
            {item.label}
          </button>
        ))}
        {canCreate ? (
          <button
            type="button"
            className={`tfu-pop-item ${active === filtered.length ? "active" : ""}`}
            onMouseEnter={() => setActive(filtered.length)}
            onClick={() => pick(filtered.length)}
          >
            <span style={{ width: 14, flex: "none" }}>+</span>
            {createLabel ? createLabel(q.trim()) : `Create "${q.trim()}"`}
          </button>
        ) : null}
        {total === 0 ? <div className="tfu-pop-empty">{emptyText}</div> : null}
      </div>
    </>
  );
}
