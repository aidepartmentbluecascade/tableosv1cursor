import { useMemo, useRef, useState, type ReactElement } from "react";
import {
  evaluateFormula,
  parseFormula,
  type FormulaAst,
} from "@tabula/formula";
import { cellValueToText } from "./format.js";
import { OPTION_COLORS, fieldTypeIcon, nextOptionColor, optionColor } from "./metadata.js";
import { ensureFieldUiStyles } from "./styles.js";
import type { FieldLike, SelectOption, TableLike } from "./types.js";

type Config = Record<string, unknown>;

export interface FieldConfigEditorProps {
  type: string;
  config: Config;
  onChange: (config: Config) => void;
  /** Fields of the current table (lookup/rollup/count/formula). */
  fields: FieldLike[];
  /** All tables of the base (link target, lookup targets). */
  tables: TableLike[];
  /** Id of the table that owns the field. */
  tableId?: string | undefined;
  /** Id of the field being edited (excluded from formula refs). */
  fieldId?: string | undefined;
  /** Optional record used for a live formula preview. */
  sampleRecord?: { id?: string; fields: Record<string, unknown> } | undefined;
}

export function randomOptionId(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let s = "opt_";
  for (let i = 0; i < 14; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

/** Sensible default config when a field of `type` is created. */
export function defaultFieldConfig(type: string, ctx: { tables?: TableLike[]; tableId?: string } = {}): Config {
  switch (type) {
    case "single_select":
    case "multi_select":
      return { options: [] };
    case "number":
      return { precision: 0 };
    case "currency":
      return { symbol: "$", precision: 2 };
    case "percent":
      return { precision: 0 };
    case "rating":
      return { max: 5, icon: "star" };
    case "duration":
      return { format: "h:mm" };
    case "date":
      return { format: "local" };
    case "datetime":
      return { format: "local", timeFormat: "12h" };
    case "link": {
      const other = ctx.tables?.find((t) => t.id !== ctx.tableId) ?? ctx.tables?.[0];
      return { linkedTableId: other?.id ?? null, allowMultiple: true };
    }
    case "collaborator":
      return { allowMultiple: false, notify: true };
    case "formula":
      return { expression: "" };
    case "rollup":
      return { aggregation: "sum" };
    case "button":
      return { label: "Open", style: "primary", action: { type: "open_url", url: "" } };
    default:
      return {};
  }
}

/** Returns an error message when the config is incomplete for creation. */
export function validateFieldConfig(type: string, config: Config, fields: FieldLike[] = [], fieldId?: string): string | null {
  switch (type) {
    case "link":
      return config["linkedTableId"] ? null : "Choose a table to link to.";
    case "lookup":
      if (!config["linkFieldId"]) return "Choose a link field.";
      return config["targetFieldId"] ? null : "Choose a field to look up.";
    case "rollup":
      if (!config["linkFieldId"]) return "Choose a link field.";
      if (!config["targetFieldId"]) return "Choose a field to roll up.";
      return config["aggregation"] ? null : "Choose an aggregation.";
    case "count":
      return config["linkFieldId"] ? null : "Choose a link field.";
    case "formula": {
      const expr = String(config["expression"] ?? "").trim();
      if (!expr) return "Enter a formula.";
      return checkFormula(expr, fields, fieldId).error;
    }
    case "single_select":
    case "multi_select": {
      const opts = (config["options"] ?? []) as SelectOption[];
      if (opts.some((o) => !o.label.trim())) return "Options cannot be blank.";
      const labels = opts.map((o) => o.label.trim().toLowerCase());
      return new Set(labels).size === labels.length ? null : "Option names must be unique.";
    }
    default:
      return null;
  }
}

function collectRefs(ast: FormulaAst, out: string[]): void {
  switch (ast.kind) {
    case "field":
      out.push(ast.name);
      break;
    case "unary":
      collectRefs(ast.expr, out);
      break;
    case "binary":
      collectRefs(ast.left, out);
      collectRefs(ast.right, out);
      break;
    case "call":
      ast.args.forEach((a) => collectRefs(a, out));
      break;
    default:
      break;
  }
}

export function checkFormula(
  expression: string,
  fields: FieldLike[],
  selfId?: string,
): { error: string | null; ast: FormulaAst | null } {
  let ast: FormulaAst;
  try {
    ast = parseFormula(expression);
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Invalid formula", ast: null };
  }
  const refs: string[] = [];
  collectRefs(ast, refs);
  for (const name of refs) {
    const f = fields.find((x) => x.name === name || x.id === name);
    if (!f) return { error: `Unknown field {${name}}`, ast };
    if (selfId && f.id === selfId) return { error: "A formula cannot reference itself.", ast };
  }
  return { error: null, ast };
}

export const AGGREGATIONS: Array<{ value: string; label: string }> = [
  { value: "sum", label: "Sum" },
  { value: "avg", label: "Average" },
  { value: "min", label: "Min" },
  { value: "max", label: "Max" },
  { value: "count", label: "Count (non-empty numbers)" },
  { value: "counta", label: "Count non-empty" },
  { value: "countall", label: "Count all" },
  { value: "concat", label: "Join values" },
  { value: "unique", label: "Unique values" },
  { value: "and", label: "AND (all true)" },
  { value: "or", label: "OR (any true)" },
];

const FORMULA_FUNCTIONS = [
  "IF", "AND", "OR", "NOT", "SWITCH", "CONCATENATE", "LEFT", "RIGHT", "LEN", "LOWER", "UPPER", "TRIM",
  "FIND", "SUBSTITUTE", "REPLACE", "REPT", "ABS", "ROUND", "FLOOR", "CEILING", "MIN", "MAX", "SUM",
  "AVERAGE", "VALUE", "T", "DATETIME_FORMAT", "DATETIME_PARSE", "TODAY", "NOW", "YEAR", "MONTH", "DAY",
  "WEEKDAY", "ISBLANK", "BLANK", "ERROR", "RECORD_ID",
];

function OptionsEditor({ config, onChange }: { config: Config; onChange: (c: Config) => void }) {
  const options = (config["options"] ?? []) as SelectOption[];
  const [colorFor, setColorFor] = useState<string | null>(null);
  const set = (next: SelectOption[]) => onChange({ ...config, options: next });
  const move = (idx: number, dir: -1 | 1) => {
    const next = [...options];
    const j = idx + dir;
    if (j < 0 || j >= next.length) return;
    [next[idx], next[j]] = [next[j]!, next[idx]!];
    set(next);
  };
  return (
    <div className="tfu-cfg">
      <span style={{ fontWeight: 500 }}>Options</span>
      {options.length === 0 ? <span className="tfu-muted">No options yet.</span> : null}
      {options.map((o, idx) => (
        <div key={o.id} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <div className="tfu-opt-row">
            <button
              type="button"
              className="tfu-swatch"
              title="Change color"
              style={{ background: optionColor(o.color).bg }}
              onClick={() => setColorFor(colorFor === o.id ? null : o.id)}
            />
            <input
              className="tfu-input"
              value={o.label}
              placeholder="Option name"
              aria-label={`Option ${idx + 1}`}
              onChange={(e) => set(options.map((x) => (x.id === o.id ? { ...x, label: e.target.value } : x)))}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  set([...options, { id: randomOptionId(), label: "", color: nextOptionColor(options.length) }]);
                }
              }}
            />
            <button type="button" className="tfu-icon-btn" disabled={idx === 0} onClick={() => move(idx, -1)} aria-label="Move up">
              ↑
            </button>
            <button type="button" className="tfu-icon-btn" disabled={idx === options.length - 1} onClick={() => move(idx, 1)} aria-label="Move down">
              ↓
            </button>
            <button type="button" className="tfu-icon-btn" onClick={() => set(options.filter((x) => x.id !== o.id))} aria-label={`Delete option ${o.label}`}>
              ✕
            </button>
          </div>
          {colorFor === o.id ? (
            <div className="tfu-row" style={{ display: "flex", gap: 6, paddingLeft: 26 }}>
              {OPTION_COLORS.map((c) => (
                <button
                  key={c.name}
                  type="button"
                  title={c.name}
                  className={`tfu-swatch ${o.color === c.name ? "sel" : ""}`}
                  style={{ background: c.bg }}
                  onClick={() => {
                    set(options.map((x) => (x.id === o.id ? { ...x, color: c.name } : x)));
                    setColorFor(null);
                  }}
                />
              ))}
            </div>
          ) : null}
        </div>
      ))}
      <div>
        <button
          type="button"
          className="tfu-btn"
          onClick={() => set([...options, { id: randomOptionId(), label: "", color: nextOptionColor(options.length) }])}
        >
          + Add option
        </button>
      </div>
    </div>
  );
}

