import type { ServerMessage } from "@tabula/realtime-protocol";
import { pid } from "../lib/public-ids.js";

type ChangeFrame = Extract<ServerMessage, { type: "change" }>;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Op-name prefixes that change schema (tables, fields, views, base). */
const SCHEMA_OP_PREFIXES = [
  "base.",
  "table.",
  "tables.",
  "field.",
  "fields.",
  "view.",
  "views.",
  "link_fields.",
  "section.",
];

const SCHEMA_KINDS = new Set(["schema", "views"]);

const ID_KEYS: Record<string, "rec" | "tbl" | "fld" | "viw" | "bas" | "usr"> = {
  recordId: "rec",
  tableId: "tbl",
  fieldId: "fld",
  viewId: "viw",
  baseId: "bas",
  userId: "usr",
  linkedTableId: "tbl",
  inverseFieldId: "fld",
};

const ID_LIST_KEYS: Record<string, "rec" | "tbl" | "fld" | "viw"> = {
  recordIds: "rec",
  tableIds: "tbl",
  fieldIds: "fld",
  viewIds: "viw",
};

/** Scalar keys that are safe to forward as-is. */
const PASSTHROUGH_KEYS = new Set(["op", "name", "type", "count"]);

function toPublic(prefix: Parameters<typeof pid>[0], value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (/^[a-z]{3}_/.test(value)) return value; // already public
  if (!UUID_RE.test(value)) return null;
  try {
    return pid(prefix, value);
  } catch {
    return null;
  }
}

function opName(op: unknown): string {
  if (op && typeof op === "object" && typeof (op as { op?: unknown }).op === "string") {
    return (op as { op: string }).op;
  }
  return "";
}

export function isSchemaOp(name: string): boolean {
  return SCHEMA_OP_PREFIXES.some((p) => name.startsWith(p));
}

/** Translate one internal op into a client-facing hint with public ids. */
export function translateOp(op: unknown): Record<string, unknown> {
  if (!op || typeof op !== "object") return { op: "unknown" };
  const src = op as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(src)) {
    const prefix = ID_KEYS[key];
    if (prefix) {
      const v = toPublic(prefix, value);
      if (v) out[key] = v;
      continue;
    }
    const listPrefix = ID_LIST_KEYS[key];
    if (listPrefix && Array.isArray(value)) {
      out[key] = value
        .map((v) => toPublic(listPrefix, v))
        .filter((v): v is string => v !== null);
      continue;
    }
    if (PASSTHROUGH_KEYS.has(key) && (typeof value === "string" || typeof value === "number")) {
      out[key] = value;
    }
  }
  if (!out["op"]) out["op"] = "unknown";
  return out;
}

function collectRecordIds(ops: unknown[]): string[] {
  const ids = new Set<string>();
  for (const op of ops) {
    if (!op || typeof op !== "object") continue;
    const o = op as Record<string, unknown>;
    if (typeof o["recordId"] === "string") ids.add(o["recordId"]);
    if (Array.isArray(o["recordIds"])) {
      for (const r of o["recordIds"]) if (typeof r === "string") ids.add(r);
    }
    for (const key of ["aRecordId", "bRecordId", "fromRecordId", "toRecordId"]) {
      if (typeof o[key] === "string") ids.add(o[key] as string);
    }
  }
  return [...ids];
}

function collectOpTableIds(ops: unknown[]): string[] {
  const ids = new Set<string>();
  for (const op of ops) {
    if (!op || typeof op !== "object") continue;
    const o = op as Record<string, unknown>;
    if (typeof o["tableId"] === "string") ids.add(o["tableId"]);
  }
  return [...ids];
}

export interface InternalChange {
  baseId: string;
  seq: number;
  kind?: string | null;
  tableIds?: string[] | null;
  ops: unknown[];
  clientMutationId?: string | null;
  actor: { type: "user" | "system"; id: string | null };
}

/**
 * Turn an internal change (raw uuids, slot-keyed cells) into the client frame
 * defined in `@tabula/realtime-protocol` (public ids only; no raw cells).
 */
export function toClientChangeFrame(change: InternalChange): ChangeFrame {
  const ops = Array.isArray(change.ops) ? change.ops : [];
  const kind = change.kind ?? undefined;
  const opNames = ops.map(opName);
  const schemaChanged =
    (kind !== undefined && SCHEMA_KINDS.has(kind)) || opNames.some(isSchemaOp);
  const hasRecordOps = opNames.some(
    (n) => n.startsWith("record") || n.startsWith("link") || n === "unknown" || n === "",
  );

  const rawTableIds = new Set<string>([
    ...(change.tableIds ?? []),
    ...collectOpTableIds(ops),
  ]);
  const tableIds = [...rawTableIds]
    .map((t) => toPublic("tbl", t))
    .filter((t): t is string => t !== null);

  const recordsTouched =
    hasRecordOps ||
    kind === "records" ||
    kind === "bulk" ||
    kind === "links" ||
    // field type changes / deletes / restores rewrite cell data too
    (schemaChanged && tableIds.length > 0);

  const recordIds = collectRecordIds(ops)
    .map((r) => toPublic("rec", r))
    .filter((r): r is string => r !== null);

  const frame: ChangeFrame = {
    type: "change",
    baseId: toPublic("bas", change.baseId) ?? change.baseId,
    seq: change.seq,
    tableIds,
    recordTableIds: recordsTouched ? tableIds : [],
    recordIds,
    recordsChanged: recordsTouched,
    schemaChanged,
    clientMutationId: change.clientMutationId ?? null,
    ops: ops.map(translateOp),
    actor: {
      type: change.actor.type === "system" ? "system" : "user",
      id: change.actor.id ? toPublic("usr", change.actor.id) : null,
    },
  };
  if (kind !== undefined) frame.kind = kind;
  if (tableIds[0]) frame.tableId = tableIds[0];
  return frame;
}
