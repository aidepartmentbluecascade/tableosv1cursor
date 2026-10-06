import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../../lib/app-context.js";
import { pid } from "../../lib/public-ids.js";
import { handleRouteError, notFound } from "../../http/errors.js";
import { LimitsService } from "./limits-service.js";
import { resolveBillingOrgId } from "./resolve-org.js";
import { upgradeOrgToTeamPlan } from "./subscription.js";

const upgradeBody = z.object({
  organizationId: z.string().optional(),
  plan: z.enum(["team"]).default("team"),
});

export async function registerBillingRoutes(
  app: FastifyInstance,
  ctx: AppContext,
): Promise<void> {
  const limits = new LimitsService(ctx.db);

  app.get<{ Querystring: { organizationId?: string } }>(
    "/v1/billing/plan",
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
        if (!orgId) {
          notFound(request, reply, "Organization not found");
          return;
        }

        const plan = await limits.getOrgPlan(orgId);
        const usage = await limits.getUsage(orgId);

        const usagePublic = {
          recordsByBase: Object.fromEntries(
            Object.entries(usage.recordsByBase).map(([baseId, count]) => [
              pid("bas", baseId),
              count,
            ]),
          ),
          attachmentBytesByBase: Object.fromEntries(
            Object.entries(usage.attachmentBytesByBase).map(
              ([baseId, bytes]) => [pid("bas", baseId), bytes],
            ),
          ),
        };

        void reply.send({
          organizationId: pid("org", orgId),
          plan: {
            code: plan.planCode,
            name: plan.planName,
          },
          limits: plan.limits,
          usage: usagePublic,
        });
      } catch (err) {
        handleRouteError(request, reply, err);
      }
    },
  );

  /** In-app plan upgrade (no Stripe). Org owner/admin upgrades Free → Team. */
  app.post("/v1/billing/upgrade", async (request, reply) => {
    try {
      const user = request.user;
      if (!user) {
        notFound(request, reply);
        return;
      }

      const body = upgradeBody.parse(request.body ?? {});
      const orgId = await resolveBillingOrgId(
        ctx.db,
        user.id,
        body.organizationId,
      );
      if (!orgId) {
        notFound(request, reply, "Organization not found");
        return;
      }

      await upgradeOrgToTeamPlan(ctx.db, orgId);
      void reply.send({ plan: "team" as const });
    } catch (err) {
      handleRouteError(request, reply, err);
    }
  });

  /** @deprecated Prefer POST /v1/billing/upgrade — kept for existing clients. */
  app.post("/v1/billing/checkout", async (request, reply) => {
    try {
      const user = request.user;
      if (!user) {
        notFound(request, reply);
        return;
      }

      const body = upgradeBody
        .partial()
        .parse(request.body ?? {});
      const orgId = await resolveBillingOrgId(
        ctx.db,
        user.id,
        body.organizationId,
      );
      if (!orgId) {
        notFound(request, reply, "Organization not found");
        return;
      }

      await upgradeOrgToTeamPlan(ctx.db, orgId);
      void reply.send({ mode: "in_app" as const, plan: "team" as const });
    } catch (err) {
      handleRouteError(request, reply, err);
    }
  });
}
