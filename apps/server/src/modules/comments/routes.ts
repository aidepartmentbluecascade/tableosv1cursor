import { CommentEvents } from "@tabula/events";
import { generateUuidV7 } from "@tabula/types";
import { sql } from "kysely";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../../lib/app-context.js";
import { publishDomainEvent } from "../../lib/domain-event.js";
import { parsePid, pid } from "../../lib/public-ids.js";
import { handleRouteError, notFound } from "../../http/errors.js";
import { resolveTableContext } from "../access/helpers.js";
import { parseMentions } from "./mentions.js";

const commentBody = z.object({
  body: z.string().min(1).max(10000),
  parentId: z.string().optional(),
});

export async function registerCommentsRoutes(
  app: FastifyInstance,
  ctx: AppContext,
): Promise<void> {
  app.get<{
    Params: { baseId: string; tableId: string; recordId: string };
  }>(
    "/v1/bases/:baseId/tables/:tableId/records/:recordId/comments",
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
          notFound(request, reply, "Record not found");
          return;
        }

        const rows = await sql<{
          id: string;
          parent_id: string | null;
          body: string;
          created_by: string | null;
          created_at: Date;
          updated_at: Date | null;
        }>`
          SELECT id, parent_id, body, created_by, created_at, updated_at
          FROM data.comments
          WHERE base_id = ${baseId}
            AND table_id = ${tableId}
            AND record_id = ${recordId}
            AND deleted_at IS NULL
          ORDER BY created_at ASC, id ASC
        `.execute(ctx.db);

        void reply.send({
          comments: rows.rows.map((c) => ({
            id: pid("cmt", c.id),
            parentId: c.parent_id ? pid("cmt", c.parent_id) : null,
            body: c.body,
            createdBy: c.created_by ? pid("usr", c.created_by) : null,
            createdAt: c.created_at.toISOString(),
            updatedAt: c.updated_at?.toISOString() ?? null,
          })),
        });
      } catch (err) {
        handleRouteError(request, reply, err);
      }
    },
  );

  app.post<{
    Params: { baseId: string; tableId: string; recordId: string };
  }>(
    "/v1/bases/:baseId/tables/:tableId/records/:recordId/comments",
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
          notFound(request, reply, "Record not found");
          return;
        }

        const body = commentBody.parse(request.body);
        const commentId = generateUuidV7();
        const parentId = body.parentId
          ? parsePid(body.parentId, "cmt")
          : null;

        await ctx.db.transaction().execute(async (trx) => {
          await sql`
            INSERT INTO data.comments (
              id, workspace_id, base_id, table_id, record_id, parent_id, body, created_by
            ) VALUES (
              ${commentId}, ${table.workspaceId}, ${baseId}, ${tableId}, ${recordId},
              ${parentId}, ${body.body}, ${user.id}
            )
          `.execute(trx);

          await sql`
            INSERT INTO data.record_subscriptions (
              workspace_id, base_id, table_id, record_id, user_id
            ) VALUES (
              ${table.workspaceId}, ${baseId}, ${tableId}, ${recordId}, ${user.id}
            )
            ON CONFLICT DO NOTHING
          `.execute(trx);

          for (const mention of parseMentions(body.body)) {
            await sql`
              INSERT INTO data.mentions (id, comment_id, principal_type, principal_id)
              VALUES (${generateUuidV7()}, ${commentId}, ${mention.principalType}, ${mention.principalId})
            `.execute(trx);
          }
        });

        await publishDomainEvent(ctx.eventBus, {
          type: CommentEvents.CREATED,
          tenant: {
            orgId: table.orgId,
            workspaceId: table.workspaceId,
            baseId,
          },
          actor: { type: "user", id: user.id, via: "api" },
          data: { commentId, recordId, tableId },
        });

        void reply.code(201).send({
          comment: {
            id: pid("cmt", commentId),
            body: body.body,
            createdAt: new Date().toISOString(),
          },
        });
      } catch (err) {
        handleRouteError(request, reply, err);
      }
    },
  );

  app.post<{ Params: { baseId: string; commentId: string } }>(
    "/v1/bases/:baseId/comments/:commentId/reactions",
    async (request, reply) => {
      try {
        const user = request.user;
        if (!user) {
          notFound(request, reply);
          return;
        }

        const baseId = parsePid(request.params.baseId, "bas");
        const commentId = parsePid(request.params.commentId, "cmt");
        const body = z.object({ emoji: z.string().min(1).max(32) }).parse(request.body);

        const comment = await sql<{ id: string }>`
          SELECT id FROM data.comments
          WHERE id = ${commentId} AND base_id = ${baseId} AND deleted_at IS NULL
          LIMIT 1
        `.execute(ctx.db);

        if (!comment.rows[0]) {
          notFound(request, reply, "Comment not found");
          return;
        }

        await sql`
          INSERT INTO data.comment_reactions (comment_id, user_id, emoji)
          VALUES (${commentId}, ${user.id}, ${body.emoji})
          ON CONFLICT (comment_id, user_id, emoji) DO NOTHING
        `.execute(ctx.db);

        void reply.code(201).send({ ok: true });
      } catch (err) {
        handleRouteError(request, reply, err);
      }
    },
  );
}
