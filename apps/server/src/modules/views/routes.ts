import {
  createTabulaError,
  generateUuidV7,
  keyBetween,
  keysBetween,
  TabulaErrorCodes,
} from "@tabula/types";
import { sql, type Transaction } from "kysely";
import type { Database, TabulaDb } from "@tabula/db";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppContext } from "../../lib/app-context.js";
import { parsePid } from "../../lib/public-ids.js";
import { forbidden, handleRouteError, notFound, sendProblem } from "../../http/errors.js";
import { resolveTableContext } from "../access/helpers.js";
import { compileForUser } from "../access/compile.js";
import { withBaseTx, type MutationActor } from "../../kernel/mutation.js";
import {
  defaultConfigForType,
  VIEW_TYPES,
  viewConfigPatchSchema,
} from "./config.js";
import {
  canEditView,
  loadTableConfigInfo,
  serializeView,
  type ViewRow,
} from "./serialize.js";

const viewBody = z.object({
  name: z.string().trim().min(1).max(200),
  type: z.enum(VIEW_TYPES).default("grid"),
  visibility: z.enum(["collaborative", "personal", "locked"]).default("collaborative"),
  config: viewConfigPatchSchema.optional(),
});

const viewPatchBody = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    config: viewConfigPatchSchema.optional(),
    visibility: z.enum(["collaborative", "personal", "locked"]).optional(),
  })
  .strict();

const duplicateBody = z
  .object({ name: z.string().trim().min(1).max(200).optional() })
  .strict()
  .optional();

const reorderBody = z.object({
  viewIds: z.array(z.string()).min(1).max(1000),
});

type DbTrx = Transaction<Database>;

function actor(user: NonNullable<FastifyRequest["user"]>): MutationActor {
  return {
    actorType: "user",
    actorId: user.id,
    sessionId: user.sessionId,
    via: "api",
  };
}

const VIEW_COLUMNS = sql`v.id, v.table_id, v.name, v.type, v.is_default, v.visibility,
  v.owner_user_id, v.created_by, v.config, v.order_key`;

async function loadView(
  db: TabulaDb | DbTrx,
  userId: string,
  tableId: string,
  viewId: string,
): Promise<ViewRow | null> {
  const res = await sql<ViewRow>`
    SELECT ${VIEW_COLUMNS}, (f.view_id IS NOT NULL) AS is_favorite
    FROM data.views v
    LEFT JOIN data.view_favorites f ON f.view_id = v.id AND f.user_id = ${userId}
    WHERE v.id = ${viewId} AND v.table_id = ${tableId} AND v.deleted_at IS NULL
      AND (v.visibility <> 'personal' OR v.owner_user_id = ${userId})
    LIMIT 1
  `.execute(db);
  return res.rows[0] ?? null;
}

async function isBaseCreator(db: TabulaDb, userId: string, baseId: string): Promise<boolean> {
  try {
    const snap = await compileForUser(db, userId, baseId);
    return snap.effectiveBaseRole === "creator";
  } catch {
    return false;
  }
}

async function rekey(trx: DbTrx, orderedIds: string[]): Promise<void> {
  const keys = keysBetween(null, null, orderedIds.length);
  for (let i = 0; i < orderedIds.length; i += 1) {
    await sql`UPDATE data.views SET order_key = ${keys[i]!} WHERE id = ${orderedIds[i]!}`.execute(
      trx,
    );
  }
}

/** Order key after the last view of a table. */
async function appendKey(db: TabulaDb | DbTrx, tableId: string): Promise<string> {
  const last = await sql<{ order_key: string }>`
    SELECT order_key FROM data.views WHERE table_id = ${tableId}
    ORDER BY order_key DESC LIMIT 1
  `.execute(db);
  return keyBetween(last.rows[0]?.order_key ?? null, null);
}

function lockedProblem(request: FastifyRequest, reply: FastifyReply, row: ViewRow): void {
  forbidden(
    request,
    reply,
    row.visibility === "locked"
      ? "This view is locked. Only its creator or a base owner can change it."
      : "Only the owner can change a personal view.",
  );
}

