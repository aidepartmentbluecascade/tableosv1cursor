import { generateUuidV7 } from "@tabula/types";
import { sql } from "kysely";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../../lib/app-context.js";
import { nextOrderKey } from "../../lib/order-key.js";
import { parsePid, pid } from "../../lib/public-ids.js";
import { handleRouteError, notFound } from "../../http/errors.js";
import { resolveBaseContext, resolveTableContext } from "../access/helpers.js";
import { assertCan } from "../access/assert.js";
import { compileForUser } from "../access/compile.js";
import { getFieldType } from "@tabula/fields";
import { withBaseTx, type MutationActor } from "../../kernel/mutation.js";
import { bootstrapDefaultTable } from "../base/bootstrap-default-table.js";

const tableBody = z.object({
  name: z.string().min(1).max(200),
});

const tablePatchBody = z.object({
  name: z.string().min(1).max(200).optional(),
});

const fieldBody = z.object({
  name: z.string().min(1).max(255),
  type: z.string().min(1),
  config: z.record(z.unknown()).optional(),
});

const fieldPatchBody = z.object({
  name: z.string().min(1).max(255).optional(),
  config: z.record(z.unknown()).optional(),
});

function actor(user: NonNullable<import("fastify").FastifyRequest["user"]>): MutationActor {
  return {
    actorType: "user",
    actorId: user.id,
    sessionId: user.sessionId,
    via: "api",
  };
}

