import { generateUuidV7 } from "@tabula/types";
import { QueueNames, createQueue } from "@tabula/jobs";
import { sql } from "kysely";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../../lib/app-context.js";
import { parsePid, pid } from "../../lib/public-ids.js";
import { handleRouteError, notFound } from "../../http/errors.js";
import { resolveBaseContext, resolveTableContext } from "../access/helpers.js";
import { withBaseTx, type MutationActor } from "../../kernel/mutation.js";
import { loadTableFields, mapInputFieldsToCells } from "../schema/field-map.js";
import { insertOneRecordFromImport } from "./import-records.js";

const importBody = z.object({
  tableId: z.string(),
  filename: z.string().optional(),
  rows: z.array(z.record(z.unknown())).min(1).max(5000),
});

const exportBody = z.object({
  tableId: z.string(),
});

function actor(user: NonNullable<import("fastify").FastifyRequest["user"]>): MutationActor {
  return {
    actorType: "user",
    actorId: user.id,
    sessionId: user.sessionId,
    via: "api",
  };
}

export async function registerImportExportRoutes(
  app: FastifyInstance,
  ctx: AppContext,
): Promise<void> {
  app.post<{ Params: { baseId: string } }>(
    "/v1/bases/:baseId/import/csv",
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

        const body = importBody.parse(request.body);
        const tableId = parsePid(body.tableId, "tbl");
        const table = await resolveTableContext(ctx.db, user.id, baseId, tableId);
        if (!table.ok) {
          notFound(request, reply, "Table not found");
          return;
        }

        const longOpId = generateUuidV7();
        const importJobId = generateUuidV7();

        await ctx.db.transaction().execute(async (trx) => {
          await sql`
            INSERT INTO data.long_operations (
              id, workspace_id, base_id, kind, status, created_by
            ) VALUES (
              ${longOpId}, ${base.workspaceId}, ${baseId}, 'import', 'running', ${user.id}
            )
          `.execute(trx);

          await sql`
            INSERT INTO data.import_jobs (
              id, workspace_id, base_id, table_id, long_operation_id,
              status, source_filename, rows_total, created_by
            ) VALUES (
              ${importJobId}, ${base.workspaceId}, ${baseId}, ${tableId}, ${longOpId},
              'running', ${body.filename ?? "import.json"}, ${body.rows.length}, ${user.id}
            )
          `.execute(trx);
        });

        const fieldRows = await loadTableFields(ctx.db, tableId);
        let imported = 0;
        let failed = 0;

        for (let i = 0; i < body.rows.length; i++) {
          const row = body.rows[i];
          if (!row) continue;
          try {
            const cells = mapInputFieldsToCells(fieldRows, row);
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
                const recordId = await insertOneRecordFromImport(trx, {
                  tableId,
                  baseId,
                  workspaceId: base.workspaceId,
                  userId: user.id,
                  cells,
                });
                return {
                  kind: "records" as const,
                  ops: [{ op: "record.created", recordId, cells }],
                  eventType: "record.created",
                  aggregateType: "record",
                  aggregateId: recordId,
                  payload: { tableId },
                };
              },
            );
            imported += 1;
          } catch (err) {
            failed += 1;
            await sql`
              INSERT INTO data.import_errors (
                id, import_job_id, workspace_id, source_row, message
              ) VALUES (
                ${generateUuidV7()}, ${importJobId}, ${base.workspaceId},
                ${i + 1}, ${err instanceof Error ? err.message : "Import failed"}
              )
            `.execute(ctx.db);
          }
        }

        const finalStatus = failed === 0 ? "succeeded" : imported > 0 ? "succeeded" : "failed";

        await sql`
          UPDATE data.import_jobs
          SET status = ${finalStatus},
              rows_imported = ${imported},
              rows_failed = ${failed},
              finished_at = now()
          WHERE id = ${importJobId}
        `.execute(ctx.db);

        await sql`
          UPDATE data.long_operations
          SET status = 'completed',
              progress = ${JSON.stringify({ imported, failed })}::jsonb,
              completed_at = now(),
              updated_at = now()
          WHERE id = ${longOpId}
        `.execute(ctx.db);

        if (ctx.redis) {
          const queue = createQueue(QueueNames.IMPORT, ctx.redis);
          await queue.add("import.completed", { importJobId });
        }

        void reply.code(202).send({
          importJobId: pid("imp", importJobId),
          longOperationId: pid("lop", longOpId),
          rowsImported: imported,
          rowsFailed: failed,
          status: finalStatus,
        });
      } catch (err) {
        handleRouteError(request, reply, err);
      }
    },
  );

  app.post<{ Params: { baseId: string } }>(
    "/v1/bases/:baseId/export/csv",
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

        const body = exportBody.parse(request.body);
        const tableId = parsePid(body.tableId, "tbl");
        const table = await resolveTableContext(ctx.db, user.id, baseId, tableId);
        if (!table.ok) {
          notFound(request, reply, "Table not found");
          return;
        }

        const fieldRows = await loadTableFields(ctx.db, tableId);
        const records = await sql<{ id: string; cells: Record<string, unknown> }>`
          SELECT id, cells
          FROM data.records
          WHERE table_id = ${tableId} AND deleted_at IS NULL
          ORDER BY row_number ASC
          LIMIT 10000
        `.execute(ctx.db);

        const headers = fieldRows.map((f) => f.name);
        const lines = [headers.map(escapeCsv).join(",")];

        for (const rec of records.rows) {
          const values = fieldRows.map((f) => {
            const raw = rec.cells[String(f.slot)];
            if (raw === null || raw === undefined) return "";
            return typeof raw === "string" ? raw : JSON.stringify(raw);
          });
          lines.push(values.map(escapeCsv).join(","));
        }

        const csv = lines.join("\n");
        const exportJobId = generateUuidV7();

        await sql`
          INSERT INTO data.export_jobs (
            id, workspace_id, base_id, table_id, status, row_count, requested_by, finished_at
          ) VALUES (
            ${exportJobId}, ${base.workspaceId}, ${baseId}, ${tableId},
            'succeeded', ${records.rows.length}, ${user.id}, now()
          )
        `.execute(ctx.db);

        void reply.send({
          exportJobId: pid("exp", exportJobId),
          format: "csv",
          rowCount: records.rows.length,
          csv,
        });
      } catch (err) {
        handleRouteError(request, reply, err);
      }
    },
  );
}

function escapeCsv(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}
