import { decodePublicId, generateUuidV7 } from "@tabula/types";
import {
  isImageMime,
  readImageSize,
  sniffMime,
  type PresignedUpload,
  type TabulaStorage,
} from "@tabula/storage";
import type { TabulaDb } from "@tabula/db";
import { sql } from "kysely";
import type { AppContext } from "../../lib/app-context.js";
import { pid } from "../../lib/public-ids.js";
import { resolveAttachmentStorage, signDownloadToken } from "./storage.js";

/** CONTRACTS §3 attachment cell element. */
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

export interface AttachmentRow {
  id: string;
  workspace_id: string;
  base_id: string;
  filename: string;
  mime: string;
  size_bytes: string | number;
  object_key: string;
  scan_status: string;
  storage_driver: string;
  width: number | null;
  height: number | null;
  created_by: string | null;
  share_link_id: string | null;
  record_id: string | null;
  created_at: Date;
}

export class StorageUnavailableError extends Error {
  constructor() {
    super("File storage is not configured on this server");
    this.name = "StorageUnavailableError";
  }
}

export class UploadRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UploadRejectedError";
  }
}

let runtimeCtx: AppContext | null = null;

/** Called once at route registration so helpers used elsewhere can sign URLs. */
export function setAttachmentRuntime(ctx: AppContext): void {
  runtimeCtx = ctx;
}

const BLOCKED_MIME = /^(application\/(x-msdownload|x-msdos-program|x-sh|x-executable)|text\/html)$/i;

export function sanitizeFilename(name: string): string {
  const base = name.replace(/[\\/]/g, "_").replace(/[\u0000-\u001f]/g, "").trim();
  return (base || "file").slice(0, 200);
}

function objectKeyFor(workspaceId: string, baseId: string, attId: string, filename: string): string {
  const safe = sanitizeFilename(filename).replace(/[^A-Za-z0-9._-]/g, "_");
  return `attachments/${workspaceId}/${baseId}/${attId}/${safe}`;
}

/** Stable-ish signed URL: the expiry is bucketed so the same URL is reused for hours (browser cache). */
function localDownloadUrl(ctx: AppContext, attId: string, filename: string): string {
  const bucket = 6 * 60 * 60 * 1000;
  const exp = Math.ceil(Date.now() / bucket) * bucket + 24 * 60 * 60 * 1000;
  const token = signDownloadToken(ctx, attId, exp);
  return `/v1/public/files/${token}/${encodeURIComponent(sanitizeFilename(filename))}`;
}

export async function downloadUrlFor(
  ctx: AppContext,
  row: Pick<AttachmentRow, "id" | "filename" | "object_key" | "storage_driver">,
): Promise<string> {
  if (row.storage_driver === "local") {
    return localDownloadUrl(ctx, row.id, row.filename);
  }
  const storage = ctx.storage;
  if (!storage) return localDownloadUrl(ctx, row.id, row.filename);
  return (await storage.presignDownload(row.object_key)).url;
}

export async function toAttachmentWire(ctx: AppContext, row: AttachmentRow): Promise<AttachmentWire> {
  let url = "";
  try {
    url = await downloadUrlFor(ctx, row);
  } catch {
    url = "";
  }
  const image = isImageMime(row.mime);
  return {
    id: pid("att", row.id),
    filename: row.filename,
    mime: row.mime,
    size: Number(row.size_bytes),
    url,
    // No thumbnail pipeline yet: images use the original URL.
    thumbnailUrl: image ? url : null,
    width: row.width ?? null,
    height: row.height ?? null,
  };
}

const ATT_COLUMNS = sql`
  id, workspace_id, base_id, filename, mime, size_bytes, object_key, scan_status,
  storage_driver, width, height, created_by, share_link_id, record_id, created_at
`;

export async function loadAttachment(
  db: TabulaDb,
  attachmentId: string,
  baseId: string,
): Promise<AttachmentRow | null> {
  const res = await sql<AttachmentRow>`
    SELECT ${ATT_COLUMNS} FROM data.attachments
    WHERE id = ${attachmentId} AND base_id = ${baseId}
    LIMIT 1
  `.execute(db);
  return res.rows[0] ?? null;
}

