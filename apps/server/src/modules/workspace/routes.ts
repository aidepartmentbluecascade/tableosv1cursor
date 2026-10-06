import { generateUuidV7 } from "@tabula/types";
import { sql } from "kysely";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../../lib/app-context.js";
import { parsePid, pid } from "../../lib/public-ids.js";
import { handleRouteError, notFound, validationProblem } from "../../http/errors.js";
import { userCanAccessWorkspace } from "../access/helpers.js";

const createBody = z.object({
  name: z.string().min(1).max(200),
});

export async function registerWorkspaceRoutes(
  app: FastifyInstance,
  ctx: AppContext,
): Promise<void> {
  app.get("/v1/workspaces", async (request, reply) => {
    try {
      const user = request.user;
      if (!user) {
        notFound(request, reply);
        return;
      }

      const result = await sql<{ id: string; name: string; org_id: string }>`
        SELECT w.id, w.name, w.org_id
        FROM core.workspaces w
        INNER JOIN core.organization_members m
          ON m.org_id = w.org_id AND m.user_id = ${user.id} AND m.status = 'active'
        WHERE w.deleted_at IS NULL AND w.status = 'active'
        ORDER BY w.created_at ASC
      `.execute(ctx.db);

      void reply.send({
        workspaces: result.rows.map((r) => ({
          id: pid("wsp", r.id),
          name: r.name,
          organizationId: pid("org", r.org_id),
        })),
      });
    } catch (err) {
      handleRouteError(request, reply, err);
    }
  });

  app.post("/v1/workspaces", async (request, reply) => {
    try {
      const user = request.user;
      if (!user) {
        notFound(request, reply);
        return;
      }

      const body = createBody.parse(request.body);

      const membership = await sql<{ org_id: string }>`
        SELECT org_id FROM core.organization_members
        WHERE user_id = ${user.id} AND status = 'active' AND role = 'owner'
        ORDER BY joined_at ASC
        LIMIT 1
      `.execute(ctx.db);

      const org = membership.rows[0];
      if (!org) {
        validationProblem(request, reply, "No organization available");
        return;
      }

      const workspaceId = generateUuidV7();

      await ctx.db.transaction().execute(async (trx) => {
        await sql`
          INSERT INTO core.workspaces (id, org_id, name, created_by)
          VALUES (${workspaceId}, ${org.org_id}, ${body.name}, ${user.id})
        `.execute(trx);

        await sql`
          INSERT INTO core.workspace_directory (workspace_id, org_id, shard_id, region)
          VALUES (${workspaceId}, ${org.org_id}, ${ctx.defaultShardId}, 'local')
        `.execute(trx);

        await sql`
          INSERT INTO core.access_grants (
            id, org_id, resource_type, resource_id, workspace_id,
            principal_type, principal_id, role, source, granted_by
          ) VALUES (
            ${generateUuidV7()}, ${org.org_id}, 'workspace', ${workspaceId}, ${workspaceId},
            'user', ${user.id}, 'owner', 'creator', ${user.id}
          )
        `.execute(trx);
      });

      void reply.code(201).send({
        workspace: { id: pid("wsp", workspaceId), name: body.name },
      });
    } catch (err) {
      handleRouteError(request, reply, err);
    }
  });

  app.get<{ Params: { workspaceId: string } }>(
    "/v1/workspaces/:workspaceId/bases",
    async (request, reply) => {
      try {
        const user = request.user;
        if (!user) {
          notFound(request, reply);
          return;
        }

        const workspaceId = parsePid(request.params.workspaceId, "wsp");
        const access = await userCanAccessWorkspace(ctx.db, user.id, workspaceId);
        if (!access.ok) {
          notFound(request, reply, "Workspace not found");
          return;
        }

        const result = await sql<{ base_id: string; name: string; order_key: string }>`
          SELECT base_id, name, order_key
          FROM core.base_directory
          WHERE workspace_id = ${workspaceId}
            AND status = 'active'
            AND deleted_at IS NULL
          ORDER BY order_key ASC, created_at ASC
        `.execute(ctx.db);

        void reply.send({
          bases: result.rows.map((r) => ({
            id: pid("bas", r.base_id),
            name: r.name,
          })),
        });
      } catch (err) {
        handleRouteError(request, reply, err);
      }
    },
  );
}
