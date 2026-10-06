import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Input } from "@tabula/ui";
import { api } from "../../lib/api.ts";
import styles from "./search-palette.module.css";

export function SearchPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [q, setQ] = useState("");
  const navigate = useNavigate();

  useEffect(() => {
    if (!open) setQ("");
  }, [open]);

  const searchQuery = useQuery({
    queryKey: ["search", q],
    queryFn: () => api.search(q),
    enabled: open && q.trim().length > 0,
  });

  if (!open) return null;

  return (
    <div className={styles.backdrop} role="presentation" onClick={onClose}>
      <div
        className={styles.panel}
        role="dialog"
        aria-label="Search"
        onClick={(e) => e.stopPropagation()}
      >
        <Input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search bases…"
          aria-label="Search query"
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose();
          }}
        />
        <ul className={styles.results}>
          {(searchQuery.data?.results ?? []).map((r) => (
            <li key={`${r.kind}-${r.id}`}>
              <button
                type="button"
                className={styles.resultBtn}
                onClick={() => {
                  if (r.kind === "base" && r.id) {
                    void navigate({
                      to: "/bases/$baseId",
                      params: { baseId: r.id },
                    });
                    onClose();
                  }
                }}
              >
                <span className={styles.kind}>{r.kind}</span>
                {r.title}
              </button>
            </li>
          ))}
          {q.trim() && searchQuery.isSuccess && (searchQuery.data?.results ?? []).length === 0 ? (
            <li className={styles.empty}>No results</li>
          ) : null}
        </ul>
      </div>
    </div>
  );
}

export function useSearchPaletteShortcut(onOpen: () => void) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        onOpen();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onOpen]);
}
