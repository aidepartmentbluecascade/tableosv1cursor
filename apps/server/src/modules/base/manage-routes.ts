import { sql } from "kysely";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../../lib/app-context.js";
import { parsePid, pid } from "../../lib/public-ids.js";
import { handleRouteError, notFound } from "../../http/errors.js";
import { resolveBaseContext } from "../access/helpers.js";
import { assertCan } from "../access/assert.js";
import { compileForUser, compileForWorkspace } from "../access/compile.js";
import { duplicateBase } from "./duplicate-base.js";

const duplicateBody = z
  .object({
    name: z.string().min(1).max(200).optional(),
    withRecords: z.boolean().optional(),
    workspaceId: z.string().optional(),
  })
  .default({});

const ROLE_RANK: Record<string, number> = {
  owner: 50,
  creator: 40,
  editor: 30,
  commenter: 20,
  viewer: 10,
  interface_only: 5,
};

function higherRole(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return (ROLE_RANK[a] ?? 0) >= (ROLE_RANK[b] ?? 0) ? a : b;
}

/**
 * Users who can access a base: anyone with a base- or workspace-level grant,
 * plus organization owners/admins. Role is the strongest applicable role.
 */
export async function listBaseCollaborators(
  db: AppContext["db"],
  baseId: string,
  workspaceId: string,
  orgId: string,
): Promise<Array<{ id: string; name: string; email: string; role: string }>> {
  const rows = await sql<{
    user_id: string;
    email: string;
    display_name: string;
    grant_role: string | null;
    grant_scope: string | null;
    org_role: string;
  }>`
    SELECT u.id AS user_id, u.email, u.display_name,
           g.role AS grant_role, g.resource_type AS grant_scope,
           m.role AS org_role
    FROM core.organization_members m
    JOIN core.users u ON u.id = m.user_id AND u.status = 'active'
    LEFT JOIN core.access_grants g
      ON g.principal_type = 'user'
     AND g.principal_id = m.user_id
     AND (
       (g.resource_type = 'base' AND g.resource_id = ${baseId})
       OR (g.resource_type = 'workspace' AND g.resource_id = ${workspaceId})
     )
    WHERE m.org_id = ${orgId} AND m.status = 'active'
  `.execute(db);

  const byUser = new Map<
    string,
    { id: string; name: string; email: string; role: string | null }
  >();
  for (const row of rows.rows) {
    const existing = byUser.get(row.user_id) ?? {
      id: row.user_id,
      name: row.display_name || row.email,
      email: row.email,
      role: null as string | null,
    };
    if (row.grant_role) {
      existing.role = higherRole(existing.role, row.grant_role);
    }
    if (row.org_role === "owner" || row.org_role === "admin") {
      existing.role = higherRole(existing.role, "owner");
    }
    byUser.set(row.user_id, existing);
  }

  return [...byUser.values()]
    .filter((u): u is typeof u & { role: string } => u.role !== null)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((u) => ({ id: pid("usr", u.id), name: u.name, email: u.email, role: u.role }));
}

export async function registerBaseManageRoutes(
  app: FastifyInstance,
  ctx: AppContext,
): Promise<void> {
  app.get<{ Params: { baseId: string } }>(
    "/v1/bases/:baseId/collaborators",
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
        const snapshot = await compileForUser(ctx.db, user.id, baseId);
        assertCan(snapshot, "base.read");

        const collaborators = await listBaseCollaborators(
          ctx.db,
          baseId,
          base.workspaceId,
          base.orgId,
        );
        void reply.send({ collaborators });
      } catch (err) {
        handleRouteError(request, reply, err);
      }
    },
  );

  app.post<{ Params: { baseId: string } }>(
    "/v1/bases/:baseId/duplicate",
    async (request, reply) => {
      try {
        const user = request.user;
        if (!user) {
          notFound(request, reply);
          return;
        }
        const baseId = parsePid(request.params.baseId, "bas");
        const body = duplicateBody.parse(request.body ?? {});
        const base = await resolveBaseContext(ctx.db, user.id, baseId);
        if (!base.ok) {
          notFound(request, reply, "Base not found");
          return;
        }
        const snapshot = await compileForUser(ctx.db, user.id, baseId);
        assertCan(snapshot, "base.read");

        const targetWorkspaceId = body.workspaceId
          ? parsePid(body.workspaceId, "wsp")
          : base.workspaceId;
        const wsSnapshot = await compileForWorkspace(
          ctx.db,
          user.id,
          targetWorkspaceId,
        );
        assertCan(wsSnapshot, "base.manage_schema");

        const name = body.name ?? `${base.name} copy`;
        const result = await duplicateBase(ctx.db, {
          sourceBaseId: baseId,
          targetWorkspaceId,
          orgId: base.orgId,
          shardId: ctx.defaultShardId,
          userId: user.id,
          name,
          withRecords: body.withRecords ?? true,
        });
        void reply.code(201).send({ id: pid("bas", result.baseId), name });
      } catch (err) {
        handleRouteError(request, reply, err);
      }
    },
  );
}
