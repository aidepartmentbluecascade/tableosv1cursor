import { sql } from "kysely";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../../lib/app-context.js";
import { pid } from "../../lib/public-ids.js";
import { handleRouteError, notFound } from "../../http/errors.js";
import { resolveBillingOrgId } from "../billing/resolve-org.js";

interface FlagRow {
  key: string;
  kind: string;
  default_value: unknown;
  rules: unknown;
  status: string;
}

function evaluateFlagMvp(flag: FlagRow): unknown {
  if (flag.status !== "active") {
    return flag.kind === "boolean" ? false : flag.default_value;
  }
  return flag.default_value;
}

export async function registerFeatureFlagRoutes(
  app: FastifyInstance,
  ctx: AppContext,
): Promise<void> {
  app.get<{ Querystring: { organizationId?: string } }>(
    "/v1/feature-flags",
    async (request, reply) => {
      try {
        const user = request.user;
        if (!user) {
          notFound(request, reply);
          return;
        }

        const orgId = await resolveBillingOrgId(
          ctx.db,
          user.id,
          request.query.organizationId,
        );

        let rows: FlagRow[] = [];
        try {
          const result = await sql<FlagRow>`
            SELECT key, kind, default_value, rules, status
            FROM core.feature_flags
            WHERE status = 'active'
            ORDER BY key ASC
          `.execute(ctx.db);
          rows = result.rows;
        } catch {
          rows = [];
        }

        const flags: Record<string, unknown> = {};
        for (const flag of rows) {
          flags[flag.key] = evaluateFlagMvp(flag);
        }

        void reply.send({
          organizationId: orgId ? pid("org", orgId) : null,
          flags,
        });
      } catch (err) {
        handleRouteError(request, reply, err);
      }
    },
  );
}