export async function registerSchemaRoutes(
  app: FastifyInstance,
  ctx: AppContext,
): Promise<void> {
  app.get<{ Params: { baseId: string } }>(
    "/v1/bases/:baseId/tables",
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

        const result = await sql<{ id: string; name: string; order_key: string }>`
          SELECT id, name, order_key FROM data.tables
          WHERE base_id = ${baseId} AND deleted_at IS NULL
          ORDER BY order_key ASC
        `.execute(ctx.db);

        void reply.send({
          tables: result.rows.map((r) => ({
            id: pid("tbl", r.id),
            name: r.name,
          })),
        });
      } catch (err) {
        handleRouteError(request, reply, err);
      }
    },
  );

  app.post<{ Params: { baseId: string } }>(
    "/v1/bases/:baseId/tables",
    async (request, reply) => {
      try {
        const user = request.user;
        if (!user) {
          notFound(request, reply);
          return;
        }
        const baseId = parsePid(request.params.baseId, "bas");
        const body = tableBody.parse(request.body);
        const base = await resolveBaseContext(ctx.db, user.id, baseId);
        if (!base.ok) {
          notFound(request, reply, "Base not found");
          return;
        }

        let createdTableId = "";

        await withBaseTx(
          ctx.db,
          {
            orgId: base.orgId,
            workspaceId: base.workspaceId,
            baseId,
            actor: actor(user),
            redis: ctx.redis,
          },
          async (_mctx, trx) => {
            const boot = await bootstrapDefaultTable(trx, {
              workspaceId: base.workspaceId,
              baseId,
              userId: user.id,
              tableName: body.name,
            });
            createdTableId = boot.tableId;

            return {
              kind: "schema" as const,
              ops: [{ op: "table.created", tableId: boot.tableId, name: body.name }],
              inverseOps: [{ op: "table.deleted", tableId: boot.tableId }],
              tableIds: [boot.tableId],
              eventType: "table.created",
              aggregateType: "table",
              aggregateId: boot.tableId,
              payload: { name: body.name },
            };
          },
        );

        void reply.code(201).send({
          table: { id: pid("tbl", createdTableId), name: body.name },
        });
      } catch (err) {
        handleRouteError(request, reply, err);
      }
    },
  );

  app.patch<{ Params: { baseId: string; tableId: string } }>(
    "/v1/bases/:baseId/tables/:tableId",
    async (request, reply) => {
      try {
        const user = request.user;
        if (!user) {
          notFound(request, reply);
          return;
        }
        const baseId = parsePid(request.params.baseId, "bas");
        const tableId = parsePid(request.params.tableId, "tbl");
        const body = tablePatchBody.parse(request.body);
        const table = await resolveTableContext(ctx.db, user.id, baseId, tableId);
        if (!table.ok) {
          notFound(request, reply, "Table not found");
          return;
        }

        if (body.name) {
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
                UPDATE data.tables
                SET name = ${body.name}, updated_by = ${user.id}, updated_at = now()
                WHERE id = ${tableId}
              `.execute(trx);
              return {
                kind: "schema" as const,
                ops: [{ op: "table.renamed", tableId, name: body.name }],
                inverseOps: [{ op: "table.renamed", tableId, name: table.tableName }],
                tableIds: [tableId],
                eventType: "table.updated",
                aggregateType: "table",
                aggregateId: tableId,
                payload: { name: body.name },
              };
            },
          );
        }

        void reply.send({
          table: { id: pid("tbl", tableId), name: body.name ?? table.tableName },
        });
      } catch (err) {
        handleRouteError(request, reply, err);
      }
    },
  );

  app.delete<{ Params: { baseId: string; tableId: string } }>(
    "/v1/bases/:baseId/tables/:tableId",
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
              UPDATE data.tables
              SET deleted_at = now(), deleted_by = ${user.id}, updated_at = now()
              WHERE id = ${tableId}
            `.execute(trx);
            return {
              kind: "schema" as const,
              ops: [{ op: "table.soft_deleted", tableId }],
              inverseOps: [{ op: "table.restored", tableId }],
              tableIds: [tableId],
              eventType: "table.deleted",
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

  app.get<{ Params: { baseId: string; tableId: string } }>(
    "/v1/bases/:baseId/tables/:tableId/fields",
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
          slot: number;
          config: unknown;
          order_key: string;
        }>`
          SELECT id, name, type, slot, config, order_key
          FROM data.fields
          WHERE table_id = ${tableId} AND deleted_at IS NULL
          ORDER BY order_key ASC, slot ASC
        `.execute(ctx.db);

        void reply.send({
          fields: result.rows.map((r) => ({
            id: pid("fld", r.id),
            name: r.name,
            type: r.type,
            slot: r.slot,
            config: r.config,
          })),
        });
      } catch (err) {
        handleRouteError(request, reply, err);
      }
    },
  );

  app.post<{ Params: { baseId: string; tableId: string } }>(
    "/v1/bases/:baseId/tables/:tableId/fields",
    async (request, reply) => {
      try {
        const user = request.user;
        if (!user) {
          notFound(request, reply);
          return;
        }
        const baseId = parsePid(request.params.baseId, "bas");
        const tableId = parsePid(request.params.tableId, "tbl");
        const body = fieldBody.parse(request.body);
        const table = await resolveTableContext(ctx.db, user.id, baseId, tableId);
        if (!table.ok) {
          notFound(request, reply, "Table not found");
          return;
        }

        const fieldSnapshot = await compileForUser(ctx.db, user.id, baseId);
        assertCan(fieldSnapshot, "base.manage_schema");

        const fieldId = generateUuidV7();
        const orderKey = nextOrderKey();
        let allocatedSlot = 0;
        const config = { ...(body.config ?? {}) };
        const typeDef = getFieldType(body.type as Parameters<typeof getFieldType>[0]);
        if (
          (body.type === "single_select" || body.type === "multi_select") &&
          !Array.isArray(config["options"])
        ) {
          config["options"] = [
            { id: "opt_1", label: "Option A" },
            { id: "opt_2", label: "Option B" },
          ];
        }
        if (body.type === "formula" && typeof config["expression"] !== "string") {
          config["expression"] = '""';
        }
        if (body.type === "rollup" && typeof config["aggregation"] !== "string") {
          config["aggregation"] = "count";
        }
        const isComputed = typeDef.isComputed === true;

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
            const slotRow = await sql<{ next_field_slot: number }>`
              UPDATE data.tables
              SET next_field_slot = next_field_slot + 1, updated_at = now()
              WHERE id = ${tableId}
              RETURNING (next_field_slot - 1) AS next_field_slot
            `.execute(trx);
            allocatedSlot = slotRow.rows[0]?.next_field_slot ?? 1;

            await sql`
              INSERT INTO data.fields (
                id, workspace_id, base_id, table_id, slot, name, type, config, order_key,
                is_computed, created_by
              ) VALUES (
                ${fieldId}, ${table.workspaceId}, ${baseId}, ${tableId}, ${allocatedSlot},
                ${body.name}, ${body.type}, ${JSON.stringify(config)}::jsonb,
                ${orderKey}, ${isComputed}, ${user.id}
              )
            `.execute(trx);

            return {
              kind: "schema" as const,
              ops: [{ op: "field.created", fieldId, slot: allocatedSlot }],
              inverseOps: [{ op: "field.deleted", fieldId }],
              tableIds: [tableId],
              eventType: "field.created",
              aggregateType: "field",
              aggregateId: fieldId,
              payload: { name: body.name, type: body.type },
            };
          },
        );

        void reply.code(201).send({
          field: {
            id: pid("fld", fieldId),
            name: body.name,
            type: body.type,
            slot: allocatedSlot,
          },
        });
      } catch (err) {
        handleRouteError(request, reply, err);
      }
    },
  );

  app.patch<{ Params: { baseId: string; tableId: string; fieldId: string } }>(
    "/v1/bases/:baseId/tables/:tableId/fields/:fieldId",
    async (request, reply) => {
      try {
        const user = request.user;
        if (!user) {
          notFound(request, reply);
          return;
        }
        const baseId = parsePid(request.params.baseId, "bas");
        const tableId = parsePid(request.params.tableId, "tbl");
        const fieldId = parsePid(request.params.fieldId, "fld");
        const body = fieldPatchBody.parse(request.body);
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
                UPDATE data.fields SET name = ${body.name}, updated_by = ${user.id}, updated_at = now()
                WHERE id = ${fieldId} AND table_id = ${tableId}
              `.execute(trx);
            }
            if (body.config !== undefined) {
              await sql`
                UPDATE data.fields SET config = ${JSON.stringify(body.config)}::jsonb, updated_at = now()
                WHERE id = ${fieldId} AND table_id = ${tableId}
              `.execute(trx);
            }
            return {
              kind: "schema" as const,
              ops: [{ op: "field.updated", fieldId }],
              tableIds: [tableId],
              eventType: "field.updated",
              aggregateType: "field",
              aggregateId: fieldId,
              payload: { ...body },
            };
          },
        );

        void reply.send({ field: { id: pid("fld", fieldId), ...body } });
      } catch (err) {
        handleRouteError(request, reply, err);
      }
    },
  );

  app.delete<{ Params: { baseId: string; tableId: string; fieldId: string } }>(
    "/v1/bases/:baseId/tables/:tableId/fields/:fieldId",
    async (request, reply) => {
      try {
        const user = request.user;
        if (!user) {
          notFound(request, reply);
          return;
        }
        const baseId = parsePid(request.params.baseId, "bas");
        const tableId = parsePid(request.params.tableId, "tbl");
        const fieldId = parsePid(request.params.fieldId, "fld");
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
            await sql`
              UPDATE data.fields
              SET deleted_at = now(), deleted_by = ${user.id}, updated_at = now()
              WHERE id = ${fieldId} AND table_id = ${tableId}
            `.execute(trx);
            return {
              kind: "schema" as const,
              ops: [{ op: "field.soft_deleted", fieldId }],
              tableIds: [tableId],
              eventType: "field.deleted",
              aggregateType: "field",
              aggregateId: fieldId,
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
}
