import { sql } from "kysely";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppContext } from "../../lib/app-context.js";
import { parsePid, pid } from "../../lib/public-ids.js";
import { notFound } from "../../http/errors.js";
import { resolveBaseContext, resolveTableContext } from "../access/helpers.js";
import { assertCan } from "../access/assert.js";
import { compileForUser } from "../access/compile.js";
import { LimitsService } from "../billing/limits-service.js";
import { handleWave4Error } from "../wave4/problems.js";
import {
  attachmentIdsFromCell,
  createPendingUpload,
  finalizeUpload,
  hydrateAttachments,
  loadAttachment,
  loadAttachmentById,
  sanitizeFilename,
  setAttachmentRuntime,
  storeUploadBody,
  toAttachmentWire,
  type AttachmentRow,
} from "./service.js";
import { MAX_UPLOAD_BYTES, resolveAttachmentStorage, verifyDownloadToken } from "./storage.js";

const presignBody = z.object({
  filename: z.string().min(1).max(255),
  mime: z.string().max(200).optional().default("application/octet-stream"),
  size: z.number().int().nonnegative(),
  tableId: z.string().optional(),
  recordId: z.string().optional(),
  fieldId: z.string().optional(),
});

const INLINE_MIME = /^(image\/(png|jpe?g|gif|webp|bmp)|application\/pdf|video\/|audio\/|text\/plain)/i;

