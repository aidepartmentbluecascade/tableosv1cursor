import { generateUuidV7 } from "@tabula/types";
import { sql } from "kysely";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../../lib/app-context.js";
import { nextOrderKey } from "../../lib/order-key.js";
import { parsePid, pid } from "../../lib/public-ids.js";
import { handleRouteError, notFound } from "../../http/errors.js";
import { userCanAccessWorkspace, resolveBaseContext } from "../access/helpers.js";
import { assertCan } from "../access/assert.js";
import { compileForWorkspace } from "../access/compile.js";
import type { MutationActor } from "../../kernel/mutation.js";
import { withBaseTx } from "../../kernel/mutation.js";
import { bootstrapDefaultTable } from "./bootstrap-default-table.js";

const nameBody = z.object({
  name: z.string().min(1).max(200),
});

function actorFromRequest(user: NonNullable<import("fastify").FastifyRequest["user"]>): MutationActor {
  return {
    actorType: "user",
    actorId: user.id,
    sessionId: user.sessionId,
    via: "api",
  };
}

export async function registerBaseRoutes(
  app: FastifyInstance,
  ctx: AppContext,
): Promise<void> {
  app.post<{ Params: { workspaceId: string } }>(
    "/v1/workspaces/:workspaceId/bases",
    async (request, reply) => {
      try {
        const user = request.user;
        if (!user) {
          notFound(request, reply);
          return;
        }

        const workspaceId = parsePid(request.params.workspaceId, "wsp");
        const body = nameBody.parse(request.body);
        const access = await userCanAccessWorkspace(ctx.db, user.id, workspaceId);
        if (!access.ok) {
          notFound(request, reply, "Workspace not found");
          return;
        }

        const wsSnapshot = await compileForWorkspace(ctx.db, user.id, workspaceId);
        assertCan(wsSnapshot, "base.manage_schema");

        const baseId = generateUuidV7();
        const orderKey = nextOrderKey();

        await ctx.db.transaction().execute(async (trx) => {
          await sql`
            INSERT INTO data.bases (id, workspace_id, name, created_by)
            VALUES (${baseId}, ${workspaceId}, ${body.name}, ${user.id})
          `.execute(trx);

          await sql`
            INSERT INTO data.base_runtime (base_id, workspace_id)
            VALUES (${baseId}, ${workspaceId})
          `.execute(trx);

          await sql`
            INSERT INTO core.base_directory (
              base_id, workspace_id, org_id, shard_id, name, order_key
            ) VALUES (
              ${baseId}, ${workspaceId}, ${access.orgId}, ${ctx.defaultShardId}, ${body.name}, ${orderKey}
            )
          `.execute(trx);

          await sql`
            INSERT INTO core.access_grants (
              id, org_id, resource_type, resource_id, workspace_id, base_id,
              principal_type, principal_id, role, source, granted_by
            ) VALUES (
              ${generateUuidV7()}, ${access.orgId}, 'base', ${baseId}, ${workspaceId}, ${baseId},
              'user', ${user.id}, 'creator', 'creator', ${user.id}
            )
          `.execute(trx);

          await withBaseTx(
            ctx.db,
            {
              orgId: access.orgId,
              workspaceId,
              baseId,
              actor: actorFromRequest(user),
              redis: ctx.redis,
            },
            async (mctx, innerTrx) => {
              const boot = await bootstrapDefaultTable(innerTrx, {
                workspaceId,
                baseId,
                userId: user.id,
              });

              return {
                kind: "schema" as const,
                ops: [
                  {
                    op: "base.created",
                    baseId: mctx.baseId,
                    tableId: boot.tableId,
                    viewId: boot.viewId,
                  },
                ],
                inverseOps: [{ op: "base.deleted", baseId: mctx.baseId }],
                tableIds: [boot.tableId],
                eventType: "base.created",
                aggregateType: "base",
                aggregateId: baseId,
                payload: { name: body.name },
              };
            },
            trx,
          );
        });

        void reply.code(201).send({
          id: pid("bas", baseId),
          name: body.name,
        });
      } catch (err) {
        handleRouteError(request, reply, err);
      }
    },
  );

  app.get<{ Params: { baseId: string } }>(
    "/v1/bases/:baseId",
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

        const tables = await sql<{
          id: string;
          name: string;
          primary_field_id: string | null;
          order_key: string;
        }>`
          SELECT id, name, primary_field_id, order_key
          FROM data.tables
          WHERE base_id = ${baseId} AND deleted_at IS NULL
          ORDER BY order_key ASC
        `.execute(ctx.db);

        const fields = await sql<{
          id: string;
          table_id: string;
          name: string;
          type: string;
          slot: number;
          config: unknown;
          order_key: string;
        }>`
          SELECT id, table_id, name, type, slot, config, order_key
          FROM data.fields
          WHERE base_id = ${baseId} AND deleted_at IS NULL
          ORDER BY order_key ASC, slot ASC
        `.execute(ctx.db);

        const views = await sql<{
          id: string;
          table_id: string;
          name: string;
          type: string;
          visibility: string;
          owner_user_id: string | null;
          created_by: string | null;
          order_key: string;
          is_favorite: boolean;
        }>`
          SELECT v.id, v.table_id, v.name, v.type, v.visibility, v.owner_user_id,
                 v.created_by, v.order_key,
                 (f.view_id IS NOT NULL) AS is_favorite
          FROM data.views v
          LEFT JOIN data.view_favorites f
            ON f.view_id = v.id AND f.user_id = ${user.id}
          WHERE v.base_id = ${baseId}
            AND v.deleted_at IS NULL
            AND (
              v.visibility = 'collaborative'
              OR v.visibility = 'locked'
              OR (v.visibility = 'personal' AND v.owner_user_id = ${user.id})
            )
          ORDER BY v.order_key ASC
        `.execute(ctx.db);

        const fieldsByTable = new Map<string, typeof fields.rows>();
        for (const field of fields.rows) {
          const list = fieldsByTable.get(field.table_id) ?? [];
          list.push(field);
          fieldsByTable.set(field.table_id, list);
        }

        const viewsByTable = new Map<string, typeof views.rows>();
        for (const view of views.rows) {
          const list = viewsByTable.get(view.table_id) ?? [];
          list.push(view);
          viewsByTable.set(view.table_id, list);
        }

        void reply.send({
          id: pid("bas", baseId),
          name: base.name,
          workspaceId: pid("wsp", base.workspaceId),
          tables: tables.rows.map((table) => ({
            id: pid("tbl", table.id),
            name: table.name,
            primaryFieldId: table.primary_field_id
              ? pid("fld", table.primary_field_id)
              : "",
            fields: (fieldsByTable.get(table.id) ?? []).map((f) => ({
              id: pid("fld", f.id),
              name: f.name,
              type: f.type,
              slot: f.slot,
              config: (f.config ?? {}) as Record<string, unknown>,
            })),
            views: (viewsByTable.get(table.id) ?? []).map((v) => ({
              id: pid("viw", v.id),
              name: v.name,
              type: v.type,
              visibility: v.visibility,
              ownerUserId: v.owner_user_id ? pid("usr", v.owner_user_id) : null,
              createdBy: v.created_by ? pid("usr", v.created_by) : null,
              isFavorite: v.is_favorite,
              isMine: v.created_by === user.id || v.owner_user_id === user.id,
            })),
          })),
        });
      } catch (err) {
        handleRouteError(request, reply, err);
      }
    },
  );

  app.patch<{ Params: { baseId: string } }>(
    "/v1/bases/:baseId",
    async (request, reply) => {
      try {
        const user = request.user;
        if (!user) {
          notFound(request, reply);
          return;
        }

        const baseId = parsePid(request.params.baseId, "bas");
        const body = nameBody.parse(request.body);
        const base = await resolveBaseContext(ctx.db, user.id, baseId);
        if (!base.ok) {
          notFound(request, reply, "Base not found");
          return;
        }

        await withBaseTx(
          ctx.db,
          {
            orgId: base.orgId,
            workspaceId: base.workspaceId,
            baseId,
            actor: actorFromRequest(user),
            redis: ctx.redis,
          },
          async (_mctx, trx) => {
            await sql`
              UPDATE data.bases SET name = ${body.name}, updated_by = ${user.id}, updated_at = now()
              WHERE id = ${baseId}
            `.execute(trx);
            await sql`
              UPDATE core.base_directory SET name = ${body.name}, updated_at = now()
              WHERE base_id = ${baseId}
            `.execute(trx);

            return {
              kind: "schema" as const,
              ops: [{ op: "base.renamed", name: body.name }],
              inverseOps: [{ op: "base.renamed", name: base.name }],
              eventType: "base.updated",
              aggregateType: "base",
              aggregateId: baseId,
              payload: { name: body.name },
            };
          },
        );

        void reply.send({ base: { id: pid("bas", baseId), name: body.name } });
      } catch (err) {
        handleRouteError(request, reply, err);
      }
    },
  );

  app.delete<{ Params: { baseId: string } }>(
    "/v1/bases/:baseId",
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

        await withBaseTx(
          ctx.db,
          {
            orgId: base.orgId,
            workspaceId: base.workspaceId,
            baseId,
            actor: actorFromRequest(user),
            redis: ctx.redis,
          },
          async (_mctx, trx) => {
            await sql`
              UPDATE data.bases
              SET deleted_at = now(), deleted_by = ${user.id}, updated_at = now()
              WHERE id = ${baseId}
            `.execute(trx);
            await sql`
              UPDATE core.base_directory
              SET status = 'trashed', deleted_at = now(), updated_at = now()
              WHERE base_id = ${baseId}
            `.execute(trx);

            return {
              kind: "schema" as const,
              ops: [{ op: "base.soft_deleted" }],
              inverseOps: [{ op: "base.restored" }],
              eventType: "base.deleted",
              aggregateType: "base",
              aggregateId: baseId,
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

  app.get<{ Params: { baseId: string } }>(
    "/v1/bases/:baseId/changes",
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

        const query = request.query as { afterSeq?: string; limit?: string };
        const afterSeq = Number(query.afterSeq ?? 0);
        const limit = Math.min(Number(query.limit ?? 100), 500);

        const result = await sql<{
          seq: string;
          kind: string;
          ops: unknown;
          created_at: Date;
          id: string;
        }>`
          SELECT seq, kind, ops, created_at, id
          FROM data.base_changes
          WHERE base_id = ${baseId} AND seq > ${afterSeq}
          ORDER BY seq ASC
          LIMIT ${limit}
        `.execute(ctx.db);

        const runtime = await sql<{ change_seq: string }>`
          SELECT change_seq FROM data.base_runtime WHERE base_id = ${baseId}
        `.execute(ctx.db);

        void reply.send({
          baseId: pid("bas", baseId),
          latestSeq: Number(runtime.rows[0]?.change_seq ?? 0),
          changes: result.rows.map((r) => ({
            id: pid("chg", r.id),
            seq: Number(r.seq),
            kind: r.kind,
            ops: r.ops,
            createdAt: r.created_at.toISOString(),
          })),
        });
      } catch (err) {
        handleRouteError(request, reply, err);
      }
    },
  );
}
