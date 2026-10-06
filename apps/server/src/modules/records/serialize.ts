/**
 * Record read serialization (CONTRACTS §3). Owned by workstream A, shared with
 * B (write responses), D and E (public shares).
 *
 * `serializeRecords(db, tableId, rows, opts?)` turns raw `data.records` rows into
 * the public wire format:
 *  - `fields` keyed by `fld_` ids, empty values omitted
 *  - computed values unwrapped (legacy `{value,status}` objects); errors → `errors`
 *  - meta fields (autonumber / created_* / modified_*) derived from record columns
 *  - collaborator, link (from `data.record_links`) and attachment values hydrated
 * All hydration is batched (a fixed number of queries per call, no N+1).
 */
import { sql, type Kysely } from "kysely";
import type { Database } from "@tabula/db";
import type { TabulaStorage } from "@tabula/storage";
import { parsePid, pid } from "../../lib/public-ids.js";

type Db = Kysely<Database>;

export interface RecordRowLike {
  id: string;
  version: string | number;
  row_number: string | number;
  manual_order: string;
  cells: unknown;
  computed?: unknown;
  created_at: Date | string;
  updated_at?: Date | string | null;
  created_by?: string | null;
  updated_by?: string | null;
}

export interface UserWire {
  id: string;
  name: string;
  email: string;
}

export interface AttachmentWire {
  id: string;
  filename: string;
  mime: string;
  size: number;
  url: string;
  thumbnailUrl: string | null;
  width: number | null;
  height: number | null;
}

export interface LinkWire {
  id: string;
  name: string;
}

export interface RecordWire {
  id: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  rowNumber: number;
  manualOrder: string;
  fields: Record<string, unknown>;
  errors?: Record<string, string>;
}

export interface SerializeFieldRow {
  id: string;
  slot: number;
  name: string;
  type: string;
  config: Record<string, unknown>;
  is_computed: boolean;
}

export interface SerializeOptions {
  /** Only include these fields (uuid or `fld_` ids). Omitted = all fields. */
  fieldIds?: readonly string[] | undefined;
  /** Storage signer for attachment URLs; when absent, the API path is used. */
  storage?: TabulaStorage | null | undefined;
  /** Pre-loaded field rows for `tableId` (skips one query). */
  fields?: SerializeFieldRow[] | undefined;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* ───────────────────────── small value helpers ───────────────────────── */

export function isEmptyWireValue(v: unknown): boolean {
  return (
    v === undefined ||
    v === null ||
    v === "" ||
    v === false ||
    (Array.isArray(v) && v.length === 0)
  );
}

/** Unwrap a stored computed value (`{value,status,error}` legacy shape or a plain scalar). */
export function unwrapComputed(raw: unknown): { value: unknown; error?: string } {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const o = raw as Record<string, unknown>;
    if ("status" in o || ("value" in o && Object.keys(o).every((k) => k === "value" || k === "error" || k === "status"))) {
      if (o["status"] === "error") {
        const msg = typeof o["error"] === "string" ? o["error"] : "Error";
        return { value: undefined, error: msg.startsWith("#") ? msg : `#ERROR ${msg}` };
      }
      return { value: o["value"] };
    }
  }
  return { value: raw };
}

function toIso(v: Date | string | null | undefined): string | undefined {
  if (v === null || v === undefined) return undefined;
  if (v instanceof Date) return v.toISOString();
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? String(v) : d.toISOString();
}

function toNumber(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v.trim());
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/** Accept raw uuid, a prefixed public id, or `{id}` objects; return the uuid. */
function idFromStored(v: unknown, prefix: "usr" | "att" | "rec"): string | null {
  let s: unknown = v;
  if (s && typeof s === "object" && !Array.isArray(s)) s = (s as Record<string, unknown>)["id"];
  if (typeof s !== "string" || s === "") return null;
  if (UUID_RE.test(s)) return s.toLowerCase();
  if (s.startsWith(`${prefix}_`)) {
    try {
      return parsePid(s, prefix);
    } catch {
      return null;
    }
  }
  return null;
}

function asArray(v: unknown): unknown[] {
  if (v === undefined || v === null || v === "") return [];
  return Array.isArray(v) ? v : [v];
}

interface SelectOption {
  id: string;
  label: string;
}

