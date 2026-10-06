import { generateUuidV7 } from "@tabula/types";
import { sql } from "kysely";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../../lib/app-context.js";
import { nextOrderKey } from "../../lib/order-key.js";
import { parsePid, pid } from "../../lib/public-ids.js";
import { handleRouteError, notFound } from "../../http/errors.js";
import { resolveTableContext } from "../access/helpers.js";
import { withBaseTx, type MutationActor } from "../../kernel/mutation.js";

const viewConfigSchema = z
  .object({
    filter: z.unknown().optional(),
    sort: z
      .array(
        z.object({
          fieldId: z.string(),
          direction: z.enum(["asc", "desc"]),
        }),
      )
      .optional(),
    group: z
      .array(z.object({ fieldId: z.string() }))
      .optional(),
    visibleFields: z.array(z.string()).optional(),
  })
  .passthrough();

const viewBody = z.object({
  name: z.string().min(1).max(200),
  type: z
    .enum(["grid", "form", "gallery", "kanban", "calendar", "timeline", "list", "gantt"])
    .default("grid"),
  visibility: z.enum(["collaborative", "personal", "locked"]).default("collaborative"),
  config: viewConfigSchema.optional(),
});

const viewPatchBody = z.object({
  name: z.string().min(1).max(200).optional(),
  config: viewConfigSchema.optional(),
  visibility: z.enum(["collaborative", "personal", "locked"]).optional(),
});

function actor(user: NonNullable<import("fastify").FastifyRequest["user"]>): MutationActor {
  return {
    actorType: "user",
    actorId: user.id,
    sessionId: user.sessionId,
    via: "api",
  };
}