export async function registerViewsRoutes(
  app: FastifyInstance,
  ctx: AppContext,
): Promise<void> {
  type TableParams = { baseId: string; tableId: string };
  type ViewParams = TableParams & { viewId: string };

  async function resolve(request: FastifyRequest<{ Params: TableParams }>, reply: FastifyReply) {
    const user = request.user;
    if (!user) {
      notFound(request, reply);
      return null;
    }
    const baseId = parsePid(request.params.baseId, "bas");
    const tableId = parsePid(request.params.tableId, "tbl");
    const table = await resolveTableContext(ctx.db, user.id, baseId, tableId);
    if (!table.ok) {
      notFound(request, reply, "Table not found");
      return null;
    }
    return { user, baseId, tableId, table };
  }

  // List views of a table.
  app.get<{ Params: TableParams }>(
    "/v1/bases/:baseId/tables/:tableId/views",
    async (request, reply) => {
      try {
        const r = await resolve(request, reply);
        if (!r) return;
        const result = await sql<ViewRow>`
          SELECT ${VIEW_COLUMNS}, (f.view_id IS NOT NULL) AS is_favorite
          FROM data.views v
          LEFT JOIN data.view_favorites f
            ON f.view_id = v.id AND f.user_id = ${r.user.id}
          WHERE v.table_id = ${r.tableId}
            AND v.deleted_at IS NULL
            AND (v.visibility <> 'personal' OR v.owner_user_id = ${r.user.id})
          ORDER BY v.order_key ASC
        `.execute(ctx.db);
        const info = await loadTableConfigInfo(ctx.db, [r.tableId]);
        const creator = await isBaseCreator(ctx.db, r.user.id, r.baseId);
        void reply.send({
          views: result.rows.map((row) =>
            serializeView(row, r.user.id, info.get(r.tableId), creator),
          ),
        });
      } catch (err) {
        handleRouteError(request, reply, err);
      }
    },
  );

  // Get one view.
  app.get<{ Params: ViewParams }>(
    "/v1/bases/:baseId/tables/:tableId/views/:viewId",
    async (request, reply) => {
      try {
        const r = await resolve(request, reply);
        if (!r) return;
        const viewId = parsePid(request.params.viewId, "viw");
        const row = await loadView(ctx.db, r.user.id, r.tableId, viewId);
        if (!row) {
          notFound(request, reply, "View not found");
          return;
        }
        const info = await loadTableConfigInfo(ctx.db, [r.tableId]);
        const creator = await isBaseCreator(ctx.db, r.user.id, r.baseId);
        void reply.send({ view: serializeView(row, r.user.id, info.get(r.tableId), creator) });
      } catch (err) {
        handleRouteError(request, reply, err);
      }
    },
  );

  // Create a view.
  app.post<{ Params: TableParams }>(
    "/v1/bases/:baseId/tables/:tableId/views",
    async (request, reply) => {
      try {
        const body = viewBody.parse(request.body ?? {});
        const r = await resolve(request, reply);
        if (!r) return;
        const { user, baseId, tableId, table } = r;

        const info = (await loadTableConfigInfo(ctx.db, [tableId])).get(tableId);
        const config = {
          ...defaultConfigForType(body.type, info?.fields ?? [], info?.name),
          ...(body.config ?? {}),
        };
        const viewId = generateUuidV7();
        const ownerUserId = body.visibility === "personal" ? user.id : null;

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
            const orderKey = await appendKey(trx, tableId);
            await sql`
              INSERT INTO data.views (
                id, workspace_id, base_id, table_id, type, name, order_key, config,
                visibility, owner_user_id, created_by
              ) VALUES (
                ${viewId}, ${table.workspaceId}, ${baseId}, ${tableId}, ${body.type}, ${body.name},
                ${orderKey}, ${JSON.stringify(config)}::jsonb,
                ${body.visibility}, ${ownerUserId}, ${user.id}
              )
            `.execute(trx);
            return {
              kind: "views" as const,
              inverseOps: null,
              ops: [{ op: "view.created", viewId }],
              tableIds: [tableId],
              eventType: "view.created",
              aggregateType: "view",
              aggregateId: viewId,
              payload: { name: body.name, type: body.type, visibility: body.visibility },
            };
          },
        );

        const row = await loadView(ctx.db, user.id, tableId, viewId);
        void reply.code(201).send({ view: serializeView(row!, user.id, info, true) });
      } catch (err) {
        handleRouteError(request, reply, err);
      }
    },
  );

  // Update name / config (shallow merge) / visibility.
  app.patch<{ Params: ViewParams }>(
    "/v1/bases/:baseId/tables/:tableId/views/:viewId",
    async (request, reply) => {
      try {
        const body = viewPatchBody.parse(request.body ?? {});
        const r = await resolve(request, reply);
        if (!r) return;
        const { user, baseId, tableId, table } = r;
        const viewId = parsePid(request.params.viewId, "viw");
        const row = await loadView(ctx.db, user.id, tableId, viewId);
        if (!row) {
          notFound(request, reply, "View not found");
          return;
        }
        const creator = await isBaseCreator(ctx.db, user.id, baseId);
        if (!canEditView(row, user.id, creator)) {
          lockedProblem(request, reply, row);
          return;
        }
        // Locking/unlocking and making a view personal is limited to its creator / base creators.
        if (
          body.visibility !== undefined &&
          body.visibility !== row.visibility &&
          row.created_by !== user.id &&
          !creator &&
          (body.visibility === "personal" || body.visibility === "locked")
        ) {
          forbidden(request, reply, "Only the view's creator can lock it or make it personal.");
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
            const cur = await sql<{ config: unknown; version: string }>`
              SELECT config, version FROM data.views WHERE id = ${viewId} FOR UPDATE
            `.execute(trx);
            const prev = (cur.rows[0]?.config ?? {}) as Record<string, unknown>;
            const merged =
              body.config !== undefined ? { ...prev, ...body.config } : prev;
            const visibility = body.visibility ?? row.visibility;
            const owner =
              visibility === "personal" ? (row.owner_user_id ?? user.id) : null;
            await sql`
              UPDATE data.views
              SET name = ${body.name ?? row.name},
                  config = ${JSON.stringify(merged)}::jsonb,
                  visibility = ${visibility},
                  owner_user_id = ${owner},
                  version = version + 1,
                  updated_by = ${user.id},
                  updated_at = now()
              WHERE id = ${viewId}
            `.execute(trx);
            return {
              kind: "views" as const,
              inverseOps: null,
              ops: [{ op: "view.updated", viewId }],
              tableIds: [tableId],
              eventType: "view.updated",
              aggregateType: "view",
              aggregateId: viewId,
              payload: { ...body },
            };
          },
        );

        const updated = await loadView(ctx.db, user.id, tableId, viewId);
        const info = await loadTableConfigInfo(ctx.db, [tableId]);
        void reply.send({ view: serializeView(updated!, user.id, info.get(tableId), creator) });
      } catch (err) {
        handleRouteError(request, reply, err);
      }
    },
  );

  // Delete a view (soft delete). The last view of a table cannot be deleted.
  app.delete<{ Params: ViewParams }>(
    "/v1/bases/:baseId/tables/:tableId/views/:viewId",
    async (request, reply) => {
      try {
        const r = await resolve(request, reply);
        if (!r) return;
        const { user, baseId, tableId, table } = r;
        const viewId = parsePid(request.params.viewId, "viw");
        const row = await loadView(ctx.db, user.id, tableId, viewId);
        if (!row) {
          notFound(request, reply, "View not found");
          return;
        }
        const creator = await isBaseCreator(ctx.db, user.id, baseId);
        if (!canEditView(row, user.id, creator)) {
          lockedProblem(request, reply, row);
          return;
        }
        const others = await sql<{ total: string; shared: string }>`
          SELECT count(*)::text AS total,
                 count(*) FILTER (WHERE visibility <> 'personal')::text AS shared
          FROM data.views
          WHERE table_id = ${tableId} AND deleted_at IS NULL AND id <> ${viewId}
        `.execute(ctx.db);
        const total = Number(others.rows[0]?.total ?? 0);
        const shared = Number(others.rows[0]?.shared ?? 0);
        if (total === 0 || (row.visibility !== "personal" && shared === 0)) {
          sendProblem(
            reply,
            request,
            createTabulaError(TabulaErrorCodes.VERSION_CONFLICT, {
              title: "Cannot delete the last view",
              detail: "A table must keep at least one shared view.",
              meta: { reason: "LAST_VIEW" },
            }),
          );
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
            await sql`
              UPDATE data.views
              SET deleted_at = now(), deleted_by = ${user.id}, is_default = false
              WHERE id = ${viewId}
            `.execute(trx);
            if (row.is_default) {
              await sql`
                UPDATE data.views SET is_default = true
                WHERE id = (
                  SELECT id FROM data.views
                  WHERE table_id = ${tableId} AND deleted_at IS NULL AND visibility <> 'personal'
                  ORDER BY order_key ASC LIMIT 1
                )
              `.execute(trx);
            }
            await sql`DELETE FROM data.view_favorites WHERE view_id = ${viewId}`.execute(trx);
            return {
              kind: "views" as const,
              inverseOps: null,
              ops: [{ op: "view.deleted", viewId }],
              tableIds: [tableId],
              eventType: "view.deleted",
              aggregateType: "view",
              aggregateId: viewId,
              payload: { name: row.name },
            };
          },
        );
        void reply.code(204).send();
      } catch (err) {
        handleRouteError(request, reply, err);
      }
    },
  );

  // Duplicate a view (placed right after the original).
  app.post<{ Params: ViewParams }>(
    "/v1/bases/:baseId/tables/:tableId/views/:viewId/duplicate",
    async (request, reply) => {
      try {
        const body = duplicateBody.parse(request.body ?? undefined);
        const r = await resolve(request, reply);
        if (!r) return;
        const { user, baseId, tableId, table } = r;
        const viewId = parsePid(request.params.viewId, "viw");
        const row = await loadView(ctx.db, user.id, tableId, viewId);
        if (!row) {
          notFound(request, reply, "View not found");
          return;
        }
        const newId = generateUuidV7();
        const visibility = row.visibility === "personal" ? "personal" : "collaborative";
        const name = body?.name ?? `${row.name} copy`.slice(0, 200);

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
            const neighbours = await sql<{ order_key: string }>`
              SELECT order_key FROM data.views
              WHERE table_id = ${tableId} AND order_key > ${row.order_key ?? ""}
              ORDER BY order_key ASC LIMIT 1
            `.execute(trx);
            let orderKey: string;
            try {
              orderKey = keyBetween(row.order_key ?? null, neighbours.rows[0]?.order_key ?? null);
            } catch {
              orderKey = await appendKey(trx, tableId);
            }
            await sql`
              INSERT INTO data.views (
                id, workspace_id, base_id, table_id, type, name, order_key, config,
                visibility, owner_user_id, created_by
              ) VALUES (
                ${newId}, ${table.workspaceId}, ${baseId}, ${tableId}, ${row.type}, ${name},
                ${orderKey}, ${JSON.stringify(row.config ?? {})}::jsonb,
                ${visibility}, ${visibility === "personal" ? user.id : null}, ${user.id}
              )
            `.execute(trx);
            return {
              kind: "views" as const,
              inverseOps: null,
              ops: [{ op: "view.created", viewId: newId, duplicatedFrom: viewId }],
              tableIds: [tableId],
              eventType: "view.created",
              aggregateType: "view",
              aggregateId: newId,
              payload: { name, type: row.type, visibility },
            };
          },
        );
        const created = await loadView(ctx.db, user.id, tableId, newId);
        const info = await loadTableConfigInfo(ctx.db, [tableId]);
        void reply
          .code(201)
          .send({ view: serializeView(created!, user.id, info.get(tableId), true) });
      } catch (err) {
        handleRouteError(request, reply, err);
      }
    },
  );

  // Reorder views. `viewIds` lists the views the caller sees, in the new order;
  // views the caller can't see keep their relative slots.
  app.post<{ Params: TableParams }>(
    "/v1/bases/:baseId/tables/:tableId/views/reorder",
    async (request, reply) => {
      try {
        const body = reorderBody.parse(request.body ?? {});
        const r = await resolve(request, reply);
        if (!r) return;
        const { user, baseId, tableId, table } = r;
        const requested = body.viewIds.map((v) => parsePid(v, "viw"));
        if (new Set(requested).size !== requested.length) {
          throw new z.ZodError([
            { code: "custom", path: ["viewIds"], message: "Duplicate view ids" },
          ]);
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
            const ordered = await sql<{ id: string }>`
              SELECT id FROM data.views
              WHERE table_id = ${tableId} AND deleted_at IS NULL
              ORDER BY order_key ASC
            `.execute(trx);
            const current = ordered.rows.map((x) => x.id);
            const known = new Set(current);
            const moving = requested.filter((id) => known.has(id));
            const movingSet = new Set(moving);
            let i = 0;
            const next = current.map((id) => (movingSet.has(id) ? moving[i++]! : id));
            await rekey(trx, next);
            return {
              kind: "views" as const,
              inverseOps: null,
              ops: [{ op: "views.reordered", viewIds: moving }],
              tableIds: [tableId],
              eventType: "view.reordered",
              aggregateType: "table",
              aggregateId: tableId,
              payload: {},
            };
          },
        );
        void reply.code(204).send();
      } catch (err) {
        handleRouteError(request, reply, err);
      }
    },
  );

  // Favorites.
  app.post<{ Params: ViewParams }>(
    "/v1/bases/:baseId/tables/:tableId/views/:viewId/favorite",
    async (request, reply) => {
      try {
        const r = await resolve(request, reply);
        if (!r) return;
        const viewId = parsePid(request.params.viewId, "viw");
        const row = await loadView(ctx.db, r.user.id, r.tableId, viewId);
        if (!row) {
          notFound(request, reply, "View not found");
          return;
        }
        await sql`
          INSERT INTO data.view_favorites (user_id, view_id)
          VALUES (${r.user.id}, ${viewId})
          ON CONFLICT DO NOTHING
        `.execute(ctx.db);
        void reply.send({ ok: true, isFavorite: true });
      } catch (err) {
        handleRouteError(request, reply, err);
      }
    },
  );

  app.delete<{ Params: ViewParams }>(
    "/v1/bases/:baseId/tables/:tableId/views/:viewId/favorite",
    async (request, reply) => {
      try {
        const r = await resolve(request, reply);
        if (!r) return;
        const viewId = parsePid(request.params.viewId, "viw");
        await sql`
          DELETE FROM data.view_favorites
          WHERE user_id = ${r.user.id} AND view_id = ${viewId}
        `.execute(ctx.db);
        void reply.send({ ok: true, isFavorite: false });
      } catch (err) {
        handleRouteError(request, reply, err);
      }
    },
  );
}
