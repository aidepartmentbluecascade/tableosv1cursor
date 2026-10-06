import { generateUuidV7 } from "@tabula/types";
import { sql } from "kysely";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../../lib/app-context.js";
import { parsePid, pid } from "../../lib/public-ids.js";
import { handleRouteError, notFound, validationProblem } from "../../http/errors.js";
import { resolveBaseContext } from "../access/helpers.js";

const TRIGGER_TYPES = [
  "record.matches_conditions",
  "form.submitted",
  "record.created",
  "record.updated",
  "scheduled",
  "record.enters_view",
] as const;

const automationBody = z.object({
  name: z.string().min(1).max(200).optional(),
  trigger: z
    .object({
      type: z.enum(TRIGGER_TYPES),
      config: z.record(z.unknown()).optional(),
    })
    .optional(),
  actions: z.array(z.record(z.unknown())).optional(),
  enabled: z.boolean().optional(),
});

export async function registerAutomationsRoutes(
  app: FastifyInstance,
  ctx: AppContext,
): Promise<void> {
  app.get<{ Params: { baseId: string } }>(
    "/v1/bases/:baseId/automations",
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

        const result = await sql<{
          id: string;
          name: string;
          enabled: boolean;
          trigger: unknown;
          actions: unknown;
          created_at: Date;
          updated_at: Date;
        }>`
          SELECT id, name, enabled, trigger, actions, created_at, updated_at
          FROM data.automations
          WHERE base_id = ${baseId} AND deleted_at IS NULL
          ORDER BY created_at DESC
        `.execute(ctx.db);

        void reply.send({
          automations: result.rows.map((r) => ({
            id: pid("aut", r.id),
            name: r.name,
            enabled: r.enabled,
            trigger: r.trigger,
            actions: r.actions,
            createdAt: r.created_at.toISOString(),
            updatedAt: r.updated_at.toISOString(),
          })),
          limits: { maxAutomations: 150, remaining: Math.max(0, 150 - result.rows.length) },
        });
      } catch (err) {
        handleRouteError(request, reply, err);
      }
    },
  );

  app.post<{ Params: { baseId: string } }>(
    "/v1/bases/:baseId/automations",
    async (request, reply) => {
      try {
        const user = request.user;
        if (!user) {
          notFound(request, reply);
          return;
        }
        const baseId = parsePid(request.params.baseId, "bas");
        const body = automationBody.parse(request.body ?? {});
        const base = await resolveBaseContext(ctx.db, user.id, baseId);
        if (!base.ok) {
          notFound(request, reply, "Base not found");
          return;
        }

        const count = await sql<{ n: string }>`
          SELECT count(*)::text AS n FROM data.automations
          WHERE base_id = ${baseId} AND deleted_at IS NULL
        `.execute(ctx.db);
        if (Number(count.rows[0]?.n ?? 0) >= 150) {
          validationProblem(request, reply, "This base can have up to 150 automations");
          return;
        }

        const id = generateUuidV7();
        const name = body.name?.trim() || "Automation";
        const trigger = body.trigger ?? { type: "record.created" as const };
        const actions = body.actions ?? [];

        await sql`
          INSERT INTO data.automations (
            id, workspace_id, base_id, name, enabled, trigger, actions, created_by
          ) VALUES (
            ${id}, ${base.workspaceId}, ${baseId}, ${name}, ${body.enabled ?? false},
            ${JSON.stringify(trigger)}::jsonb, ${JSON.stringify(actions)}::jsonb, ${user.id}
          )
        `.execute(ctx.db);

        void reply.code(201).send({
          automation: {
            id: pid("aut", id),
            name,
            enabled: body.enabled ?? false,
            trigger,
            actions,
          },
        });
      } catch (err) {
        handleRouteError(request, reply, err);
      }
    },
  );

  app.patch<{ Params: { baseId: string; automationId: string } }>(
    "/v1/bases/:baseId/automations/:automationId",
    async (request, reply) => {
      try {
        const user = request.user;
        if (!user) {
          notFound(request, reply);
          return;
        }
        const baseId = parsePid(request.params.baseId, "bas");
        const automationId = parsePid(request.params.automationId, "aut");
        const body = automationBody.parse(request.body ?? {});
        const base = await resolveBaseContext(ctx.db, user.id, baseId);
        if (!base.ok) {
          notFound(request, reply, "Base not found");
          return;
        }

        const existing = await sql<{ id: string }>`
          SELECT id FROM data.automations
          WHERE id = ${automationId} AND base_id = ${baseId} AND deleted_at IS NULL
          LIMIT 1
        `.execute(ctx.db);
        if (!existing.rows[0]) {
          notFound(request, reply, "Automation not found");
          return;
        }

        if (body.name !== undefined) {
          await sql`
            UPDATE data.automations
            SET name = ${body.name}, updated_by = ${user.id}, updated_at = now()
            WHERE id = ${automationId}
          `.execute(ctx.db);
        }
        if (body.enabled !== undefined) {
          await sql`
            UPDATE data.automations
            SET enabled = ${body.enabled}, updated_by = ${user.id}, updated_at = now()
            WHERE id = ${automationId}
          `.execute(ctx.db);
        }
        if (body.trigger !== undefined) {
          await sql`
            UPDATE data.automations
            SET trigger = ${JSON.stringify(body.trigger)}::jsonb,
                updated_by = ${user.id}, updated_at = now()
            WHERE id = ${automationId}
          `.execute(ctx.db);
        }
        if (body.actions !== undefined) {
          await sql`
            UPDATE data.automations
            SET actions = ${JSON.stringify(body.actions)}::jsonb,
                updated_by = ${user.id}, updated_at = now()
            WHERE id = ${automationId}
          `.execute(ctx.db);
        }

        void reply.send({ ok: true });
      } catch (err) {
        handleRouteError(request, reply, err);
      }
    },
  );

  app.delete<{ Params: { baseId: string; automationId: string } }>(
    "/v1/bases/:baseId/automations/:automationId",
    async (request, reply) => {
      try {
        const user = request.user;
        if (!user) {
          notFound(request, reply);
          return;
        }
        const baseId = parsePid(request.params.baseId, "bas");
        const automationId = parsePid(request.params.automationId, "aut");
        await sql`
          UPDATE data.automations
          SET deleted_at = now(), deleted_by = ${user.id}, updated_at = now()
          WHERE id = ${automationId} AND base_id = ${baseId} AND deleted_at IS NULL
        `.execute(ctx.db);
        void reply.code(204).send();
      } catch (err) {
        handleRouteError(request, reply, err);
      }
    },
  );
}
