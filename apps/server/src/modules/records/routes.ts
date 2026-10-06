import type { Database } from "@tabula/db";
import { generateUuidV7 } from "@tabula/types";
import { sql, type Transaction } from "kysely";

type DbTrx = Transaction<Database>;
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../../lib/app-context.js";
import { nextOrderKey } from "../../lib/order-key.js";
import { parsePid, pid } from "../../lib/public-ids.js";
import {
  conflict,
  handleRouteError,
  notFound,
} from "../../http/errors.js";
import { resolveTableContext } from "../access/helpers.js";
import { assertCan } from "../access/assert.js";
import { compileForUser } from "../access/compile.js";
import { withBaseTx, type MutationActor } from "../../kernel/mutation.js";
import { loadTableFields, mapInputFieldsToCells } from "../schema/field-map.js";
import { afterRecordCellWrite } from "./post-write.js";
import { createDeletionBatchInTx } from "../history/apply-inverse.js";
import {
  loadSidecarFields,
  loadSidecarTableMeta,
} from "../recordstore/load-meta.js";
import { deleteSidecars, upsertSidecars } from "../recordstore/sidecars.js";
import { LimitsService } from "../billing/limits-service.js";

const recordBody = z.object({
  fields: z.record(z.unknown()),
  version: z.number().int().positive().optional(),
});

const batchBody = z.object({
  records: z.array(
    z.object({
      id: z.string().optional(),
      fields: z.record(z.unknown()),
    }),
  ),
  atomic: z.boolean().optional(),
});

function actor(user: NonNullable<import("fastify").FastifyRequest["user"]>): MutationActor {
  return {
    actorType: "user",
    actorId: user.id,
    sessionId: user.sessionId,
    via: "api",
  };
}

async function insertOneRecord(
  trx: DbTrx,
  params: {
    tableId: string;
    baseId: string;
    workspaceId: string;
    userId: string;
    recordId?: string;
    cells: Record<string, unknown>;
    changeSeq: number;
    sidecarFields: Awaited<ReturnType<typeof loadSidecarFields>>;
    sidecarTable: Awaited<ReturnType<typeof loadSidecarTableMeta>>;
  },
): Promise<string> {
  const recordId = params.recordId ?? generateUuidV7();

  const rowNum = await sql<{ row_number: string }>`
    UPDATE data.tables
    SET next_row_number = next_row_number + 1,
        record_count = record_count + 1,
        updated_at = now()
    WHERE id = ${params.tableId}
    RETURNING (next_row_number - 1) AS row_number
  `.execute(trx);

  const rowNumber = rowNum.rows[0]?.row_number ?? "1";
  const manualOrder = nextOrderKey();

  await sql`
    INSERT INTO data.records (
      table_id, id, workspace_id, base_id, row_number, manual_order, cells,
      created_by, created_via, last_change_seq
    ) VALUES (
      ${params.tableId}, ${recordId}, ${params.workspaceId}, ${params.baseId},
      ${rowNumber}, ${manualOrder}, ${JSON.stringify(params.cells)}::jsonb,
      ${params.userId}, 'api', ${params.changeSeq}
    )
  `.execute(trx);

  await upsertSidecars(
    trx,
    params.tableId,
    recordId,
    params.cells,
    params.sidecarFields,
    params.sidecarTable,
  );

  await sql`
    UPDATE data.base_runtime
    SET record_count = record_count + 1, updated_at = now()
    WHERE base_id = ${params.baseId}
  `.execute(trx);

  return recordId;
}