function NumberSelect({
  label,
  value,
  onChange,
  min,
  max,
  render,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
  min: number;
  max: number;
  render?: (n: number) => string;
}) {
  return (
    <label>
      {label}
      <select className="tfu-input" value={value} onChange={(e) => onChange(Number(e.target.value))}>
        {Array.from({ length: max - min + 1 }, (_, i) => min + i).map((n) => (
          <option key={n} value={n}>
            {render ? render(n) : n}
          </option>
        ))}
      </select>
    </label>
  );
}

const precisionLabel = (n: number) => (n === 0 ? "1 (integer)" : (1).toFixed(n));

function FormulaEditor({
  config,
  onChange,
  fields,
  fieldId,
  sampleRecord,
}: {
  config: Config;
  onChange: (c: Config) => void;
  fields: FieldLike[];
  fieldId?: string | undefined;
  sampleRecord?: FieldConfigEditorProps["sampleRecord"];
}) {
  const expression = String(config["expression"] ?? "");
  const ref = useRef<HTMLTextAreaElement>(null);
  const [caret, setCaret] = useState(expression.length);
  const [active, setActive] = useState(0);
  const refFields = fields.filter((f) => f.id !== fieldId);

  // Autocomplete when the caret is inside an unclosed `{`.
  const before = expression.slice(0, caret);
  const open = before.lastIndexOf("{");
  const closed = before.lastIndexOf("}");
  const partial = open > closed ? before.slice(open + 1) : null;
  const suggestions =
    partial !== null
      ? refFields.filter((f) => f.name.toLowerCase().includes(partial.toLowerCase())).slice(0, 8)
      : [];
  const fnMatch = partial === null ? /([A-Za-z_]{2,})$/.exec(before) : null;
  const fnSuggestions = fnMatch
    ? FORMULA_FUNCTIONS.filter((fn) => fn.startsWith(fnMatch[1]!.toUpperCase()) && fn !== fnMatch[1]!.toUpperCase()).slice(0, 6)
    : [];

  const insertField = (f: FieldLike) => {
    const after = expression.slice(caret);
    const afterClose = after.indexOf("}");
    const rest = afterClose >= 0 && !after.slice(0, afterClose).includes("{") ? after.slice(afterClose + 1) : after;
    const next = `${expression.slice(0, open)}{${f.name}}${rest}`;
    const pos = open + f.name.length + 2;
    onChange({ ...config, expression: next });
    requestAnimationFrame(() => {
      ref.current?.focus();
      ref.current?.setSelectionRange(pos, pos);
      setCaret(pos);
    });
  };
  const insertFn = (fn: string) => {
    const start = caret - fnMatch![1]!.length;
    const next = `${expression.slice(0, start)}${fn}(${expression.slice(caret)}`;
    const pos = start + fn.length + 1;
    onChange({ ...config, expression: next });
    requestAnimationFrame(() => {
      ref.current?.focus();
      ref.current?.setSelectionRange(pos, pos);
      setCaret(pos);
    });
  };

  const check = useMemo(() => (expression.trim() ? checkFormula(expression, refFields, fieldId) : null), [expression, refFields, fieldId]);

  const preview = useMemo(() => {
    if (!check || check.error || !check.ast || !sampleRecord) return null;
    try {
      const fieldNameToSlot: Record<string, string> = {};
      const cells: Record<string, string | number | boolean | string[]> = {};
      for (const f of refFields) {
        fieldNameToSlot[f.name] = f.id;
        const v = sampleRecord.fields[f.id];
        if (v === null || v === undefined) continue;
        if (typeof v === "number" || typeof v === "boolean") cells[f.id] = v;
        else if (typeof v === "string" && !["single_select"].includes(f.type)) cells[f.id] = v;
        else cells[f.id] = cellValueToText(f, v);
      }
      const value = evaluateFormula(check.ast, {
        fieldNameToSlot,
        cells,
        ...(sampleRecord.id ? { recordId: sampleRecord.id } : {}),
      });
      return { ok: true as const, value };
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : "Error" };
    }
  }, [check, sampleRecord, refFields]);

  const list = partial !== null ? suggestions : [];

  return (
    <div className="tfu-cfg">
      <label>
        Formula
        <textarea
          ref={ref}
          className="tfu-input tfu-formula"
          value={expression}
          spellCheck={false}
          placeholder="e.g. {Price} * {Quantity}"
          onChange={(e) => {
            onChange({ ...config, expression: e.target.value });
            setCaret(e.target.selectionStart);
            setActive(0);
          }}
          onSelect={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart)}
          onKeyDown={(e) => {
            if (list.length > 0) {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive((a) => Math.min(list.length - 1, a + 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive((a) => Math.max(0, a - 1));
              } else if (e.key === "Enter" || e.key === "Tab") {
                e.preventDefault();
                insertField(list[active] ?? list[0]!);
              }
            } else if (fnSuggestions.length > 0 && e.key === "Tab") {
              e.preventDefault();
              insertFn(fnSuggestions[0]!);
            }
          }}
        />
      </label>
      {list.length > 0 ? (
        <div className="tfu-pop-list" style={{ border: "1px solid #e2e8f0", borderRadius: 6, padding: 4, maxHeight: 180 }}>
          {list.map((f, idx) => (
            <button
              key={f.id}
              type="button"
              className={`tfu-pop-item ${idx === active ? "active" : ""}`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => insertField(f)}
            >
              <span style={{ width: 18, textAlign: "center", color: "#64748b" }}>{fieldTypeIcon(f.type)}</span>
              {f.name}
            </button>
          ))}
        </div>
      ) : null}
      {fnSuggestions.length > 0 ? (
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
          {fnSuggestions.map((fn) => (
            <button key={fn} type="button" className="tfu-btn" onMouseDown={(e) => e.preventDefault()} onClick={() => insertFn(fn)}>
              {fn}()
            </button>
          ))}
        </div>
      ) : null}
      <span className="tfu-muted" style={{ fontSize: 12 }}>
        Type <code>{"{"}</code> to insert a field. Functions: IF, AND, OR, CONCATENATE, ROUND, SUM, TODAY, DATETIME_FORMAT…
      </span>
      {check ? (
        check.error ? (
          <span className="tfu-error">✕ {check.error}</span>
        ) : (
          <span className="tfu-ok">✓ Valid formula</span>
        )
      ) : null}
      {preview ? (
        <div className="tfu-preview">
          Preview (first record):{" "}
          {preview.ok ? <strong>{preview.value === null ? "(empty)" : String(preview.value)}</strong> : <span className="tfu-error">{preview.error}</span>}
        </div>
      ) : null}
      <label>
        Result type
        <select
          className="tfu-input"
          value={String(config["resultType"] ?? "")}
          onChange={(e) => {
            const next = { ...config };
            if (e.target.value) next["resultType"] = e.target.value;
            else delete next["resultType"];
            onChange(next);
          }}
        >
          <option value="">Automatic</option>
          <option value="text">Text</option>
          <option value="number">Number</option>
          <option value="date">Date</option>
          <option value="boolean">Checkbox (true/false)</option>
        </select>
      </label>
    </div>
  );
}

