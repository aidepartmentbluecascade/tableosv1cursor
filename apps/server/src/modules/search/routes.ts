import { sql } from "kysely";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../../lib/app-context.js";
import { parsePid, pid } from "../../lib/public-ids.js";
import { handleRouteError, notFound } from "../../http/errors.js";

export async function registerSearchRoutes(
  app: FastifyInstance,
  ctx: AppContext,
): Promise<void> {
  app.get<{ Querystring: { q?: string; workspaceId?: string } }>(
    "/v1/search",
    async (request, reply) => {
      try {
        const user = request.user;
        if (!user) {
          notFound(request, reply);
          return;
        }

        const q = request.query.q?.trim() ?? "";
        if (!q) {
          void reply.send({ hits: [] });
          return;
        }

        const workspaceFilter = request.query.workspaceId
          ? parsePid(request.query.workspaceId, "wsp")
          : null;

        const accessible = await sql<{ base_id: string }>`
          SELECT DISTINCT bd.base_id
          FROM core.base_directory bd
          INNER JOIN core.organization_members m
            ON m.org_id = bd.org_id AND m.user_id = ${user.id} AND m.status = 'active'
          WHERE bd.status = 'active'
            AND bd.deleted_at IS NULL
            ${workspaceFilter ? sql`AND bd.workspace_id = ${workspaceFilter}` : sql``}
        `.execute(ctx.db);

        const baseIds = accessible.rows.map((r) => r.base_id);
        const hits = await ctx.search.search({ query: q, baseIds, limit: 50 });

        void reply.send({
          hits: hits.map((h) => ({
            documentId: h.id,
            workspaceId: pid("wsp", h.workspaceId),
            baseId: pid("bas", h.baseId),
            docType: h.docType,
            refId:
              h.docType === "record"
                ? pid("rec", h.refId)
                : h.refId,
            title: h.title,
            rank: h.rank,
          })),
        });
      } catch (err) {
        handleRouteError(request, reply, err);
      }
    },
  );
}
