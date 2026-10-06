import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../../lib/app-context.js";
import { parsePid } from "../../lib/public-ids.js";
import { handleRouteError, notFound } from "../../http/errors.js";
import { resolveTableContext } from "../access/helpers.js";
import { executeRecordQuery } from "./execute-record-query.js";
import { executeGroupQuery } from "./group-query.js";

const queryBody = z.object({
  filter: z.unknown().optional(),
  sort: z
    .array(z.object({ field: z.string(), direction: z.enum(["asc", "desc"]) }))
    .optional(),
  pageSize: z.number().int().min(1).max(500).optional(),
  cursor: z.string().optional(),
  fields: z.array(z.string()).optional(),
});

const groupBody = z.object({
  filter: z.unknown().optional(),
  groupBy: z.array(z.object({ fieldId: z.string().min(1) })).min(1).max(3),
  aggregates: z
    .array(
      z.object({
        op: z.enum(["count", "sum"]),
        fieldId: z.string().optional(),
      }),
    )
    .min(1)
    .max(8),
});

export async function registerQueryRoutes(
  app: FastifyInstance,
  ctx: AppContext,
): Promise<void> {
  app.post<{ Params: { baseId: string; tableId: string } }>(
    "/v1/bases/:baseId/tables/:tableId/records/query",
    async (request, reply) => {
      try {
        const user = request.user;
        if (!user) {
          notFound(request, reply);
          return;
        }
        const baseId = parsePid(request.params.baseId, "bas");
        const tableId = parsePid(request.params.tableId, "tbl");
        const body = queryBody.parse(request.body);
        const table = await resolveTableContext(ctx.db, user.id, baseId, tableId);
        if (!table.ok) {
          notFound(request, reply, "Table not found");
          return;
        }

        const pageSize = body.pageSize ?? 100;
        const sort = body.sort?.map((s) => ({
          fieldId: s.field,
          direction: s.direction,
        }));

        const queryInput: import("@tabula/query").RecordQueryInput = {
          pageSize,
        };
        if (body.filter !== undefined) queryInput.filter = body.filter;
        if (sort !== undefined) queryInput.sort = sort;
        if (body.cursor !== undefined) queryInput.cursor = body.cursor;

        const result = await executeRecordQuery(ctx.db, tableId, queryInput);

        void reply.send(result);
      } catch (err) {
        handleRouteError(request, reply, err);
      }
    },
  );

  app.post<{ Params: { baseId: string; tableId: string } }>(
    "/v1/bases/:baseId/tables/:tableId/records/group",
    async (request, reply) => {
      try {
        const user = request.user;
        if (!user) {
          notFound(request, reply);
          return;
        }
        const baseId = parsePid(request.params.baseId, "bas");
        const tableId = parsePid(request.params.tableId, "tbl");
        const body = groupBody.parse(request.body);
        const table = await resolveTableContext(ctx.db, user.id, baseId, tableId);
        if (!table.ok) {
          notFound(request, reply, "Table not found");
          return;
        }

        const result = await executeGroupQuery(ctx.db, tableId, body);
        void reply.send(result);
      } catch (err) {
        handleRouteError(request, reply, err);
      }
    },
  );
}