function selectOptions(config: Record<string, unknown>): SelectOption[] {
  const raw = config["options"] ?? config["choices"];
  if (!Array.isArray(raw)) return [];
  const out: SelectOption[] = [];
  for (const o of raw) {
    if (typeof o === "string") {
      out.push({ id: o, label: o });
    } else if (o && typeof o === "object") {
      const r = o as Record<string, unknown>;
      const id = typeof r["id"] === "string" ? r["id"] : typeof r["label"] === "string" ? r["label"] : null;
      const label = typeof r["label"] === "string" ? r["label"] : typeof r["name"] === "string" ? r["name"] : id;
      if (id) out.push({ id, label: label ?? id });
    }
  }
  return out;
}

/** Map a stored select value (option id, or legacy label) to the option id. */
function normalizeOptionId(v: unknown, opts: SelectOption[]): string | null {
  if (typeof v !== "string" || v === "") return null;
  if (opts.length === 0) return v;
  if (opts.some((o) => o.id === v)) return v;
  const byLabel = opts.find((o) => o.label === v) ?? opts.find((o) => o.label.toLowerCase() === v.toLowerCase());
  return byLabel ? byLabel.id : v;
}

/* ───────────────────────── schema loading ───────────────────────── */

export async function loadSerializeFields(db: Db, tableId: string): Promise<SerializeFieldRow[]> {
  const r = await sql<SerializeFieldRow>`
    SELECT id, slot, name, type, config, is_computed
    FROM data.fields
    WHERE table_id = ${tableId} AND deleted_at IS NULL
    ORDER BY order_key COLLATE "C", slot
  `.execute(db);
  return r.rows.map((f) => ({ ...f, config: (f.config ?? {}) as Record<string, unknown> }));
}

interface LinkInfo {
  relationId: string;
  side: "a" | "b";
  peerTableId: string;
}

async function loadLinkInfo(db: Db, fieldIds: string[]): Promise<Map<string, LinkInfo>> {
  const out = new Map<string, LinkInfo>();
  if (fieldIds.length === 0) return out;
  const r = await sql<{
    id: string;
    a_field_id: string;
    b_field_id: string | null;
    a_table_id: string;
    b_table_id: string;
  }>`
    SELECT id, a_field_id, b_field_id, a_table_id, b_table_id
    FROM data.link_relations
    WHERE a_field_id = ANY(${fieldIds}::uuid[]) OR b_field_id = ANY(${fieldIds}::uuid[])
  `.execute(db);
  for (const rel of r.rows) {
    if (fieldIds.includes(rel.a_field_id)) {
      out.set(rel.a_field_id, { relationId: rel.id, side: "a", peerTableId: rel.b_table_id });
    }
    if (rel.b_field_id && fieldIds.includes(rel.b_field_id)) {
      out.set(rel.b_field_id, { relationId: rel.id, side: "b", peerTableId: rel.a_table_id });
    }
  }
  return out;
}

/* ───────────────────────── primary display ───────────────────────── */

export interface PrimaryFieldInfo {
  slot: number;
  type: string;
  config: Record<string, unknown>;
  is_computed: boolean;
}

/**
 * Plain-text display of a stored value (used for link names and search parity).
 * Users are resolved through `users` when given.
 */
export function displayText(
  field: PrimaryFieldInfo,
  stored: unknown,
  row: { row_number?: string | number; created_at?: Date | string; updated_at?: Date | string | null },
  users?: Map<string, UserWire>,
): string {
  switch (field.type) {
    case "autonumber":
      return row.row_number !== undefined ? String(row.row_number) : "";
    case "created_time":
      return toIso(row.created_at) ?? "";
    case "modified_time":
      return toIso(row.updated_at ?? row.created_at) ?? "";
    default:
      break;
  }
  let v = stored;
  if (field.is_computed) v = unwrapComputed(stored).value;
  if (v === undefined || v === null) return "";
  if (field.type === "single_select" || field.type === "multi_select") {
    const opts = selectOptions(field.config);
    return asArray(v)
      .map((x) => {
        const id = normalizeOptionId(x, opts);
        return opts.find((o) => o.id === id)?.label ?? (typeof x === "string" ? x : "");
      })
      .filter((s) => s !== "")
      .join(", ");
  }
  if (field.type === "collaborator") {
    return asArray(v)
      .map((x) => {
        const id = idFromStored(x, "usr");
        return (id && users?.get(id)?.name) || "";
      })
      .filter((s) => s !== "")
      .join(", ");
  }
  if (field.type === "checkbox") return "";
  return scalarText(v);
}

