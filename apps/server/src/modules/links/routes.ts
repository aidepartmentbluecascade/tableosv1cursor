import { generateUuidV7 } from "@tabula/types";
import { sql } from "kysely";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../../lib/app-context.js";
import { nextOrderKey } from "../../lib/order-key.js";
import { parsePid, pid } from "../../lib/public-ids.js";
import { handleRouteError, notFound } from "../../http/errors.js";
import { resolveTableContext } from "../access/helpers.js";
import { assertCan } from "../access/assert.js";
import { compileForUser } from "../access/compile.js";
import { withBaseTx, type MutationActor } from "../../kernel/mutation.js";
import { applyLinkOpsInTx } from "./record-links.js";
import { recomputeInTx } from "../compute/recompute-in-tx.js";

const linkFieldPairBody = z.object({
  name: z.string().min(1).max(255),
  linkedTableId: z.string(),
  inverseName: z.string().min(1).max(255).optional(),
  allowMultiple: z.boolean().optional(),
});

const linkMutationBody = z.object({
  fieldId: z.string(),
  recordIds: z.array(z.string()).min(1),
});

function actor(user: NonNullable<import("fastify").FastifyRequest["user"]>): MutationActor {
  return {
    actorType: "user",
    actorId: user.id,
    sessionId: user.sessionId,
    via: "api",
  };
}