export async function loadAttachmentById(
  db: TabulaDb,
  attachmentId: string,
): Promise<AttachmentRow | null> {
  const res = await sql<AttachmentRow>`
    SELECT ${ATT_COLUMNS} FROM data.attachments WHERE id = ${attachmentId} LIMIT 1
  `.execute(db);
  return res.rows[0] ?? null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Accepts `att_…`, raw uuids, or `{id}` objects; returns raw uuids. */
export function attachmentIdsFromCell(value: unknown): string[] {
  const list = Array.isArray(value) ? value : value == null ? [] : [value];
  const out: string[] = [];
  for (const item of list) {
    const raw =
      typeof item === "string"
        ? item
        : item && typeof item === "object" && typeof (item as { id?: unknown }).id === "string"
          ? (item as { id: string }).id
          : null;
    if (!raw) continue;
    if (UUID_RE.test(raw)) {
      out.push(raw.toLowerCase());
      continue;
    }
    if (raw.startsWith("att_")) {
      try {
        out.push(decodeAtt(raw));
      } catch {
        /* ignore malformed */
      }
    }
  }
  return out;
}

function decodeAtt(value: string): string {
  return decodePublicId(value, "att").uuid;
}

/**
 * Hydrate attachment ids to wire objects (CONTRACTS §3). Used by the record
 * serializer (A) and the public share endpoints. Missing / rejected ids are
 * dropped from the map.
 */
export async function hydrateAttachments(
  db: TabulaDb,
  ids: string[],
): Promise<Map<string, AttachmentWire>> {
  const out = new Map<string, AttachmentWire>();
  const unique = [...new Set(ids)].filter((id) => UUID_RE.test(id));
  if (unique.length === 0 || !runtimeCtx) return out;
  const res = await sql<AttachmentRow>`
    SELECT ${ATT_COLUMNS} FROM data.attachments
    WHERE id = ANY(${unique}::uuid[]) AND scan_status <> 'rejected'
  `.execute(db);
  for (const row of res.rows) {
    out.set(row.id, await toAttachmentWire(runtimeCtx, row));
  }
  return out;
}

/** Convenience: turn a raw attachment cell into wire objects (order preserved). */
export async function hydrateAttachmentCell(
  db: TabulaDb,
  value: unknown,
): Promise<AttachmentWire[]> {
  const ids = attachmentIdsFromCell(value);
  const map = await hydrateAttachments(db, ids);
  return ids.map((id) => map.get(id)).filter((v): v is AttachmentWire => Boolean(v));
}

// ── Upload lifecycle ────────────────────────────────────────────────────────

export interface PendingUploadInput {
  workspaceId: string;
  baseId: string;
  userId: string | null;
  shareLinkId?: string | null;
  filename: string;
  mime: string;
  size: number;
  tableId?: string | null;
  recordId?: string | null;
  fieldId?: string | null;
  maxBytes: number;
  /** Builds the API upload URL for drivers without presigned uploads. */
  apiUploadUrl: (attachmentId: string) => string;
}

export async function createPendingUpload(
  ctx: AppContext,
  input: PendingUploadInput,
): Promise<{ attachmentId: string; upload: PresignedUpload; storage: TabulaStorage }> {
  const storage = resolveAttachmentStorage(ctx);
  if (!storage) throw new StorageUnavailableError();
  if (input.size > input.maxBytes) {
    throw new UploadRejectedError(
      `File is too large (max ${Math.round(input.maxBytes / (1024 * 1024))} MB)`,
    );
  }
  const mime = (input.mime || "application/octet-stream").toLowerCase();
  if (BLOCKED_MIME.test(mime)) {
    throw new UploadRejectedError(`Files of type ${mime} are not allowed`);
  }
  const filename = sanitizeFilename(input.filename);
  const attachmentId = generateUuidV7();
  const objectKey = objectKeyFor(input.workspaceId, input.baseId, attachmentId, filename);

  await sql`
    INSERT INTO data.attachments (
      id, workspace_id, base_id, filename, mime, size_bytes, object_key,
      scan_status, created_by, storage_driver, table_id, record_id, field_id, share_link_id
    ) VALUES (
      ${attachmentId}, ${input.workspaceId}, ${input.baseId}, ${filename},
      ${mime}, ${input.size}, ${objectKey}, 'pending', ${input.userId},
      ${storage.driver}, ${input.tableId ?? null}, ${input.recordId ?? null},
      ${input.fieldId ?? null}, ${input.shareLinkId ?? null}
    )
  `.execute(ctx.db);

  const upload: PresignedUpload =
    storage.driver === "local"
      ? {
          url: input.apiUploadUrl(attachmentId),
          method: "PUT",
          headers: { "Content-Type": mime },
        }
      : await storage.presignUpload(objectKey, mime);

  return { attachmentId, upload, storage };
}

/** Body of a proxied upload (local driver). */
export async function storeUploadBody(
  ctx: AppContext,
  row: AttachmentRow,
  body: Buffer,
  maxBytes: number,
): Promise<void> {
  const storage = resolveAttachmentStorage(ctx);
  if (!storage) throw new StorageUnavailableError();
  if (row.scan_status !== "pending") {
    throw new UploadRejectedError("Upload already completed");
  }
  if (body.length > maxBytes) {
    throw new UploadRejectedError("File is too large");
  }
  await storage.putObject(row.object_key, body, row.mime);
}

/**
 * Verify the stored object (exists, real size within limits, sniffed type
 * consistent with the declared type), record image dimensions and mark clean.
 */
export async function finalizeUpload(
  ctx: AppContext,
  row: AttachmentRow,
  maxBytes: number,
): Promise<AttachmentWire> {
  const storage =
    row.storage_driver === "local"
      ? resolveAttachmentStorage(ctx)
      : ctx.storage;
  if (!storage) throw new StorageUnavailableError();

  if (row.scan_status === "clean") {
    return toAttachmentWire(ctx, row);
  }
  if (row.scan_status === "rejected") {
    throw new UploadRejectedError("Upload was rejected");
  }

  const head = await storage.headObject(row.object_key);
  if (!head) {
    throw new UploadRejectedError("File has not been uploaded yet");
  }
  if (head.size > maxBytes) {
    await reject(ctx, row, storage);
    throw new UploadRejectedError("File is too large");
  }

  const prefix = await storage.readPrefix(row.object_key, 128 * 1024);
  const sniffed = sniffMime(prefix);
  let mime = row.mime;
  if (sniffed) {
    if (sniffed !== mime && !(sniffed === "application/zip" && /officedocument|zip|epub|jar/.test(mime))) {
      // Declared an image but content is something else → reject (spoofing).
      if (isImageMime(mime) && !isImageMime(sniffed)) {
        await reject(ctx, row, storage);
        throw new UploadRejectedError("File content does not match its type");
      }
      if (isImageMime(sniffed) || mime === "application/octet-stream") mime = sniffed;
    }
  } else if (isImageMime(mime) && mime !== "image/svg+xml") {
    await reject(ctx, row, storage);
    throw new UploadRejectedError("File content does not match its type");
  }

  const dims = isImageMime(mime) ? readImageSize(prefix) : null;

  const updated = await sql<AttachmentRow>`
    UPDATE data.attachments
    SET scan_status = 'clean',
        mime = ${mime},
        size_bytes = ${head.size},
        width = ${dims?.width ?? null},
        height = ${dims?.height ?? null},
        uploaded_at = now()
    WHERE id = ${row.id}
    RETURNING ${ATT_COLUMNS}
  `.execute(ctx.db);
  const fresh = updated.rows[0] ?? row;
  return toAttachmentWire(ctx, fresh);
}

async function reject(ctx: AppContext, row: AttachmentRow, storage: TabulaStorage): Promise<void> {
  await sql`
    UPDATE data.attachments SET scan_status = 'rejected' WHERE id = ${row.id}
  `.execute(ctx.db);
  await storage.deleteObject(row.object_key).catch(() => undefined);
}