function scalarText(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return v.map(scalarText).filter((s) => s !== "").join(", ");
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o["name"] === "string") return o["name"];
    if (typeof o["text"] === "string") return o["text"];
    if (typeof o["filename"] === "string") return o["filename"];
    if ("value" in o) return scalarText(o["value"]);
  }
  return "";
}

/* ───────────────────────── main entry ───────────────────────── */

export async function serializeRecords(
  db: Db,
  tableId: string,
  rows: readonly RecordRowLike[],
  opts: SerializeOptions = {},
): Promise<RecordWire[]> {
  if (rows.length === 0) return [];
  let fields = opts.fields ?? (await loadSerializeFields(db, tableId));
  if (opts.fieldIds) {
    const wanted = new Set(
      opts.fieldIds.map((f) => (f.startsWith("fld_") ? safeParse(f, "fld") : f)).filter((x): x is string => !!x),
    );
    fields = fields.filter((f) => wanted.has(f.id));
  }
  fields = fields.filter((f) => f.type !== "button");

  const recordIds = rows.map((r) => r.id);
  const linkFields = fields.filter((f) => f.type === "link" || f.type === "contact");
  const linkInfo = await loadLinkInfo(db, linkFields.map((f) => f.id));

  /* ---- links: fetch all (field, record) → peer ids in order ---- */
  const linksByField = new Map<string, Map<string, string[]>>();
  const peerIdsByTable = new Map<string, Set<string>>();
  if (linkInfo.size > 0) {
    const relIds = [...new Set([...linkInfo.values()].map((l) => l.relationId))];
    const lr = await sql<{
      relation_id: string;
      a_record_id: string;
      b_record_id: string;
      a_order: string;
      b_order: string;
    }>`
      SELECT relation_id, a_record_id, b_record_id, a_order, b_order
      FROM data.record_links
      WHERE relation_id = ANY(${relIds}::uuid[])
        AND deletion_batch_id IS NULL
        AND (a_record_id = ANY(${recordIds}::uuid[]) OR b_record_id = ANY(${recordIds}::uuid[]))
    `.execute(db);
    const recSet = new Set(recordIds);
    for (const f of linkFields) {
      const info = linkInfo.get(f.id);
      if (!info) continue;
      const tmp = new Map<string, { peer: string; ord: string }[]>();
      for (const l of lr.rows) {
        if (l.relation_id !== info.relationId) continue;
        const self = info.side === "a" ? l.a_record_id : l.b_record_id;
        const peer = info.side === "a" ? l.b_record_id : l.a_record_id;
        const ord = info.side === "a" ? l.a_order : l.b_order;
        if (!recSet.has(self)) continue;
        let arr = tmp.get(self);
        if (!arr) tmp.set(self, (arr = []));
        arr.push({ peer, ord });
      }
      const m = new Map<string, string[]>();
      for (const [self, arr] of tmp) {
        arr.sort((x, y) => (x.ord < y.ord ? -1 : x.ord > y.ord ? 1 : x.peer < y.peer ? -1 : 1));
        m.set(self, arr.map((x) => x.peer));
        let set = peerIdsByTable.get(info.peerTableId);
        if (!set) peerIdsByTable.set(info.peerTableId, (set = new Set()));
        for (const x of arr) set.add(x.peer);
      }
      linksByField.set(f.id, m);
    }
  }

  /* ---- peer records + their primary field ---- */
  const peerPrimary = new Map<string, PrimaryFieldInfo | null>();
  const peerRows = new Map<string, { cells: Record<string, unknown>; computed: Record<string, unknown>; row_number: string; created_at: Date; updated_at: Date }>();
  if (peerIdsByTable.size > 0) {
    const tableIds = [...peerIdsByTable.keys()];
    const pf = await sql<{ table_id: string; slot: number | null; type: string | null; config: Record<string, unknown> | null; is_computed: boolean | null }>`
      SELECT t.id AS table_id, f.slot, f.type, f.config, f.is_computed
      FROM data.tables t
      LEFT JOIN data.fields f ON f.id = t.primary_field_id AND f.deleted_at IS NULL
      WHERE t.id = ANY(${tableIds}::uuid[])
    `.execute(db);
    for (const p of pf.rows) {
      peerPrimary.set(
        p.table_id,
        p.slot !== null && p.type !== null
          ? { slot: p.slot, type: p.type, config: p.config ?? {}, is_computed: !!p.is_computed }
          : null,
      );
    }
    const allPeers = [...new Set([...peerIdsByTable.values()].flatMap((s) => [...s]))];
    const pr = await sql<{ id: string; table_id: string; cells: Record<string, unknown>; computed: Record<string, unknown>; row_number: string; created_at: Date; updated_at: Date }>`
      SELECT id, table_id, cells, computed, row_number, created_at, updated_at
      FROM data.records
      WHERE table_id = ANY(${tableIds}::uuid[]) AND id = ANY(${allPeers}::uuid[]) AND deleted_at IS NULL
    `.execute(db);
    for (const p of pr.rows) peerRows.set(p.id, p);
  }

  /* ---- collect user + attachment ids ---- */
  const userIds = new Set<string>();
  const attIds = new Set<string>();
  const lookupTargets = await loadLookupTargetTypes(db, fields);
  for (const row of rows) {
    if (row.created_by) userIds.add(row.created_by);
    if (row.updated_by) userIds.add(row.updated_by);
    const cells = (row.cells ?? {}) as Record<string, unknown>;
    const computed = (row.computed ?? {}) as Record<string, unknown>;
    for (const f of fields) {
      const key = String(f.slot);
      if (f.type === "collaborator") {
        for (const x of asArray(cells[key])) {
          const id = idFromStored(x, "usr");
          if (id) userIds.add(id);
        }
      } else if (f.type === "attachment") {
        for (const x of asArray(cells[key])) {
          const id = idFromStored(x, "att");
          if (id) attIds.add(id);
        }
      } else if (f.type === "lookup") {
        const tt = lookupTargets.get(f.id);
        if (tt === "collaborator" || tt === "attachment") {
          for (const x of flatDeep(unwrapComputed(computed[key]).value)) {
            const id = idFromStored(x, tt === "collaborator" ? "usr" : "att");
            if (id) (tt === "collaborator" ? userIds : attIds).add(id);
          }
        }
      }
    }
  }
  for (const [tId, prim] of peerPrimary) {
    if (!prim || prim.type !== "collaborator") continue;
    for (const peerId of peerIdsByTable.get(tId) ?? []) {
      const p = peerRows.get(peerId);
      for (const x of asArray(p?.cells[String(prim.slot)])) {
        const id = idFromStored(x, "usr");
        if (id) userIds.add(id);
      }
    }
  }

  const users = await loadUsers(db, [...userIds]);
  const atts = await loadAttachments(db, [...attIds], opts.storage ?? null);

  /* ---- link names ---- */
  const linkName = (peerTableId: string, peerId: string): string => {
    const prim = peerPrimary.get(peerTableId);
    const p = peerRows.get(peerId);
    if (!prim || !p) return "";
    const stored = prim.is_computed ? p.computed[String(prim.slot)] : p.cells[String(prim.slot)];
    return displayText(prim, stored, p, users);
  };

  /* ---- build wire records ---- */
  const out: RecordWire[] = [];
  for (const row of rows) {
    const cells = (row.cells ?? {}) as Record<string, unknown>;
    const computed = (row.computed ?? {}) as Record<string, unknown>;
    const wireFields: Record<string, unknown> = {};
    const errors: Record<string, string> = {};
    for (const f of fields) {
      const key = String(f.slot);
      const fid = pid("fld", f.id);
      let value: unknown;
      switch (f.type) {
        case "autonumber":
          value = Number(row.row_number);
          break;
        case "created_time":
          value = toIso(row.created_at);
          break;
        case "modified_time":
          value = toIso(row.updated_at ?? row.created_at);
          break;
        case "created_by":
          value = row.created_by ? users.get(row.created_by) : undefined;
          break;
        case "modified_by":
          value = row.updated_by ? users.get(row.updated_by) : row.created_by ? users.get(row.created_by) : undefined;
          break;
        case "link":
        case "contact": {
          const info = linkInfo.get(f.id);
          const peers = linksByField.get(f.id)?.get(row.id) ?? [];
          value = info
            ? peers
                .filter((p) => peerRows.has(p))
                .map((p): LinkWire => ({ id: pid("rec", p), name: linkName(info.peerTableId, p) }))
            : undefined;
          break;
        }
        case "collaborator":
          value = asArray(cells[key])
            .map((x) => {
              const id = idFromStored(x, "usr");
              return id ? users.get(id) : undefined;
            })
            .filter((u): u is UserWire => !!u);
          break;
        case "attachment":
          value = asArray(cells[key])
            .map((x) => {
              const id = idFromStored(x, "att");
              return id ? atts.get(id) : undefined;
            })
            .filter((a): a is AttachmentWire => !!a);
          break;
        default: {
          if (f.is_computed) {
            const u = unwrapComputed(computed[key]);
            if (u.error) {
              errors[fid] = u.error;
              value = undefined;
            } else if (f.type === "lookup") {
              const arr = flatDeep(u.value).filter((x) => x !== null && x !== undefined && x !== "");
              const tt = lookupTargets.get(f.id);
              if (tt === "collaborator") {
                value = arr.map((x) => users.get(idFromStored(x, "usr") ?? "")).filter((x) => !!x);
              } else if (tt === "attachment") {
                value = arr.map((x) => atts.get(idFromStored(x, "att") ?? "")).filter((x) => !!x);
              } else {
                value = arr;
              }
            } else {
              value = normalizeComputedScalar(u.value);
            }
          } else {
            value = normalizeStored(f, cells[key]);
          }
        }
      }
      if (!isEmptyWireValue(value)) wireFields[fid] = value;
    }
    const rec: RecordWire = {
      id: pid("rec", row.id),
      version: Number(row.version),
      createdAt: toIso(row.created_at) ?? new Date(0).toISOString(),
      updatedAt: toIso(row.updated_at ?? row.created_at) ?? new Date(0).toISOString(),
      rowNumber: Number(row.row_number),
      manualOrder: row.manual_order,
      fields: wireFields,
    };
    if (Object.keys(errors).length > 0) rec.errors = errors;
    out.push(rec);
  }
  return out;
}