export async function registerLinksRoutes(
  app: FastifyInstance,
  ctx: AppContext,
): Promise<void> {
  app.post<{ Params: { baseId: string; tableId: string } }>(
    "/v1/bases/:baseId/tables/:tableId/link-fields",
    async (request, reply) => {
      try {
        const user = request.user;
        if (!user) {
          notFound(request, reply);
          return;
        }
        const baseId = parsePid(request.params.baseId, "bas");
        const tableId = parsePid(request.params.tableId, "tbl");
        const body = linkFieldPairBody.parse(request.body);
        const linkedTableId = parsePid(body.linkedTableId, "tbl");

        const table = await resolveTableContext(ctx.db, user.id, baseId, tableId);
        if (!table.ok) {
          notFound(request, reply, "Table not found");
          return;
        }

        const linked = await resolveTableContext(ctx.db, user.id, baseId, linkedTableId);
        if (!linked.ok) {
          notFound(request, reply, "Linked table not found");
          return;
        }

        const snapshot = await compileForUser(ctx.db, user.id, baseId);
        assertCan(snapshot, "base.manage_schema");

        const aFieldId = generateUuidV7();
        const bFieldId = generateUuidV7();
        const relationId = generateUuidV7();
        const allowMultiple = body.allowMultiple ?? true;
        const inverseName = body.inverseName ?? `${body.name} (linked)`;

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
            const slotA = await sql<{ slot: number }>`
              UPDATE data.tables SET next_field_slot = next_field_slot + 1, updated_at = now()
              WHERE id = ${tableId}
              RETURNING (next_field_slot - 1) AS slot
            `.execute(trx);
            const slotB = await sql<{ slot: number }>`
              UPDATE data.tables SET next_field_slot = next_field_slot + 1, updated_at = now()
              WHERE id = ${linkedTableId}
              RETURNING (next_field_slot - 1) AS slot
            `.execute(trx);

            const orderA = nextOrderKey();
            const orderB = nextOrderKey();

            await sql`
              INSERT INTO data.fields (
                id, workspace_id, base_id, table_id, slot, name, type, config, order_key, created_by
              ) VALUES (
                ${aFieldId}, ${table.workspaceId}, ${baseId}, ${tableId},
                ${slotA.rows[0]?.slot ?? 1}, ${body.name}, 'link',
                ${JSON.stringify({ linkedTableId, inverseFieldId: bFieldId })}::jsonb,
                ${orderA}, ${user.id}
              )
            `.execute(trx);

            await sql`
              INSERT INTO data.fields (
                id, workspace_id, base_id, table_id, slot, name, type, config, order_key, created_by
              ) VALUES (
                ${bFieldId}, ${linked.workspaceId}, ${baseId}, ${linkedTableId},
                ${slotB.rows[0]?.slot ?? 1}, ${inverseName}, 'link',
                ${JSON.stringify({ linkedTableId: tableId, inverseFieldId: aFieldId })}::jsonb,
                ${orderB}, ${user.id}
              )
            `.execute(trx);

            await sql`
              INSERT INTO data.link_relations (
                id, workspace_id, base_id, a_table_id, a_field_id, b_table_id, b_field_id,
                allow_multiple_a, allow_multiple_b
              ) VALUES (
                ${relationId}, ${table.workspaceId}, ${baseId}, ${tableId}, ${aFieldId},
                ${linkedTableId}, ${bFieldId}, ${allowMultiple}, ${allowMultiple}
              )
            `.execute(trx);

            return {
              kind: "schema" as const,
              ops: [{ op: "link_fields.created", relationId, aFieldId, bFieldId }],
              inverseOps: [{ op: "link_fields.deleted", relationId }],
              tableIds: [tableId, linkedTableId],
              eventType: "field.created",
              aggregateType: "field",
              aggregateId: aFieldId,
              payload: { relationId },
            };
          },
        );

        void reply.code(201).send({
          relationId,
          fields: [
            { id: pid("fld", aFieldId), tableId: pid("tbl", tableId) },
            { id: pid("fld", bFieldId), tableId: pid("tbl", linkedTableId) },
          ],
        });
      } catch (err) {
        handleRouteError(request, reply, err);
      }
    },
  );

  app.post<{ Params: { baseId: string; tableId: string; recordId: string } }>(
    "/v1/bases/:baseId/tables/:tableId/records/:recordId/links",
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
        const body = linkMutationBody.parse(request.body);
        const fieldId = parsePid(body.fieldId, "fld");

        const table = await resolveTableContext(ctx.db, user.id, baseId, tableId);
        if (!table.ok) {
          notFound(request, reply, "Table not found");
          return;
        }

        const updateSnapshot = await compileForUser(ctx.db, user.id, baseId);
        assertCan(updateSnapshot, "record.update");

        const ops = body.recordIds.map((recordId) => ({
          kind: "add" as const,
          recordId,
        }));

        await withBaseTx(
          ctx.db,
          {
            orgId: table.orgId,
            workspaceId: table.workspaceId,
            baseId,
            actor: actor(user),
            redis: ctx.redis,
          },
          async (mctx, trx) => {
            const { nextIds } = await applyLinkOpsInTx(trx, {
              workspaceId: table.workspaceId,
              baseId,
              tableId,
              recordId,
              fieldId,
              ops,
            });

            const fieldRow = await sql<{ slot: number }>`
              SELECT slot FROM data.fields WHERE id = ${fieldId} AND table_id = ${tableId}
            `.execute(trx);
            const slot = fieldRow.rows[0]?.slot;
            if (slot !== undefined) {
              await sql`
                UPDATE data.records
                SET cells = jsonb_set(
                      COALESCE(cells, '{}'::jsonb),
                      ARRAY[${String(slot)}],
                      ${JSON.stringify(nextIds)}::jsonb,
                      true
                    ),
                    version = version + 1,
                    last_change_seq = ${mctx.changeSeq},
                    updated_at = now(),
                    updated_by = ${user.id}
                WHERE table_id = ${tableId} AND id = ${recordId} AND deleted_at IS NULL
              `.execute(trx);
            }

            await recomputeInTx(
              trx,
              baseId,
              table.workspaceId,
              [{ tableId, recordId }],
              [fieldId],
              ctx.redis,
            );

            return {
              kind: "links" as const,
              ops: [{ op: "link.add", recordId, fieldId, targets: nextIds }],
              tableIds: [tableId],
              eventType: "record.links_changed",
              aggregateType: "record",
              aggregateId: recordId,
              payload: { fieldId },
            };
          },
        );

        void reply.send({ ok: true });
      } catch (err) {
        if (err instanceof Error && err.message === "LINK_CARDINALITY") {
          handleRouteError(request, reply, err);
          return;
        }
        handleRouteError(request, reply, err);
      }
    },
  );

  app.delete<{ Params: { baseId: string; tableId: string; recordId: string } }>(
    "/v1/bases/:baseId/tables/:tableId/records/:recordId/links",
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
        const body = linkMutationBody.parse(request.body);
        const fieldId = parsePid(body.fieldId, "fld");

        const table = await resolveTableContext(ctx.db, user.id, baseId, tableId);
        if (!table.ok) {
          notFound(request, reply, "Table not found");
          return;
        }

        const deleteSnapshot = await compileForUser(ctx.db, user.id, baseId);
        assertCan(deleteSnapshot, "record.update");

        const ops = body.recordIds.map((id) => ({
          kind: "remove" as const,
          recordId: id,
        }));

        await withBaseTx(
          ctx.db,
          {
            orgId: table.orgId,
            workspaceId: table.workspaceId,
            baseId,
            actor: actor(user),
            redis: ctx.redis,
          },
          async (mctx, trx) => {
            const { nextIds } = await applyLinkOpsInTx(trx, {
              workspaceId: table.workspaceId,
              baseId,
              tableId,
              recordId,
              fieldId,
              ops,
            });

            const fieldRow = await sql<{ slot: number }>`
              SELECT slot FROM data.fields WHERE id = ${fieldId} AND table_id = ${tableId}
            `.execute(trx);
            const slot = fieldRow.rows[0]?.slot;
            if (slot !== undefined) {
              await sql`
                UPDATE data.records
                SET cells = jsonb_set(
                      COALESCE(cells, '{}'::jsonb),
                      ARRAY[${String(slot)}],
                      ${JSON.stringify(nextIds)}::jsonb,
                      true
                    ),
                    version = version + 1,
                    last_change_seq = ${mctx.changeSeq},
                    updated_at = now(),
                    updated_by = ${user.id}
                WHERE table_id = ${tableId} AND id = ${recordId} AND deleted_at IS NULL
              `.execute(trx);
            }

            await recomputeInTx(
              trx,
              baseId,
              table.workspaceId,
              [{ tableId, recordId }],
              [fieldId],
              ctx.redis,
            );

            return {
              kind: "links" as const,
              ops: [{ op: "link.remove", recordId, fieldId, targets: body.recordIds }],
              tableIds: [tableId],
              eventType: "record.links_changed",
              aggregateType: "record",
              aggregateId: recordId,
              payload: { fieldId },
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
