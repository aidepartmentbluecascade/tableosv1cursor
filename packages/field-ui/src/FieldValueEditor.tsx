import {
  useEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import {
  asArray,
  cfg,
  formatDuration,
  isoToLocalInput,
  localInputToIso,
  parseDuration,
  selectOptions,
  toNumber,
  userLabel,
} from "./format.js";
import { LinkRecordPicker } from "./LinkRecordPicker.js";
import { isReadOnlyFieldType } from "./metadata.js";
import { Popover, SearchableList, type MenuItem } from "./Popover.js";
import {
  AttachmentThumb,
  OptionPill,
  UserChip,
  renderCellValue,
} from "./render.js";
import { useFieldUiServices } from "./services.js";
import { ensureFieldUiStyles } from "./styles.js";
import type { AttachmentValue, FieldLike, LinkRef, UserRef } from "./types.js";

export type EditDoneReason = "enter" | "tab" | "shift-tab" | "escape" | "blur";

export interface FieldValueEditorProps {
  field: FieldLike;
  value: unknown;
  /**
   * Called with the new (output-shaped) value when the user commits. Text-like
   * editors commit on Enter/Tab/blur; discrete editors commit immediately.
   * `null` clears the cell.
   */
  onChange: (next: unknown) => void;
  /** "cell" = compact in-grid editor; "form" = drawer/form input. */
  mode?: "cell" | "form";
  autoFocus?: boolean;
  readOnly?: boolean;
  /** When editing started by typing a character, the initial draft text. */
  initialText?: string | undefined;
  /** Cell mode: editor wants to close (grid moves selection accordingly). */
  onDone?: (reason: EditDoneReason) => void;
  /** For buttons and read-only rendering. */
  record?: { id?: string; fields: Record<string, unknown> } | undefined;
  fields?: FieldLike[] | undefined;
  error?: string | null | undefined;
  placeholder?: string | undefined;
}

const TEXT_TYPES = new Set([
  "text",
  "email",
  "url",
  "phone",
  "number",
  "currency",
  "percent",
  "duration",
  "barcode",
  "json",
]);

function valueToDraft(field: FieldLike, value: unknown): string {
  if (value === null || value === undefined) return "";
  switch (field.type) {
    case "percent": {
      const n = toNumber(value);
      return n === null ? "" : String(Math.round(n * 100 * 1e8) / 1e8);
    }
    case "duration": {
      const n = toNumber(value);
      return n === null ? "" : formatDuration(n, cfg(field)["format"] as string | undefined);
    }
    case "barcode":
      return typeof value === "object" ? String((value as { text?: string }).text ?? "") : String(value);
    case "json":
      return typeof value === "string" ? value : JSON.stringify(value);
    default:
      return String(value);
  }
}

/** Returns `undefined` when the draft is invalid (no change is committed). */
function draftToValue(field: FieldLike, draft: string): unknown {
  const t = draft.trim();
  switch (field.type) {
    case "number":
    case "currency": {
      if (!t) return null;
      const n = Number(t.replace(/[^0-9.\-eE]/g, ""));
      return Number.isFinite(n) && /\d/.test(t) ? n : undefined;
    }
    case "percent": {
      if (!t) return null;
      const n = Number(t.replace(/[%,\s]/g, ""));
      return Number.isFinite(n) ? n / 100 : undefined;
    }
    case "duration":
      if (!t) return null;
      return parseDuration(t) ?? undefined;
    case "barcode":
      return t ? { text: t } : null;
    case "json":
      if (!t) return null;
      try {
        return JSON.parse(t);
      } catch {
        return undefined;
      }
    case "long_text":
      return draft.trim() ? draft : null;
    default:
      return t ? draft.trim() : null;
  }
}

function sameValue(a: unknown, b: unknown): boolean {
  const norm = (v: unknown) => (v === undefined || v === "" ? null : v);
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
}

/**
 * Commit-once draft helper for text-like editors: commits on explicit
 * finish, on blur, and (as a safety net) on unmount if still dirty.
 */
function useDraft(field: FieldLike, value: unknown, initialText: string | undefined, onChange: (v: unknown) => void) {
  const [draft, setDraft] = useState(() => initialText ?? valueToDraft(field, value));
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const finalized = useRef(false);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const valueRef = useRef(value);
  valueRef.current = value;
  const fieldRef = useRef(field);
  fieldRef.current = field;
  const dirty = useRef(initialText !== undefined);

  // Re-sync with external value when not being edited (form mode refetch).
  useEffect(() => {
    if (!dirty.current) setDraft(valueToDraft(field, value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const commit = () => {
    if (!dirty.current) return;
    const next = draftToValue(fieldRef.current, draftRef.current);
    dirty.current = false;
    if (next === undefined) {
      setDraft(valueToDraft(fieldRef.current, valueRef.current));
      return;
    }
    if (!sameValue(next, valueRef.current)) onChangeRef.current(next);
  };

  useEffect(
    () => () => {
      if (!finalized.current) commit();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  return {
    draft,
    setDraft: (d: string) => {
      dirty.current = true;
      setDraft(d);
    },
    commit,
    /** Commit (unless cancel) and stop further commits from this editor. */
    finish(cancel: boolean) {
      if (finalized.current) return false;
      if (!cancel) commit();
      finalized.current = true;
      return true;
    },
    resetFinish() {
      finalized.current = false;
    },
  };
}

function TextEditor(props: FieldValueEditorProps): ReactElement {
  const { field, value, onChange, mode = "form", autoFocus, initialText, onDone, placeholder } = props;
  const d = useDraft(field, value, initialText, onChange);
  const ref = useRef<HTMLInputElement>(null);
  const isNumeric = ["number", "currency", "percent"].includes(field.type);

  useEffect(() => {
    const el = ref.current;
    if (!el || !(autoFocus ?? mode === "cell")) return;
    el.focus();
    if (initialText === undefined) el.select();
    else el.setSelectionRange(el.value.length, el.value.length);
  }, [autoFocus, mode, initialText]);

  const inputType =
    field.type === "email" ? "email" : field.type === "url" ? "url" : field.type === "phone" ? "tel" : "text";

  return (
    <input
      ref={ref}
      className={mode === "cell" ? "tfu-cell-input" : "tfu-input"}
      type={inputType}
      inputMode={isNumeric ? "decimal" : undefined}
      value={d.draft}
      placeholder={placeholder ?? (field.type === "duration" ? "h:mm" : undefined)}
      style={isNumeric && mode === "cell" ? { textAlign: "right" } : undefined}
      onChange={(e) => d.setDraft(e.target.value)}
      onBlur={() => {
        if (mode === "cell") {
          if (d.finish(false)) onDone?.("blur");
        } else {
          d.commit();
        }
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.nativeEvent.isComposing) {
          e.preventDefault();
          if (mode === "cell") {
            if (d.finish(false)) onDone?.("enter");
          } else d.commit();
        } else if (e.key === "Tab" && mode === "cell") {
          e.preventDefault();
          if (d.finish(false)) onDone?.(e.shiftKey ? "shift-tab" : "tab");
        } else if (e.key === "Escape" && mode === "cell") {
          e.preventDefault();
          if (d.finish(true)) onDone?.("escape");
        }
        if (mode === "cell") e.stopPropagation();
      }}
    />
  );
}

function LongTextEditor(props: FieldValueEditorProps): ReactElement {
  const { field, value, onChange, mode = "form", autoFocus, initialText, onDone, placeholder } = props;
  const d = useDraft(field, value, initialText, onChange);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || !(autoFocus ?? mode === "cell")) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [autoFocus, mode]);
  return (
    <textarea
      ref={ref}
      className={mode === "cell" ? "tfu-cell-area" : "tfu-input"}
      rows={mode === "cell" ? undefined : 4}
      value={d.draft}
      placeholder={placeholder}
      style={mode === "form" ? { resize: "vertical", minHeight: 80 } : undefined}
      onChange={(e) => d.setDraft(e.target.value)}
      onBlur={() => {
        if (mode === "cell") {
          if (d.finish(false)) onDone?.("blur");
        } else d.commit();
      }}
      onKeyDown={(e) => {
        if (mode !== "cell") return;
        e.stopPropagation();
        if (e.key === "Escape" || (e.key === "Enter" && (e.metaKey || e.ctrlKey))) {
          // Long text: Esc keeps the edit (Airtable behaviour) — never lose typed notes.
          e.preventDefault();
          if (d.finish(false)) onDone?.(e.key === "Escape" ? "escape" : "enter");
        } else if (e.key === "Tab") {
          e.preventDefault();
          if (d.finish(false)) onDone?.(e.shiftKey ? "shift-tab" : "tab");
        }
      }}
    />
  );
}

function DateEditor(props: FieldValueEditorProps): ReactElement {
  const { field, value, onChange, mode = "form", autoFocus, onDone } = props;
  const isDT = field.type === "datetime";
  const initial = typeof value === "string" ? (isDT ? isoToLocalInput(value) : value.slice(0, 10)) : "";
  const [draft, setDraft] = useState(initial);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const finalized = useRef(false);
  const ref = useRef<HTMLInputElement>(null);
  const valueRef = useRef(value);
  valueRef.current = value;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    setDraft(typeof value === "string" ? (isDT ? isoToLocalInput(value) : value.slice(0, 10)) : "");
  }, [value, isDT]);

  const commit = () => {
    const d = draftRef.current;
    const next = d ? (isDT ? localInputToIso(d) : d) : null;
    if (d && next === null) return;
    if (!sameValue(next, valueRef.current)) onChangeRef.current(next);
  };
  useEffect(
    () => () => {
      if (!finalized.current && mode === "cell") commit();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  useEffect(() => {
    if (autoFocus ?? mode === "cell") ref.current?.focus();
  }, [autoFocus, mode]);

  const finish = (reason: EditDoneReason) => {
    if (finalized.current) return;
    if (reason !== "escape") commit();
    finalized.current = true;
    onDone?.(reason);
  };

  return (
    <input
      ref={ref}
      type={isDT ? "datetime-local" : "date"}
      className={mode === "cell" ? "tfu-cell-input" : "tfu-input"}
      value={draft}
      onChange={(e) => {
        setDraft(e.target.value);
        if (mode === "form") {
          draftRef.current = e.target.value;
          // Native pickers emit complete values; commit eagerly in forms.
          if (!e.target.value || e.target.value.length >= (isDT ? 16 : 10)) commit();
        }
      }}
      onBlur={() => {
        if (mode === "cell") finish("blur");
      }}
      onKeyDown={(e) => {
        if (mode !== "cell") return;
        e.stopPropagation();
        if (e.key === "Enter") {
          e.preventDefault();
          finish("enter");
        } else if (e.key === "Tab") {
          e.preventDefault();
          finish(e.shiftKey ? "shift-tab" : "tab");
        } else if (e.key === "Escape") {
          e.preventDefault();
          finish("escape");
        }
      }}
    />
  );
}

/** Wrapper that renders a box (cell overlay or form control) plus a popover. */
function PickerShell({
  mode,
  autoOpen,
  boxContent,
  popover,
  onClosePopover,
  popWidth,
}: {
  mode: "cell" | "form";
  autoOpen: boolean;
  boxContent: ReactNode;
  popover: (close: () => void) => ReactNode;
  onClosePopover?: () => void;
  popWidth?: number;
}): ReactElement {
  const boxRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(autoOpen);
  const [anchor, setAnchor] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    setAnchor(boxRef.current);
  }, []);
  const close = () => {
    setOpen(false);
    onClosePopover?.();
  };
  return (
    <>
      <div
        ref={boxRef}
        className={mode === "cell" ? "tfu-cell-box" : "tfu-form-box"}
        onClick={() => setOpen(true)}
        tabIndex={mode === "form" ? 0 : -1}
        onKeyDown={(e) => {
          if (mode === "form" && (e.key === "Enter" || e.key === " ")) {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        {boxContent}
      </div>
      {open && anchor ? (
        <Popover anchor={anchor} onClose={close} {...(popWidth ? { width: popWidth } : {})}>
          {popover(close)}
        </Popover>
      ) : null}
    </>
  );
}

function SelectEditor(props: FieldValueEditorProps): ReactElement {
  const { field, value, onChange, mode = "form", onDone } = props;
  const services = useFieldUiServices();
  const multi = field.type === "multi_select";
  const options = selectOptions(field);
  const selected = multi ? asArray<string>(value) : typeof value === "string" ? [value] : [];
  // Keep a local copy so several quick picks in multi-select don't race the parent.
  const [local, setLocal] = useState<string[]>(selected);
  const [extraOptions, setExtraOptions] = useState<typeof options>([]);
  useEffect(() => {
    setLocal(multi ? asArray<string>(value) : typeof value === "string" ? [value] : []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(value)]);
  const allOptions = [...options, ...extraOptions.filter((x) => !options.some((o) => o.id === x.id))];
  const [error, setError] = useState<string | null>(null);

  const items: MenuItem[] = allOptions.map((o) => ({
    key: o.id,
    text: o.label,
    selected: local.includes(o.id),
    label: <OptionPill label={o.label} color={o.color} />,
  }));

  const choose = (id: string, close: () => void) => {
    if (multi) {
      const next = local.includes(id) ? local.filter((x) => x !== id) : [...local, id];
      setLocal(next);
      onChange(next.length ? next : null);
    } else {
      const next = local[0] === id ? null : id;
      setLocal(next ? [next] : []);
      onChange(next);
      if (mode === "cell") onDone?.("blur");
      else close();
    }
  };

  return (
    <PickerShell
      mode={mode}
      autoOpen={mode === "cell"}
      onClosePopover={() => {
        if (mode === "cell") onDone?.("blur");
      }}
      boxContent={
        local.length ? (
          local.map((id) => {
            const o = allOptions.find((x) => x.id === id);
            return (
              <span key={id} style={{ display: "inline-flex", alignItems: "center", gap: 2 }}>
                <OptionPill label={o?.label ?? id} color={o?.color} />
                {multi ? (
                  <button
                    type="button"
                    className="tfu-chip-x"
                    aria-label="Remove"
                    onClick={(e) => {
                      e.stopPropagation();
                      const next = local.filter((x) => x !== id);
                      setLocal(next);
                      onChange(next.length ? next : null);
                    }}
                  >
                    ×
                  </button>
                ) : null}
              </span>
            );
          })
        ) : (
          <span className="tfu-muted">{mode === "form" ? "Select an option" : ""}</span>
        )
      }
      popover={(close) => (
        <>
          <SearchableList
            items={items}
            onPick={(id) => choose(id, close)}
            onEscape={close}
            onCreate={
              services.createSelectOption
                ? (label) => {
                    services.createSelectOption!(field, label)
                      .then((opt) => {
                        setExtraOptions((x) => [...x, opt]);
                        choose(opt.id, close);
                      })
                      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Could not add option"));
                  }
                : undefined
            }
            createLabel={(t) => `Add option "${t}"`}
          />
          {error ? <div className="tfu-error">{error}</div> : null}
        </>
      )}
    />
  );
}

function CollaboratorEditor(props: FieldValueEditorProps): ReactElement {
  const { field, value, onChange, mode = "form", onDone } = props;
  const services = useFieldUiServices();
  const multi = cfg(field)["allowMultiple"] === true;
  const current = asArray<UserRef | string>(value).map((u) => (typeof u === "string" ? { id: u } : u));
  const [local, setLocal] = useState<UserRef[]>(current);
  const [users, setUsers] = useState<UserRef[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setLocal(asArray<UserRef | string>(value).map((u) => (typeof u === "string" ? { id: u } : u)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(value)]);
  useEffect(() => {
    if (!services.listCollaborators) {
      setUsers([]);
      return;
    }
    services
      .listCollaborators()
      .then(setUsers)
      .catch((e: unknown) => {
        setUsers([]);
        setError(e instanceof Error ? e.message : "Could not load collaborators");
      });
  }, [services]);

  const items: MenuItem[] = (users ?? []).map((u) => ({
    key: u.id,
    text: `${userLabel(u)} ${u.email ?? ""}`,
    selected: local.some((x) => x.id === u.id),
    label: <UserChip user={u} />,
  }));

  const pick = (id: string, close: () => void) => {
    const user = users?.find((u) => u.id === id) ?? { id };
    let next: UserRef[];
    if (multi) {
      next = local.some((x) => x.id === id) ? local.filter((x) => x.id !== id) : [...local, user];
    } else {
      next = local[0]?.id === id ? [] : [user];
    }
    setLocal(next);
    onChange(next.length ? next : null);
    if (!multi) {
      if (mode === "cell") onDone?.("blur");
      else close();
    }
  };

  return (
    <PickerShell
      mode={mode}
      autoOpen={mode === "cell"}
      onClosePopover={() => {
        if (mode === "cell") onDone?.("blur");
      }}
      boxContent={
        local.length ? (
          local.map((u) => (
            <span key={u.id} style={{ display: "inline-flex", alignItems: "center", gap: 2 }}>
              <UserChip user={u} />
              <button
                type="button"
                className="tfu-chip-x"
                aria-label="Remove"
                onClick={(e) => {
                  e.stopPropagation();
                  const next = local.filter((x) => x.id !== u.id);
                  setLocal(next);
                  onChange(next.length ? next : null);
                }}
              >
                ×
              </button>
            </span>
          ))
        ) : (
          <span className="tfu-muted">{mode === "form" ? "Add a collaborator" : ""}</span>
        )
      }
      popover={(close) => (
        <>
          {users === null ? <div className="tfu-pop-empty">Loading…</div> : null}
          <SearchableList
            items={items}
            onPick={(id) => pick(id, close)}
            onEscape={close}
            placeholder="Find a collaborator"
            emptyText="No collaborators"
          />
          {error ? <div className="tfu-error">{error}</div> : null}
        </>
      )}
    />
  );
}

function LinkEditor(props: FieldValueEditorProps): ReactElement {
  const { field, value, onChange, mode = "form", onDone } = props;
  const services = useFieldUiServices();
  const config = cfg(field);
  const linkedTableId = (config["linkedTableId"] ?? config["targetTableId"]) as string | undefined;
  const allowMultiple = config["allowMultiple"] !== false;
  const table = services.tables?.find((t) => t.id === linkedTableId);
  const [local, setLocal] = useState<LinkRef[]>(() =>
    asArray<LinkRef | string>(value).map((l) => (typeof l === "string" ? { id: l } : l)),
  );
  useEffect(() => {
    setLocal(asArray<LinkRef | string>(value).map((l) => (typeof l === "string" ? { id: l } : l)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(value)]);
  const [open, setOpen] = useState(mode === "cell");

  const set = (next: LinkRef[]) => {
    setLocal(next);
    onChange(next.length ? next : null);
  };

  return (
    <>
      <div className={mode === "cell" ? "tfu-cell-box" : "tfu-form-box"} onClick={() => setOpen(true)}>
        {local.map((l) => (
          <span key={l.id} className="tfu-chip">
            {l.name || "Unnamed record"}
            <button
              type="button"
              className="tfu-chip-x"
              aria-label="Unlink"
              onClick={(e) => {
                e.stopPropagation();
                set(local.filter((x) => x.id !== l.id));
              }}
            >
              ×
            </button>
          </span>
        ))}
        {allowMultiple || local.length === 0 ? (
          <button
            type="button"
            className="tfu-btn"
            onClick={(e) => {
              e.stopPropagation();
              setOpen(true);
            }}
          >
            + {local.length ? "Add" : "Link record"}
          </button>
        ) : null}
      </div>
      {open && linkedTableId ? (
        <LinkRecordPicker
          tableId={linkedTableId}
          tableName={table?.name}
          selectedIds={local.map((l) => l.id)}
          allowMultiple={allowMultiple}
          onPick={(ref) => {
            if (local.some((l) => l.id === ref.id)) {
              set(local.filter((l) => l.id !== ref.id));
              return;
            }
            if (allowMultiple) set([...local, ref]);
            else {
              set([ref]);
              setOpen(false);
              if (mode === "cell") onDone?.("enter");
            }
          }}
          onClose={() => {
            setOpen(false);
            if (mode === "cell") onDone?.("escape");
          }}
        />
      ) : null}
      {open && !linkedTableId ? <span className="tfu-error">Link field has no target table.</span> : null}
    </>
  );
}

function AttachmentEditor(props: FieldValueEditorProps): ReactElement {
  const { value, onChange, mode = "form", onDone } = props;
  const services = useFieldUiServices();
  const [local, setLocal] = useState<AttachmentValue[]>(() => asArray<AttachmentValue>(value));
  useEffect(() => {
    setLocal(asArray<AttachmentValue>(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(value)]);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const localRef = useRef(local);
  localRef.current = local;
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (mode !== "cell") return;
    const onDown = (e: MouseEvent) => {
      if (boxRef.current?.contains(e.target as Node)) return;
      onDone?.("blur");
    };
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  }, [mode, onDone]);

  const upload = async (files: FileList) => {
    if (!services.uploadAttachment) return;
    setError(null);
    for (const file of Array.from(files)) {
      try {
        setProgress(0);
        const att = await services.uploadAttachment(file, (f) => setProgress(f));
        const next = [...localRef.current, att];
        localRef.current = next;
        setLocal(next);
        onChange(next);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Upload failed");
      } finally {
        setProgress(null);
      }
    }
  };

  const remove = (id: string) => {
    const next = local.filter((a) => a.id !== id);
    setLocal(next);
    onChange(next.length ? next : null);
  };

  return (
    <div
      ref={boxRef}
      className={mode === "cell" ? "tfu-cell-box" : undefined}
      style={mode === "cell" ? { position: "absolute", left: -2, top: -2, zIndex: 20, minWidth: 260, border: "2px solid #2d7ff9", borderRadius: 4, boxShadow: "0 8px 24px rgba(15,23,42,.18)" } : undefined}
      onKeyDown={(e) => {
        if (mode === "cell" && e.key === "Escape") {
          e.stopPropagation();
          onDone?.("escape");
        }
      }}
    >
      <div className="tfu-attach-grid">
        {local.map((a) => {
          const isImage = (a.mime ?? "").startsWith("image/");
          const src = a.thumbnailUrl ?? (isImage ? a.url : null);
          return (
            <div key={a.id} className="tfu-attach">
              {src ? (
                <a href={a.url ?? "#"} target="_blank" rel="noreferrer">
                  <img className="tfu-attach-img" src={src} alt={a.filename} />
                </a>
              ) : (
                <a className="tfu-attach-img" href={a.url ?? "#"} target="_blank" rel="noreferrer">
                  {(/\.([a-z0-9]{1,5})$/i.exec(a.filename)?.[1] ?? "file")}
                </a>
              )}
              <span className="tfu-attach-name" title={a.filename}>
                {a.filename}
              </span>
              <button type="button" className="tfu-attach-x" aria-label={`Remove ${a.filename}`} onClick={() => remove(a.id)}>
                ×
              </button>
            </div>
          );
        })}
      </div>
      <input
        ref={fileRef}
        type="file"
        multiple
        style={{ display: "none" }}
        onChange={(e) => {
          if (e.target.files?.length) void upload(e.target.files);
          e.target.value = "";
        }}
      />
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: local.length ? 6 : 0 }}>
        {services.uploadAttachment ? (
          <button type="button" className="tfu-btn" disabled={progress !== null} onClick={() => fileRef.current?.click()}>
            {progress !== null ? `Uploading… ${Math.round(progress * 100)}%` : "+ Attach file"}
          </button>
        ) : (
          <span className="tfu-muted">Uploads unavailable</span>
        )}
        {error ? <span className="tfu-error">{error}</span> : null}
      </div>
    </div>
  );
}

function RatingEditor(props: FieldValueEditorProps): ReactElement {
  const { field, value, onChange, mode = "form", onDone } = props;
  const config = cfg(field);
  const max = typeof config["max"] === "number" ? (config["max"] as number) : 5;
  const ch = config["icon"] === "heart" ? "♥" : config["icon"] === "check" ? "✔" : "★";
  const current = toNumber(value) ?? 0;
  const [hover, setHover] = useState<number | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (mode === "cell") ref.current?.focus();
  }, [mode]);
  const set = (n: number) => {
    onChange(n === current ? null : n);
  };
  return (
    <div
      ref={ref}
      tabIndex={0}
      className="tfu-stars"
      style={{ outline: "none", padding: mode === "cell" ? "0 8px" : 0, height: "100%", alignItems: "center" }}
      onMouseLeave={() => setHover(null)}
      onBlur={() => {
        if (mode === "cell") onDone?.("blur");
      }}
      onKeyDown={(e) => {
        if (mode !== "cell") return;
        e.stopPropagation();
        if (/^[0-9]$/.test(e.key)) {
          e.preventDefault();
          const n = Math.min(max, Number(e.key));
          onChange(n || null);
        } else if (e.key === "Enter" || e.key === "Escape") {
          e.preventDefault();
          onDone?.(e.key === "Enter" ? "enter" : "escape");
        } else if (e.key === "Tab") {
          e.preventDefault();
          onDone?.(e.shiftKey ? "shift-tab" : "tab");
        }
      }}
    >
      {Array.from({ length: max }, (_, i) => (
        <button
          key={i}
          type="button"
          className={`tfu-star ${(hover ?? current) > i ? "on" : ""}`}
          style={{ fontSize: mode === "form" ? 18 : 14 }}
          onMouseEnter={() => setHover(i + 1)}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => set(i + 1)}
          aria-label={`${i + 1}`}
        >
          {ch}
        </button>
      ))}
    </div>
  );
}

function CheckboxEditor(props: FieldValueEditorProps): ReactElement {
  const { value, onChange, field } = props;
  return (
    <label style={{ display: "inline-flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
      <input
        type="checkbox"
        checked={value === true}
        onChange={(e) => onChange(e.target.checked ? true : null)}
        style={{ width: 16, height: 16, accentColor: "#20c933" }}
      />
      <span className="tfu-muted" style={{ fontSize: 12 }}>
        {value === true ? "Checked" : field.name}
      </span>
    </label>
  );
}

/** Editable input for any field type (read-only types render their value). */
export function FieldValueEditor(props: FieldValueEditorProps): ReactElement {
  ensureFieldUiStyles();
  const { field, readOnly } = props;
  const type = field.type;
  if (readOnly || isReadOnlyFieldType(type) || field.isComputed) {
    return (
      <div style={{ minHeight: 24, display: "flex", alignItems: "center", flexWrap: "wrap", gap: 4 }}>
        {renderCellValue(field, props.value, { error: props.error, record: props.record, fields: props.fields, wrap: true }) ?? (
          <span className="tfu-muted">—</span>
        )}
      </div>
    );
  }
  if (TEXT_TYPES.has(type)) return <TextEditor {...props} />;
  switch (type) {
    case "long_text":
      return <LongTextEditor {...props} />;
    case "date":
    case "datetime":
      return <DateEditor {...props} />;
    case "single_select":
    case "multi_select":
      return <SelectEditor {...props} />;
    case "collaborator":
    case "contact":
      return <CollaboratorEditor {...props} />;
    case "link":
      return <LinkEditor {...props} />;
    case "attachment":
      return <AttachmentEditor {...props} />;
    case "rating":
      return <RatingEditor {...props} />;
    case "checkbox":
      return <CheckboxEditor {...props} />;
    default:
      return <TextEditor {...props} />;
  }
}