function safeParse(id: string, prefix: "fld"): string | null {
  try {
    return parsePid(id, prefix);
  } catch {
    return null;
  }
}

function flatDeep(v: unknown): unknown[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) return [v];
  return v.flatMap((x) => flatDeep(x));
}

function normalizeComputedScalar(v: unknown): unknown {
  if (typeof v === "number" && !Number.isFinite(v)) return undefined;
  return v;
}

/** Normalize a stored (non-computed, non-meta) cell into its wire shape. */
function normalizeStored(f: SerializeFieldRow, v: unknown): unknown {
  if (v === undefined || v === null) return undefined;
  switch (f.type) {
    case "text":
    case "long_text":
    case "email":
    case "url":
    case "phone":
      return typeof v === "string" ? v : scalarText(v);
    case "number":
    case "currency":
    case "percent":
    case "rating":
    case "duration":
      return toNumber(v);
    case "checkbox":
      return v === true || v === "true" || v === 1 ? true : undefined;
    case "date": {
      if (typeof v !== "string") return undefined;
      if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
      const d = new Date(v);
      return Number.isNaN(d.getTime()) ? v : d.toISOString().slice(0, 10);
    }
    case "datetime": {
      if (typeof v !== "string") return undefined;
      const d = new Date(v);
      return Number.isNaN(d.getTime()) ? v : d.toISOString();
    }
    case "single_select": {
      const opts = selectOptions(f.config);
      const first = Array.isArray(v) ? v[0] : v;
      return normalizeOptionId(first, opts) ?? undefined;
    }
    case "multi_select": {
      const opts = selectOptions(f.config);
      return asArray(v)
        .map((x) => normalizeOptionId(x, opts))
        .filter((x): x is string => !!x);
    }
    case "barcode":
      if (typeof v === "string") return v === "" ? undefined : { text: v };
      if (v && typeof v === "object" && typeof (v as Record<string, unknown>)["text"] === "string") {
        return (v as Record<string, unknown>)["text"] === "" ? undefined : v;
      }
      return undefined;
    default:
      return v;
  }
}