function LinkedFieldPickers({
  type,
  config,
  onChange,
  fields,
  tables,
}: {
  type: string;
  config: Config;
  onChange: (c: Config) => void;
  fields: FieldLike[];
  tables: TableLike[];
}) {
  const linkFields = fields.filter((f) => f.type === "link");
  const linkField = linkFields.find((f) => f.id === config["linkFieldId"]);
  const targetTableId = (linkField?.config?.["linkedTableId"] ?? linkField?.config?.["targetTableId"]) as string | undefined;
  const targetTable = tables.find((t) => t.id === targetTableId);
  if (linkFields.length === 0) {
    return <span className="tfu-error">This table has no “Link to another record” fields yet. Add one first.</span>;
  }
  return (
    <div className="tfu-cfg">
      <label>
        Link field
        <select
          className="tfu-input"
          value={String(config["linkFieldId"] ?? "")}
          onChange={(e) => onChange({ ...config, linkFieldId: e.target.value || null, targetFieldId: null })}
        >
          <option value="">Choose a link field…</option>
          {linkFields.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </select>
      </label>
      {type !== "count" ? (
        <label>
          {type === "lookup" ? "Field to look up" : "Field to roll up"}
          <select
            className="tfu-input"
            disabled={!targetTable}
            value={String(config["targetFieldId"] ?? "")}
            onChange={(e) => onChange({ ...config, targetFieldId: e.target.value || null })}
          >
            <option value="">{targetTable ? `Choose a field in ${targetTable.name}…` : "Choose a link field first"}</option>
            {(targetTable?.fields ?? []).map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {type === "rollup" ? (
        <label>
          Aggregation
          <select
            className="tfu-input"
            value={String(config["aggregation"] ?? "sum")}
            onChange={(e) => onChange({ ...config, aggregation: e.target.value })}
          >
            {AGGREGATIONS.map((a) => (
              <option key={a.value} value={a.value}>
                {a.label}
              </option>
            ))}
          </select>
        </label>
      ) : null}
    </div>
  );
}

/** Type-specific configuration form. */
export function FieldConfigEditor({
  type,
  config,
  onChange,
  fields,
  tables,
  tableId,
  fieldId,
  sampleRecord,
}: FieldConfigEditorProps): ReactElement | null {
  ensureFieldUiStyles();
  const set = (patch: Config) => onChange({ ...config, ...patch });
  const num = (k: string, d: number) => (typeof config[k] === "number" ? (config[k] as number) : d);

  switch (type) {
    case "single_select":
    case "multi_select":
      return <OptionsEditor config={config} onChange={onChange} />;
    case "number":
      return (
        <div className="tfu-cfg">
          <NumberSelect label="Precision" value={num("precision", 0)} min={0} max={8} render={precisionLabel} onChange={(n) => set({ precision: n })} />
        </div>
      );
    case "currency":
      return (
        <div className="tfu-cfg">
          <label>
            Currency symbol
            <input className="tfu-input" value={String(config["symbol"] ?? "$")} maxLength={4} onChange={(e) => set({ symbol: e.target.value })} />
          </label>
          <NumberSelect label="Precision" value={num("precision", 2)} min={0} max={8} render={precisionLabel} onChange={(n) => set({ precision: n })} />
        </div>
      );
    case "percent":
      return (
        <div className="tfu-cfg">
          <NumberSelect label="Precision" value={num("precision", 0)} min={0} max={8} render={precisionLabel} onChange={(n) => set({ precision: n })} />
        </div>
      );
    case "rating":
      return (
        <div className="tfu-cfg">
          <NumberSelect label="Maximum" value={num("max", 5)} min={1} max={10} onChange={(n) => set({ max: n })} />
          <label>
            Icon
            <select className="tfu-input" value={String(config["icon"] ?? "star")} onChange={(e) => set({ icon: e.target.value })}>
              <option value="star">★ Star</option>
              <option value="heart">♥ Heart</option>
              <option value="check">✔ Check</option>
            </select>
          </label>
        </div>
      );
    case "duration":
      return (
        <div className="tfu-cfg">
          <label>
            Format
            <select className="tfu-input" value={String(config["format"] ?? "h:mm")} onChange={(e) => set({ format: e.target.value })}>
              <option value="h:mm">h:mm</option>
              <option value="h:mm:ss">h:mm:ss</option>
            </select>
          </label>
        </div>
      );
    case "date":
    case "datetime":
      return (
        <div className="tfu-cfg">
          <label>
            Date format
            <select className="tfu-input" value={String(config["format"] ?? "local")} onChange={(e) => set({ format: e.target.value })}>
              <option value="local">Local (e.g. Mar 5, 2026)</option>
              <option value="us">US (3/5/2026)</option>
              <option value="eu">European (5/3/2026)</option>
              <option value="iso">ISO (2026-03-05)</option>
            </select>
          </label>
          {type === "datetime" ? (
            <>
              <label>
                Time format
                <select className="tfu-input" value={String(config["timeFormat"] ?? "12h")} onChange={(e) => set({ timeFormat: e.target.value })}>
                  <option value="12h">12 hour</option>
                  <option value="24h">24 hour</option>
                </select>
              </label>
              <label>
                Time zone
                <input
                  className="tfu-input"
                  placeholder="Viewer's local time zone"
                  value={String(config["timeZone"] ?? "")}
                  onChange={(e) => {
                    const next = { ...config };
                    if (e.target.value) next["timeZone"] = e.target.value;
                    else delete next["timeZone"];
                    onChange(next);
                  }}
                />
              </label>
            </>
          ) : null}
        </div>
      );
    case "link":
      return (
        <div className="tfu-cfg">
          <label>
            Link to table
            <select
              className="tfu-input"
              value={String(config["linkedTableId"] ?? "")}
              onChange={(e) => set({ linkedTableId: e.target.value || null })}
            >
              <option value="">Choose a table…</option>
              {tables.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                  {t.id === tableId ? " (this table)" : ""}
                </option>
              ))}
            </select>
          </label>
          <label className="tfu-inline">
            <input type="checkbox" checked={config["allowMultiple"] !== false} onChange={(e) => set({ allowMultiple: e.target.checked })} />
            Allow linking to multiple records
          </label>
        </div>
      );
    case "lookup":
    case "rollup":
    case "count":
      return <LinkedFieldPickers type={type} config={config} onChange={onChange} fields={fields} tables={tables} />;
    case "formula":
      return <FormulaEditor config={config} onChange={onChange} fields={fields} fieldId={fieldId} sampleRecord={sampleRecord} />;
    case "collaborator":
      return (
        <div className="tfu-cfg">
          <label className="tfu-inline">
            <input type="checkbox" checked={config["allowMultiple"] === true} onChange={(e) => set({ allowMultiple: e.target.checked })} />
            Allow adding multiple users
          </label>
          <label className="tfu-inline">
            <input type="checkbox" checked={config["notify"] !== false} onChange={(e) => set({ notify: e.target.checked })} />
            Notify users when they're added
          </label>
        </div>
      );
    case "button": {
      const action = (config["action"] ?? { type: "open_url", url: "" }) as { type: string; url?: string };
      return (
        <div className="tfu-cfg">
          <label>
            Label
            <input className="tfu-input" value={String(config["label"] ?? "")} onChange={(e) => set({ label: e.target.value })} />
          </label>
          <label>
            Style
            <select className="tfu-input" value={String(config["style"] ?? "primary")} onChange={(e) => set({ style: e.target.value })}>
              <option value="primary">Primary</option>
              <option value="default">Default</option>
            </select>
          </label>
          <label>
            URL to open
            <input
              className="tfu-input"
              placeholder="https://example.com/search?q={Name}"
              value={action.url ?? ""}
              onChange={(e) => set({ action: { type: "open_url", url: e.target.value } })}
            />
          </label>
          <span className="tfu-muted" style={{ fontSize: 12 }}>
            Use {"{Field Name}"} to insert values from the record.
          </span>
        </div>
      );
    }
    default:
      return null;
  }
}