export async function registerViewsRoutes(
  app: FastifyInstance,
  ctx: AppContext,
): Promise<void> {
  app.get<{ Params: { baseId: string; tableId: string } }>(
    "/v1/bases/:baseId/tables/:tableId/views",
    async (request, reply) => {
      try {
        const user = request.user;
        if (!user) {
          notFound(request, reply);
          return;
        }
        const baseId = parsePid(request.params.baseId, "bas");
        const tableId = parsePid(request.params.tableId, "tbl");
        const table = await resolveTableContext(ctx.db, user.id, baseId, tableId);
        if (!table.ok) {
          notFound(request, reply, "Table not found");
          return;
        }

        const result = await sql<{
          id: string;
          name: string;
          type: string;
          is_default: boolean;
          visibility: string;
          owner_user_id: string | null;
          created_by: string | null;
          config: unknown;
          is_favorite: boolean;
        }>`
          SELECT v.id, v.name, v.type, v.is_default, v.visibility, v.owner_user_id,
                 v.created_by, v.config,
                 (f.view_id IS NOT NULL) AS is_favorite
          FROM data.views v
          LEFT JOIN data.view_favorites f
            ON f.view_id = v.id AND f.user_id = ${user.id}
          WHERE v.table_id = ${tableId}
            AND v.deleted_at IS NULL
            AND (
              v.visibility = 'collaborative'
              OR v.visibility = 'locked'
              OR (v.visibility = 'personal' AND v.owner_user_id = ${user.id})
            )
          ORDER BY v.order_key ASC
        `.execute(ctx.db);

        void reply.send({
          views: result.rows.map((r) => ({
            id: pid("viw", r.id),
            name: r.name,
            type: r.type,
            isDefault: r.is_default,
            visibility: r.visibility,
            ownerUserId: r.owner_user_id ? pid("usr", r.owner_user_id) : null,
            createdBy: r.created_by ? pid("usr", r.created_by) : null,
            isFavorite: r.is_favorite,
            isMine: r.created_by === user.id || r.owner_user_id === user.id,
            config: r.config,
          })),
        });
      } catch (err) {
        handleRouteError(request, reply, err);
      }
    },
  );

  app.post<{ Params: { baseId: string; tableId: string } }>(
    "/v1/bases/:baseId/tables/:tableId/views",
    async (request, reply) => {
      try {
        const user = request.user;
        if (!user) {
          notFound(request, reply);
          return;
        }
        const baseId = parsePid(request.params.baseId, "bas");
        const tableId = parsePid(request.params.tableId, "tbl");
        const body = viewBody.parse(request.body);
        const table = await resolveTableContext(ctx.db, user.id, baseId, tableId);
        if (!table.ok) {
          notFound(request, reply, "Table not found");
          return;
        }

        const viewId = generateUuidV7();
        const orderKey = nextOrderKey();
        const ownerUserId =
          body.visibility === "personal" ? user.id : null;

        await withBaseTx(
          ctx.db,
          {
            orgId: table.orgId,
            workspaceId: table.workspaceId,
            baseId,
            actor: actor(user),
            redis: ctx.redis,
          },
          async (_mctx, trx) => {
            await sql`
              INSERT INTO data.views (
                id, workspace_id, base_id, table_id, type, name, order_key, config,
                visibility, owner_user_id, created_by
              ) VALUES (
                ${viewId}, ${table.workspaceId}, ${baseId}, ${tableId}, ${body.type}, ${body.name},
                ${orderKey}, ${JSON.stringify(body.config ?? {})}::jsonb,
                ${body.visibility}, ${ownerUserId}, ${user.id}
              )
            `.execute(trx);

            return {
              kind: "views" as const,
              ops: [{ op: "view.created", viewId }],
              tableIds: [tableId],
              eventType: "view.created",
              aggregateType: "view",
              aggregateId: viewId,
              payload: {
                name: body.name,
                type: body.type,
                visibility: body.visibility,
              },
            };
          },
        );

        void reply.code(201).send({
          view: {
            id: pid("viw", viewId),
            name: body.name,
            type: body.type,
            visibility: body.visibility,
            isFavorite: false,
            isMine: true,
          },
        });
      } catch (err) {
        handleRouteError(request, reply, err);
      }
    },
  );

  app.post<{ Params: { baseId: string; tableId: string; viewId: string } }>(
    "/v1/bases/:baseId/tables/:tableId/views/:viewId/favorite",
    async (request, reply) => {
      try {
        const user = request.user;
        if (!user) {
          notFound(request, reply);
          return;
        }
        const baseId = parsePid(request.params.baseId, "bas");
        const tableId = parsePid(request.params.tableId, "tbl");
        const viewId = parsePid(request.params.viewId, "viw");
        const table = await resolveTableContext(ctx.db, user.id, baseId, tableId);
        if (!table.ok) {
          notFound(request, reply, "Table not found");
          return;
        }
        await sql`
          INSERT INTO data.view_favorites (user_id, view_id)
          VALUES (${user.id}, ${viewId})
          ON CONFLICT DO NOTHING
        `.execute(ctx.db);
        void reply.send({ ok: true, isFavorite: true });
      } catch (err) {
        handleRouteError(request, reply, err);
      }
    },
  );

  app.delete<{ Params: { baseId: string; tableId: string; viewId: string } }>(
    "/v1/bases/:baseId/tables/:tableId/views/:viewId/favorite",
    async (request, reply) => {
      try {
        const user = request.user;
        if (!user) {
          notFound(request, reply);
          return;
        }
        const viewId = parsePid(request.params.viewId, "viw");
        await sql`
          DELETE FROM data.view_favorites
          WHERE user_id = ${user.id} AND view_id = ${viewId}
        `.execute(ctx.db);
        void reply.send({ ok: true, isFavorite: false });
      } catch (err) {
        handleRouteError(request, reply, err);
      }
    },
  );

  app.patch<{ Params: { baseId: string; tableId: string; viewId: string } }>(
    "/v1/bases/:baseId/tables/:tableId/views/:viewId",
    async (request, reply) => {
      try {
        const user = request.user;
        if (!user) {
          notFound(request, reply);
          return;
        }
        const baseId = parsePid(request.params.baseId, "bas");
        const tableId = parsePid(request.params.tableId, "tbl");
        const viewId = parsePid(request.params.viewId, "viw");
        const body = viewPatchBody.parse(request.body);
        const table = await resolveTableContext(ctx.db, user.id, baseId, tableId);
        if (!table.ok) {
          notFound(request, reply, "Table not found");
          return;
        }

        await withBaseTx(
          ctx.db,
          {
            orgId: table.orgId,
            workspaceId: table.workspaceId,
            baseId,
            actor: actor(user),
            redis: ctx.redis,
          },
          async (_mctx, trx) => {
            if (body.name !== undefined) {
              await sql`
                UPDATE data.views SET name = ${body.name}, updated_by = ${user.id}, updated_at = now()
                WHERE id = ${viewId} AND table_id = ${tableId}
              `.execute(trx);
            }
            if (body.config !== undefined) {
              const existing = await sql<{ config: unknown }>`
                SELECT config FROM data.views
                WHERE id = ${viewId} AND table_id = ${tableId}
              `.execute(trx);
              const prev =
                (existing.rows[0]?.config as Record<string, unknown>) ?? {};
              const merged = { ...prev, ...body.config };
              await sql`
                UPDATE data.views
                SET config = ${JSON.stringify(merged)}::jsonb,
                    version = version + 1,
                    updated_by = ${user.id},
                    updated_at = now()
                WHERE id = ${viewId} AND table_id = ${tableId}
              `.execute(trx);
            }
            return {
              kind: "views" as const,
              ops: [{ op: "view.updated", viewId }],
              tableIds: [tableId],
              eventType: "view.updated",
              aggregateType: "view",
              aggregateId: viewId,
              payload: { ...body },
            };
          },
        );

        void reply.send({ view: { id: pid("viw", viewId), ...body } });
      } catch (err) {
        handleRouteError(request, reply, err);
      }
    },
  );
}
