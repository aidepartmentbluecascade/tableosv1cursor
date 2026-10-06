import { generateUuidV7 } from "@tabula/types";
import { QueueNames, createQueue } from "@tabula/jobs";
import { sql } from "kysely";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../../lib/app-context.js";
import { parsePid, pid } from "../../lib/public-ids.js";
import {
  handleRouteError,
  notFound,
  validationProblem,
} from "../../http/errors.js";
import { resolveBaseContext } from "../access/helpers.js";
import { LimitsService } from "../billing/limits-service.js";

const presignBody = z.object({
  filename: z.string().min(1).max(255),
  mime: z.string().min(1).max(200),
  size: z.number().int().nonnegative(),
});

export async function registerAttachmentsRoutes(
  app: FastifyInstance,
  ctx: AppContext,
): Promise<void> {
  const limits = new LimitsService(ctx.db);

  app.post<{ Params: { baseId: string } }>(
    "/v1/bases/:baseId/attachments/presign",
    async (request, reply) => {
      try {
        const user = request.user;
        if (!user) {
          notFound(request, reply);
          return;
        }
        if (!ctx.storage) {
          validationProblem(request, reply, "Object storage is not configured");
          return;
        }

        const baseId = parsePid(request.params.baseId, "bas");
        const base = await resolveBaseContext(ctx.db, user.id, baseId);
        if (!base.ok) {
          notFound(request, reply, "Base not found");
          return;
        }

        const body = presignBody.parse(request.body);
        await limits.assertAttachmentBytes(base.orgId, baseId, body.size);

        const attachmentId = generateUuidV7();
        const objectKey = `attachments/${base.workspaceId}/${baseId}/${attachmentId}/${body.filename}`;

        await sql`
          INSERT INTO data.attachments (
            id, workspace_id, base_id, filename, mime, size_bytes, object_key,
            scan_status, created_by
          ) VALUES (
            ${attachmentId}, ${base.workspaceId}, ${baseId}, ${body.filename},
            ${body.mime}, ${body.size}, ${objectKey}, 'pending', ${user.id}
          )
        `.execute(ctx.db);

        const upload = await ctx.storage.presignUpload(objectKey, body.mime);

        void reply.code(201).send({
          attachmentId: pid("att", attachmentId),
          objectKey,
          upload,
        });
      } catch (err) {
        handleRouteError(request, reply, err);
      }
    },
  );

  app.post<{ Params: { baseId: string } }>(
    "/v1/bases/:baseId/attachments/complete",
    async (request, reply) => {
      try {
        const user = request.user;
        if (!user) {
          notFound(request, reply);
          return;
        }

        const baseId = parsePid(request.params.baseId, "bas");
        const base = await resolveBaseContext(ctx.db, user.id, baseId);
        if (!base.ok) {
          notFound(request, reply, "Base not found");
          return;
        }

        const body = z
          .object({ attachmentId: z.string() })
          .parse(request.body);
        const attachmentId = parsePid(body.attachmentId, "att");

        const updated = await sql<{ id: string }>`
          UPDATE data.attachments
          SET scan_status = 'scanning'
          WHERE id = ${attachmentId}
            AND base_id = ${baseId}
            AND created_by = ${user.id}
          RETURNING id
        `.execute(ctx.db);

        if (!updated.rows[0]) {
          notFound(request, reply, "Attachment not found");
          return;
        }

        if (ctx.redis) {
          const queue = createQueue(QueueNames.FILE_SCAN, ctx.redis);
          await queue.add("scan", { attachmentId });
        } else {
          await sql`
            UPDATE data.attachments SET scan_status = 'clean' WHERE id = ${attachmentId}
          `.execute(ctx.db);
        }

        void reply.send({ attachmentId: pid("att", attachmentId), scanStatus: "scanning" });
      } catch (err) {
        handleRouteError(request, reply, err);
      }
    },
  );

  app.get<{ Params: { baseId: string; attachmentId: string } }>(
    "/v1/bases/:baseId/attachments/:attachmentId",
    async (request, reply) => {
      try {
        const user = request.user;
        if (!user) {
          notFound(request, reply);
          return;
        }

        const baseId = parsePid(request.params.baseId, "bas");
        const attachmentId = parsePid(request.params.attachmentId, "att");
        const base = await resolveBaseContext(ctx.db, user.id, baseId);
        if (!base.ok) {
          notFound(request, reply, "Base not found");
          return;
        }

        const row = await sql<{
          id: string;
          filename: string;
          mime: string;
          size_bytes: string;
          scan_status: string;
          created_at: Date;
        }>`
          SELECT id, filename, mime, size_bytes, scan_status, created_at
          FROM data.attachments
          WHERE id = ${attachmentId} AND base_id = ${baseId}
          LIMIT 1
        `.execute(ctx.db);

        const att = row.rows[0];
        if (!att) {
          notFound(request, reply, "Attachment not found");
          return;
        }

        let downloadUrl: string | undefined;
        if (ctx.storage && att.scan_status === "clean") {
          const attKey = await sql<{ object_key: string }>`
            SELECT object_key FROM data.attachments WHERE id = ${attachmentId}
          `.execute(ctx.db);
          const key = attKey.rows[0]?.object_key;
          if (key) {
            downloadUrl = (await ctx.storage.presignDownload(key)).url;
          }
        }

        void reply.send({
          attachment: {
            id: pid("att", att.id),
            filename: att.filename,
            mime: att.mime,
            sizeBytes: Number(att.size_bytes),
            scanStatus: att.scan_status,
            createdAt: att.created_at.toISOString(),
            ...(downloadUrl ? { downloadUrl } : {}),
          },
        });
      } catch (err) {
        handleRouteError(request, reply, err);
      }
    },
  );
}
