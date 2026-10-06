import { useEffect, useRef, useState, type ReactElement } from "react";
import { useFieldUiServices } from "./services.js";
import { ensureFieldUiStyles } from "./styles.js";
import type { LinkRef } from "./types.js";

/** Modal dialog to pick records from the linked table (with create-new). */
export function LinkRecordPicker({
  tableId,
  tableName,
  selectedIds,
  allowMultiple,
  onPick,
  onClose,
}: {
  tableId: string;
  tableName?: string | undefined;
  selectedIds: string[];
  allowMultiple: boolean;
  onPick: (ref: LinkRef) => void;
  onClose: () => void;
}): ReactElement {
  ensureFieldUiStyles();
  const services = useFieldUiServices();
  const [q, setQ] = useState("");
  const [results, setResults] = useState<LinkRef[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [active, setActive] = useState(0);
  const seq = useRef(0);

  useEffect(() => {
    if (!services.searchRecords) {
      setError("Record search is not available here.");
      return;
    }
    const mySeq = ++seq.current;
    setLoading(true);
    const t = setTimeout(() => {
      services.searchRecords!(tableId, q.trim())
        .then((rows) => {
          if (seq.current !== mySeq) return;
          setResults(rows);
          setError(null);
          setActive(0);
        })
        .catch((e: unknown) => {
          if (seq.current !== mySeq) return;
          setError(e instanceof Error ? e.message : "Search failed");
        })
        .finally(() => {
          if (seq.current === mySeq) setLoading(false);
        });
    }, 150);
    return () => clearTimeout(t);
  }, [q, tableId, services]);

  const create = async () => {
    if (!services.createRecord) return;
    setCreating(true);
    try {
      const ref = await services.createRecord(tableId, q.trim());
      onPick(ref);
      if (allowMultiple) {
        setResults((r) => [ref, ...r]);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create record");
    } finally {
      setCreating(false);
    }
  };

  return (
    <div
      className="tfu-modal-back"
      onMouseDown={(e) => {
        e.stopPropagation();
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <div className="tfu-modal" role="dialog" aria-label="Link records">
        <div className="tfu-modal-head">
          <input
            className="tfu-input"
            autoFocus
            placeholder={`Find a record in ${tableName ?? "the linked table"}`}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                onClose();
              } else if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive((a) => Math.min(results.length - 1, a + 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive((a) => Math.max(0, a - 1));
              } else if (e.key === "Enter") {
                e.preventDefault();
                const r = results[active];
                if (r) onPick(r);
                else if (q.trim()) void create();
              }
            }}
          />
          <button type="button" className="tfu-icon-btn" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="tfu-modal-body">
          {error ? <div className="tfu-error" style={{ padding: 8 }}>{error}</div> : null}
          {loading && results.length === 0 ? <div className="tfu-pop-empty">Searching…</div> : null}
          {results.map((r, idx) => {
            const sel = selectedIds.includes(r.id);
            return (
              <button
                key={r.id}
                type="button"
                className={`tfu-rec ${sel ? "sel" : ""}`}
                style={idx === active ? { borderColor: "#2d7ff9" } : undefined}
                onMouseEnter={() => setActive(idx)}
                onClick={() => onPick(r)}
              >
                <strong>{r.name || "Unnamed record"}</strong>
                <span className="tfu-rec-sub">{sel ? "Linked — click to unlink" : r.id}</span>
              </button>
            );
          })}
          {!loading && results.length === 0 && !error ? (
            <div className="tfu-pop-empty">No matching records</div>
          ) : null}
          {services.createRecord ? (
            <button
              type="button"
              className="tfu-pop-item"
              style={{ width: "100%", marginTop: 4 }}
              disabled={creating}
              onClick={() => void create()}
            >
              + {creating ? "Creating…" : q.trim() ? `Add new record "${q.trim()}"` : "Add new record"}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