/** Stream an attachment body with safe headers. */
export async function sendAttachmentBody(
  ctx: AppContext,
  reply: FastifyReply,
  row: AttachmentRow,
  download: boolean,
): Promise<void> {
  if (row.storage_driver !== "local") {
    if (!ctx.storage) {
      void reply.code(503).send({ detail: "Storage unavailable" });
      return;
    }
    const signed = await ctx.storage.presignDownload(row.object_key);
    void reply.redirect(signed.url, 302);
    return;
  }
  const storage = resolveAttachmentStorage(ctx);
  if (!storage) {
    void reply.code(503).send({ detail: "Storage unavailable" });
    return;
  }
  const stream = await storage.openReadStream(row.object_key);
  const inline = !download && INLINE_MIME.test(row.mime);
  const filename = sanitizeFilename(row.filename).replace(/"/g, "");
  void reply
    .header("Content-Type", row.mime || "application/octet-stream")
    .header("Content-Length", String(row.size_bytes))
    .header("X-Content-Type-Options", "nosniff")
    .header("Content-Security-Policy", "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox")
    .header("Cache-Control", "private, max-age=3600")
    .header(
      "Content-Disposition",
      `${inline ? "inline" : "attachment"}; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(row.filename)}`,
    )
    .send(stream);
}

export async function registerAttachmentsRoutes(
  app: FastifyInstance,
  ctx: AppContext,
): Promise<void> {
  setAttachmentRuntime(ctx);
  const limits = new LimitsService(ctx.db);

  async function baseFor(request: FastifyRequest, reply: FastifyReply, baseParam: string) {
    const user = request.user;
    if (!user) {
      notFound(request, reply);
      return null;
    }
    const baseId = parsePid(baseParam, "bas");
    const base = await resolveBaseContext(ctx.db, user.id, baseId);
    if (!base.ok) {
      notFound(request, reply, "Base not found");
      return null;
    }
    return { user, baseId, base };
  }

  app.post<{ Params: { baseId: string } }>(
    "/v1/bases/:baseId/attachments/presign",
    async (request, reply) => {
      try {
        const scope = await baseFor(request, reply, request.params.baseId);
        if (!scope) return;
        const { user, baseId, base } = scope;
        const snapshot = await compileForUser(ctx.db, user.id, baseId);
        assertCan(snapshot, "record.update");

        const body = presignBody.parse(request.body);
        await limits.assertAttachmentBytes(base.orgId, baseId, body.size);

        const tableId = body.tableId ? parsePid(body.tableId, "tbl") : null;
        const recordId = body.recordId ? parsePid(body.recordId, "rec") : null;
        const fieldId = body.fieldId ? parsePid(body.fieldId, "fld") : null;

        const { attachmentId, upload } = await createPendingUpload(ctx, {
          workspaceId: base.workspaceId,
          baseId,
          userId: user.id,
          filename: body.filename,
          mime: body.mime,
          size: body.size,
          tableId,
          recordId,
          fieldId,
          maxBytes: MAX_UPLOAD_BYTES,
          apiUploadUrl: (id) =>
            `/v1/bases/${pid("bas", baseId)}/attachments/${pid("att", id)}/upload`,
        });

        void reply.code(201).send({
          attachmentId: pid("att", attachmentId),
          upload,
        });
      } catch (err) {
        handleWave4Error(request, reply, err);
      }
    },
  );

  // Proxied upload body (local driver). Encapsulated so the raw-body parser
  // does not leak into other routes.
  await app.register(async (sub) => {
    sub.removeAllContentTypeParsers();
    sub.addContentTypeParser(
      "*",
      { parseAs: "buffer", bodyLimit: MAX_UPLOAD_BYTES },
      (_req, body, done) => done(null, body),
    );

    sub.put<{ Params: { baseId: string; attachmentId: string } }>(
      "/v1/bases/:baseId/attachments/:attachmentId/upload",
      { bodyLimit: MAX_UPLOAD_BYTES },
      async (request, reply) => {
        try {
          const scope = await baseFor(request, reply, request.params.baseId);
          if (!scope) return;
          const attachmentId = parsePid(request.params.attachmentId, "att");
          const row = await loadAttachment(ctx.db, attachmentId, scope.baseId);
          if (!row || row.created_by !== scope.user.id) {
            notFound(request, reply, "Attachment not found");
            return;
          }
          const body = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
          await storeUploadBody(ctx, row, body, MAX_UPLOAD_BYTES);
          void reply.code(204).send();
        } catch (err) {
          handleWave4Error(request, reply, err);
        }
      },
    );
  });

  app.post<{ Params: { baseId: string } }>(
    "/v1/bases/:baseId/attachments/complete",
    async (request, reply) => {
      try {
        const scope = await baseFor(request, reply, request.params.baseId);
        if (!scope) return;
        const body = z.object({ attachmentId: z.string() }).parse(request.body);
        const attachmentId = parsePid(body.attachmentId, "att");
        const row = await loadAttachment(ctx.db, attachmentId, scope.baseId);
        if (!row || row.created_by !== scope.user.id) {
          notFound(request, reply, "Attachment not found");
          return;
        }
        const attachment = await finalizeUpload(ctx, row, MAX_UPLOAD_BYTES);
        void reply.send({ attachment, scanStatus: "clean" });
      } catch (err) {
        handleWave4Error(request, reply, err);
      }
    },
  );

  app.get<{ Params: { baseId: string; attachmentId: string } }>(
    "/v1/bases/:baseId/attachments/:attachmentId",
    async (request, reply) => {
      try {
        const scope = await baseFor(request, reply, request.params.baseId);
        if (!scope) return;
        const attachmentId = parsePid(request.params.attachmentId, "att");
        const row = await loadAttachment(ctx.db, attachmentId, scope.baseId);
        if (!row) {
          notFound(request, reply, "Attachment not found");
          return;
        }
        const wire = await toAttachmentWire(ctx, row);
        void reply.send({
          attachment: {
            ...wire,
            // legacy aliases
            sizeBytes: wire.size,
            downloadUrl: wire.url,
            scanStatus: row.scan_status,
            createdAt: row.created_at.toISOString(),
            recordId: row.record_id ? pid("rec", row.record_id) : null,
          },
        });
      } catch (err) {
        handleWave4Error(request, reply, err);
      }
    },
  );

  app.get<{ Params: { baseId: string; attachmentId: string }; Querystring: { download?: string } }>(
    "/v1/bases/:baseId/attachments/:attachmentId/content",
    async (request, reply) => {
      try {
        const scope = await baseFor(request, reply, request.params.baseId);
        if (!scope) return;
        const attachmentId = parsePid(request.params.attachmentId, "att");
        const row = await loadAttachment(ctx.db, attachmentId, scope.baseId);
        if (!row || row.scan_status !== "clean") {
          notFound(request, reply, "Attachment not found");
          return;
        }
        await sendAttachmentBody(ctx, reply, row, request.query.download === "1");
      } catch (err) {
        handleWave4Error(request, reply, err);
      }
    },
  );

  // Signed download URL (what `url` in the record wire format points at for
  // the local driver). Works without a session so <img> tags and the public
  // share app can load files; the HMAC token expires.
  app.get<{ Params: { token: string; filename?: string }; Querystring: { download?: string } }>(
    "/v1/public/files/:token/:filename",
    async (request, reply) => {
      try {
        const attId = verifyDownloadToken(ctx, request.params.token);
        if (!attId) {
          notFound(request, reply, "File not found or link expired");
          return;
        }
        const row = await loadAttachmentById(ctx.db, attId);
        if (!row || row.scan_status !== "clean") {
          notFound(request, reply, "File not found");
          return;
        }
        await sendAttachmentBody(ctx, reply, row, request.query.download === "1");
      } catch (err) {
        handleWave4Error(request, reply, err);
      }
    },
  );

  // Attachments referenced by a record's attachment cells.
  app.get<{ Params: { baseId: string; tableId: string; recordId: string } }>(
    "/v1/bases/:baseId/tables/:tableId/records/:recordId/attachments",
    async (request, reply) => {
      try {
        const user = request.user;
        if (!user) {
          notFound(request, reply);
          return;
        }
        const baseId = parsePid(request.params.baseId, "bas");
        const tableId = parsePid(request.params.tableId, "tbl");
        const recordId = parsePid(request.params.recordId, "rec");
        const table = await resolveTableContext(ctx.db, user.id, baseId, tableId);
        if (!table.ok) {
          notFound(request, reply, "Table not found");
          return;
        }
        const rec = await sql<{ cells: Record<string, unknown> }>`
          SELECT cells FROM data.records
          WHERE table_id = ${tableId} AND id = ${recordId} AND deleted_at IS NULL
          LIMIT 1
        `.execute(ctx.db);
        const cells = rec.rows[0]?.cells;
        if (!cells) {
          notFound(request, reply, "Record not found");
          return;
        }
        const fields = await sql<{ id: string; slot: number }>`
          SELECT id, slot FROM data.fields
          WHERE table_id = ${tableId} AND type = 'attachment' AND deleted_at IS NULL
        `.execute(ctx.db);
        const pairs: { fieldId: string; attId: string }[] = [];
        for (const f of fields.rows) {
          for (const attId of attachmentIdsFromCell(cells[String(f.slot)])) {
            pairs.push({ fieldId: f.id, attId });
          }
        }
        const map = await hydrateAttachments(ctx.db, pairs.map((p) => p.attId));
        void reply.send({
          attachments: pairs
            .map((p) => {
              const wire = map.get(p.attId);
              return wire ? { ...wire, fieldId: pid("fld", p.fieldId) } : null;
            })
            .filter(Boolean),
        });
      } catch (err) {
        handleWave4Error(request, reply, err);
      }
    },
  );
}