async function loadLookupTargetTypes(db: Db, fields: SerializeFieldRow[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const want = new Map<string, string>(); // lookup field id → target field uuid
  for (const f of fields) {
    if (f.type !== "lookup") continue;
    const raw = f.config["targetFieldId"] ?? f.config["lookupFieldId"];
    if (typeof raw !== "string") continue;
    const id = raw.startsWith("fld_") ? safeParse(raw, "fld") : UUID_RE.test(raw) ? raw : null;
    if (id) want.set(f.id, id);
  }
  if (want.size === 0) return out;
  const r = await sql<{ id: string; type: string }>`
    SELECT id, type FROM data.fields WHERE id = ANY(${[...new Set(want.values())]}::uuid[])
  `.execute(db);
  const types = new Map(r.rows.map((x) => [x.id, x.type]));
  for (const [lf, target] of want) {
    const t = types.get(target);
    if (t) out.set(lf, t);
  }
  return out;
}

export async function loadUsers(db: Db, ids: string[]): Promise<Map<string, UserWire>> {
  const out = new Map<string, UserWire>();
  const valid = ids.filter((i) => UUID_RE.test(i));
  if (valid.length === 0) return out;
  const r = await sql<{ id: string; email: string; display_name: string }>`
    SELECT id, email, display_name FROM core.users WHERE id = ANY(${valid}::uuid[])
  `.execute(db);
  for (const u of r.rows) {
    out.set(u.id, { id: pid("usr", u.id), name: u.display_name || u.email, email: u.email });
  }
  return out;
}

async function loadAttachments(
  db: Db,
  ids: string[],
  storage: TabulaStorage | null,
): Promise<Map<string, AttachmentWire>> {
  const out = new Map<string, AttachmentWire>();
  if (ids.length === 0) return out;
  const r = await sql<{ id: string; base_id: string; filename: string; mime: string; size_bytes: string; object_key: string; scan_status: string; j: Record<string, unknown> }>`
    SELECT a.id, a.base_id, a.filename, a.mime, a.size_bytes, a.object_key, a.scan_status, to_jsonb(a) AS j
    FROM data.attachments a
    WHERE a.id = ANY(${ids}::uuid[])
  `.execute(db);
  await Promise.all(
    r.rows.map(async (a) => {
      const apiPath = `/v1/bases/${pid("bas", a.base_id)}/attachments/${pid("att", a.id)}`;
      let url = apiPath;
      if (storage && a.scan_status !== "rejected") {
        try {
          url = (await storage.presignDownload(a.object_key)).url;
        } catch {
          url = apiPath;
        }
      }
      const w = a.j["width"];
      const h = a.j["height"];
      const isImage = a.mime.startsWith("image/");
      out.set(a.id, {
        id: pid("att", a.id),
        filename: a.filename,
        mime: a.mime,
        size: Number(a.size_bytes),
        url,
        thumbnailUrl: isImage ? url : null,
        width: typeof w === "number" ? w : null,
        height: typeof h === "number" ? h : null,
      });
    }),
  );
  return out;
}

/* ───────────────────────── convenience loaders ───────────────────────── */

export const RECORD_ROW_COLUMNS = sql.raw(
  "id, version, row_number, manual_order, cells, computed, created_at, updated_at, created_by, updated_by",
);

/** Load live rows by id (order preserved, missing/deleted ids skipped). */
export async function loadRecordRows(
  db: Db,
  tableId: string,
  recordIds: readonly string[],
): Promise<RecordRowLike[]> {
  if (recordIds.length === 0) return [];
  const r = await sql<RecordRowLike>`
    SELECT ${RECORD_ROW_COLUMNS}
    FROM data.records
    WHERE table_id = ${tableId} AND id = ANY(${[...recordIds]}::uuid[]) AND deleted_at IS NULL
  `.execute(db);
  const byId = new Map(r.rows.map((x) => [x.id, x]));
  return recordIds.map((id) => byId.get(id)).filter((x): x is RecordRowLike => !!x);
}

/** Load + serialize records by uuid (order preserved). */
export async function serializeRecordsByIds(
  db: Db,
  tableId: string,
  recordIds: readonly string[],
  opts: SerializeOptions = {},
): Promise<RecordWire[]> {
  const rows = await loadRecordRows(db, tableId, recordIds);
  return serializeRecords(db, tableId, rows, opts);
}
