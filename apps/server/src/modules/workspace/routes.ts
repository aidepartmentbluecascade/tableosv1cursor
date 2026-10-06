import { generateUuidV7 } from "@tabula/types";
import { sql } from "kysely";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../../lib/app-context.js";
import { parsePid, pid } from "../../lib/public-ids.js";
import { handleRouteError, notFound, validationProblem } from "../../http/errors.js";
import { userCanAccessWorkspace } from "../access/helpers.js";
import { assertCan } from "../access/assert.js";
import { compileForWorkspace } from "../access/compile.js";

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

  app.patch<{ Params: { workspaceId: string } }>(
    "/v1/workspaces/:workspaceId",
    async (request, reply) => {
      try {
        const user = request.user;
        if (!user) {
          notFound(request, reply);
          return;
        }
        const workspaceId = parsePid(request.params.workspaceId, "wsp");
        const body = createBody.parse(request.body);
        const access = await userCanAccessWorkspace(ctx.db, user.id, workspaceId);
        if (!access.ok) {
          notFound(request, reply, "Workspace not found");
          return;
        }
        const snapshot = await compileForWorkspace(ctx.db, user.id, workspaceId);
        assertCan(snapshot, "base.manage_schema");
        await sql`
          UPDATE core.workspaces SET name = ${body.name}, updated_at = now()
          WHERE id = ${workspaceId}
        `.execute(ctx.db);
        void reply.send({
          workspace: { id: pid("wsp", workspaceId), name: body.name },
        });
      } catch (err) {
        handleRouteError(request, reply, err);
      }
    },
  );

  app.delete<{ Params: { workspaceId: string } }>(
    "/v1/workspaces/:workspaceId",
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
        const snapshot = await compileForWorkspace(ctx.db, user.id, workspaceId);
        assertCan(snapshot, "base.manage_members");
        await ctx.db.transaction().execute(async (trx) => {
          await sql`
            UPDATE core.workspaces
            SET status = 'trashed', deleted_at = now(), updated_at = now()
            WHERE id = ${workspaceId}
          `.execute(trx);
          await sql`
            UPDATE core.base_directory
            SET status = 'trashed', deleted_at = now(), updated_at = now()
            WHERE workspace_id = ${workspaceId} AND deleted_at IS NULL
          `.execute(trx);
        });
        void reply.code(204).send();
      } catch (err) {
        handleRouteError(request, reply, err);
      }
    },
  );

  app.get<{ Params: { workspaceId: string } }>(
    "/v1/workspaces/:workspaceId/members",
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
        const rows = await sql<{
          id: string;
          email: string;
          display_name: string;
          org_role: string;
          ws_role: string | null;
        }>`
          SELECT u.id, u.email, u.display_name, m.role AS org_role,
                 (SELECT g.role FROM core.access_grants g
                  WHERE g.principal_type = 'user' AND g.principal_id = u.id
                    AND g.resource_type = 'workspace' AND g.resource_id = ${workspaceId}
                  LIMIT 1) AS ws_role
          FROM core.organization_members m
          JOIN core.users u ON u.id = m.user_id AND u.status = 'active'
          WHERE m.org_id = ${access.orgId} AND m.status = 'active'
          ORDER BY u.display_name ASC, u.email ASC
        `.execute(ctx.db);
        let invitations: Array<{ id: string; email: string; role: string; expiresAt: string }> = [];
        try {
          const inv = await sql<{ id: string; email: string; role: string; expires_at: Date }>`
            SELECT id, email, role, expires_at FROM core.invitations
            WHERE workspace_id = ${workspaceId} AND accepted_at IS NULL
              AND expires_at > now()
            ORDER BY expires_at DESC
            LIMIT 100
          `.execute(ctx.db);
          invitations = inv.rows.map((r) => ({
            id: pid("inv", r.id),
            email: r.email,
            role: r.role,
            expiresAt: new Date(r.expires_at).toISOString(),
          }));
        } catch {
          /* invitations schema may be mid-migration; members still listed */
        }
        void reply.send({
          members: rows.rows.map((r) => ({
            id: pid("usr", r.id),
            name: r.display_name || r.email,
            email: r.email,
            role: r.ws_role ?? (r.org_role === "owner" || r.org_role === "admin" ? "owner" : r.org_role),
          })),
          invitations,
        });
      } catch (err) {
        handleRouteError(request, reply, err);
      }
    },
  );

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