export async function registerRecordsRoutes(
  app: FastifyInstance,
  ctx: AppContext,
): Promise<void> {
  const limits = new LimitsService(ctx.db);

  app.post<{ Params: { baseId: string; tableId: string } }>(
    "/v1/bases/:baseId/tables/:tableId/records",
    async (request, reply) => {
      try {
        const user = request.user;
        if (!user) {
          notFound(request, reply);
          return;
        }
        const baseId = parsePid(request.params.baseId, "bas");
        const tableId = parsePid(request.params.tableId, "tbl");
        const body = recordBody.parse(request.body);
        const table = await resolveTableContext(ctx.db, user.id, baseId, tableId);
        if (!table.ok) {
          notFound(request, reply, "Table not found");
          return;
        }

        const snapshot = await compileForUser(ctx.db, user.id, baseId);
        assertCan(snapshot, "record.create");

        await limits.assertCanCreateRecord(table.orgId, baseId, 1);

        const fieldRows = await loadTableFields(ctx.db, tableId);
        const sidecarFields = await loadSidecarFields(ctx.db, tableId);
        const sidecarTable = await loadSidecarTableMeta(
          ctx.db,
          tableId,
          table.workspaceId,
          baseId,
        );
        const cells = mapInputFieldsToCells(fieldRows, body.fields);
        let recordId = "";

        const seq = await withBaseTx(
          ctx.db,
          {
            orgId: table.orgId,
            workspaceId: table.workspaceId,
            baseId,
            actor: actor(user),
            redis: ctx.redis,
          },
          async (mctx, trx) => {
            recordId = await insertOneRecord(trx, {
              tableId,
              baseId,
              workspaceId: table.workspaceId,
              userId: user.id,
              cells,
              changeSeq: mctx.changeSeq,
              sidecarFields,
              sidecarTable,
            });
            await afterRecordCellWrite(trx, {
              redis: ctx.redis,
              baseId,
              workspaceId: table.workspaceId,
              tableId,
              recordId,
              fieldRows,
              cells,
              changedSlots: cells,
            });
            return {
              kind: "records" as const,
              ops: [{ op: "record.created", recordId, cells }],
              inverseOps: [{ op: "record.deleted", recordId }],
              tableIds: [tableId],
              eventType: "record.created",
              aggregateType: "record",
              aggregateId: recordId,
              payload: { tableId },
            };
          },
        );

        void reply.code(201).send({
          record: {
            id: pid("rec", recordId),
            version: 1,
            createdAt: new Date().toISOString(),
            fields: Object.fromEntries(
              Object.entries(cells).map(([slot, value]) => {
                const field = fieldRows.find((f) => String(f.slot) === slot);
                return field ? [pid("fld", field.id), value] : [slot, value];
              }),
            ),
            changeSeq: seq,
          },
        });
      } catch (err) {
        handleRouteError(request, reply, err);
      }
    },
  );

  app.post<{ Params: { baseId: string; tableId: string } }>(
    // Fastify/find-my-way cannot host AIP-style "records:batch" (colon = param).
    // Public API docs keep the colon form; HTTP path uses /batch until a rewrite layer.
    "/v1/bases/:baseId/tables/:tableId/records/batch",
    async (request, reply) => {
      try {
        const user = request.user;
        if (!user) {
          notFound(request, reply);
          return;
        }
        const baseId = parsePid(request.params.baseId, "bas");
        const tableId = parsePid(request.params.tableId, "tbl");
        const body = batchBody.parse(request.body);
        const table = await resolveTableContext(ctx.db, user.id, baseId, tableId);
        if (!table.ok) {
          notFound(request, reply, "Table not found");
          return;
        }

        const batchSnapshot = await compileForUser(ctx.db, user.id, baseId);
        assertCan(batchSnapshot, "record.create");

        await limits.assertCanCreateRecord(
          table.orgId,
          baseId,
          body.records.length,
        );

        const fieldRows = await loadTableFields(ctx.db, tableId);
        const sidecarFields = await loadSidecarFields(ctx.db, tableId);
        const sidecarTable = await loadSidecarTableMeta(
          ctx.db,
          tableId,
          table.workspaceId,
          baseId,
        );
        const createdIds: string[] = [];

        const seq = await withBaseTx(
          ctx.db,
          {
            orgId: table.orgId,
            workspaceId: table.workspaceId,
            baseId,
            actor: actor(user),
            redis: ctx.redis,
          },
          async (mctx, trx) => {
            const ops: unknown[] = [];
            for (const item of body.records) {
              const cells = mapInputFieldsToCells(fieldRows, item.fields);
              const recordId = item.id
                ? parsePid(item.id, "rec")
                : undefined;
              const id = await insertOneRecord(trx, {
                tableId,
                baseId,
                workspaceId: table.workspaceId,
                userId: user.id,
                cells,
                changeSeq: mctx.changeSeq,
                sidecarFields,
                sidecarTable,
                ...(recordId !== undefined ? { recordId } : {}),
              });
              await afterRecordCellWrite(trx, {
                redis: ctx.redis,
                baseId,
                workspaceId: table.workspaceId,
                tableId,
                recordId: id,
                fieldRows,
                cells,
                changedSlots: cells,
              });
              createdIds.push(id);
              ops.push({ op: "record.created", recordId: id });
            }
            return {
              kind: "bulk" as const,
              ops,
              tableIds: [tableId],
              eventType: "records.batch_created",
              aggregateType: "table",
              aggregateId: tableId,
              payload: { count: createdIds.length },
            };
          },
        );

        void reply.code(201).send({
          records: createdIds.map((id) => ({ id: pid("rec", id) })),
          changeSeq: seq,
        });
      } catch (err) {
        handleRouteError(request, reply, err);
      }
    },
  );

  app.patch<{ Params: { baseId: string; tableId: string; recordId: string } }>(
    "/v1/bases/:baseId/tables/:tableId/records/:recordId",
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
        const body = recordBody.parse(request.body);
        const table = await resolveTableContext(ctx.db, user.id, baseId, tableId);
        if (!table.ok) {
          notFound(request, reply, "Table not found");
          return;
        }

        const updateSnapshot = await compileForUser(ctx.db, user.id, baseId);
        assertCan(updateSnapshot, "record.update");

        const ifMatch = request.headers["if-match"];
        const expectedVersion =
          ifMatch !== undefined
            ? Number(ifMatch.replace(/"/g, ""))
            : body.version;

        const fieldRows = await loadTableFields(ctx.db, tableId);
        const sidecarFields = await loadSidecarFields(ctx.db, tableId);
        const sidecarTable = await loadSidecarTableMeta(
          ctx.db,
          tableId,
          table.workspaceId,
          baseId,
        );
        const patchCells = mapInputFieldsToCells(fieldRows, body.fields);

        const seq = await withBaseTx(
          ctx.db,
          {
            orgId: table.orgId,
            workspaceId: table.workspaceId,
            baseId,
            actor: actor(user),
            redis: ctx.redis,
          },
          async (mctx, trx) => {
            const existing = await sql<{
              cells: unknown;
              version: string;
            }>`
              SELECT cells, version FROM data.records
              WHERE table_id = ${tableId} AND id = ${recordId} AND deleted_at IS NULL
              FOR UPDATE
            `.execute(trx);

            const row = existing.rows[0];
            if (!row) {
              throw new Error("RECORD_NOT_FOUND");
            }

            const currentVersion = Number(row.version);
            if (
              expectedVersion !== undefined &&
              !Number.isNaN(expectedVersion) &&
              expectedVersion !== currentVersion
            ) {
              throw new Error("VERSION_CONFLICT");
            }

            const merged = {
              ...(row.cells as Record<string, unknown>),
              ...patchCells,
            };

            await sql`
              UPDATE data.records
              SET cells = ${JSON.stringify(merged)}::jsonb,
                  version = version + 1,
                  updated_by = ${user.id},
                  updated_at = now(),
                  last_change_seq = ${mctx.changeSeq}
              WHERE table_id = ${tableId} AND id = ${recordId}
            `.execute(trx);

            await upsertSidecars(
              trx,
              tableId,
              recordId,
              merged,
              sidecarFields,
              sidecarTable,
            );

            await afterRecordCellWrite(trx, {
              redis: ctx.redis,
              baseId,
              workspaceId: table.workspaceId,
              tableId,
              recordId,
              fieldRows,
              cells: merged,
              changedSlots: patchCells,
            });

            return {
              kind: "records" as const,
              ops: [{ op: "record.updated", recordId, cells: merged }],
              inverseOps: [
                {
                  op: "record.updated",
                  recordId,
                  cells: row.cells as Record<string, unknown>,
                },
              ],
              tableIds: [tableId],
              eventType: "record.updated",
              aggregateType: "record",
              aggregateId: recordId,
              payload: { version: currentVersion + 1 },
            };
          },
        );

        void reply.send({
          record: { id: pid("rec", recordId), changeSeq: seq },
        });
      } catch (err) {
        if (err instanceof Error && err.message === "VERSION_CONFLICT") {
          conflict(request, reply, "Record version mismatch");
          return;
        }
        if (err instanceof Error && err.message === "RECORD_NOT_FOUND") {
          notFound(request, reply, "Record not found");
          return;
        }
        handleRouteError(request, reply, err);
      }
    },
  );

  app.delete<{ Params: { baseId: string; tableId: string; recordId: string } }>(
    "/v1/bases/:baseId/tables/:tableId/records/:recordId",
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

        const deleteSnapshot = await compileForUser(ctx.db, user.id, baseId);
        assertCan(deleteSnapshot, "record.delete");

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
            const batchId = await createDeletionBatchInTx(trx, {
              workspaceId: table.workspaceId,
              baseId,
              userId: user.id,
            });
            await sql`
              UPDATE data.records
              SET deleted_at = now(), deleted_by = ${user.id}, updated_at = now(),
                  deletion_batch_id = ${batchId},
                  last_change_seq = ${mctx.changeSeq}
              WHERE table_id = ${tableId} AND id = ${recordId} AND deleted_at IS NULL
            `.execute(trx);
            await sql`
              UPDATE data.record_links
              SET deletion_batch_id = ${batchId}
              WHERE base_id = ${baseId}
                AND (a_record_id = ${recordId} OR b_record_id = ${recordId})
                AND deletion_batch_id IS NULL
            `.execute(trx);
            await deleteSidecars(trx, tableId, recordId);
            await sql`
              UPDATE data.tables SET record_count = GREATEST(record_count - 1, 0) WHERE id = ${tableId}
            `.execute(trx);
            return {
              kind: "records" as const,
              ops: [{ op: "record.soft_deleted", recordId, batchId }],
              inverseOps: [{ op: "record.restore", batchId }],
              tableIds: [tableId],
              eventType: "record.deleted",
              aggregateType: "record",
              aggregateId: recordId,
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
