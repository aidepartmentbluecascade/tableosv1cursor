import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import Fastify, { type FastifyBaseLogger } from "fastify";
import type { AppContext } from "../lib/app-context.js";
import { registerAuthRoutes } from "../modules/auth/routes.js";
import { registerBaseRoutes } from "../modules/base/routes.js";
import { registerRecordsRoutes } from "../modules/records/routes.js";
import { registerQueryRoutes } from "../modules/query/routes.js";
import { registerSchemaRoutes } from "../modules/schema/routes.js";
import { registerViewsRoutes } from "../modules/views/routes.js";
import { registerLinksRoutes } from "../modules/links/routes.js";
import { registerHistoryRoutes } from "../modules/history/routes.js";
import { registerWorkspaceRoutes } from "../modules/workspace/routes.js";
import { authHook } from "./auth-hook.js";
import { registerIdempotency } from "./idempotency.js";
import { PROBLEM_CONTENT_TYPE, sendProblem } from "./errors.js";
import { registerInvitationRoutes } from "../modules/invitations/routes.js";
import { registerWave4Routes } from "../modules/wave4/routes.js";
import { registerBillingRoutes } from "../modules/billing/routes.js";
import { registerFeatureFlagRoutes } from "../modules/feature-flags/routes.js";
import { registerAutomationsRoutes } from "../modules/automations/routes.js";
import { buildOpenApiDocument } from "./openapi.js";
import { TabulaErrorCodes, createTabulaError } from "@tabula/types";

export async function buildFastify(ctx: AppContext) {
  const app = Fastify({
    loggerInstance: ctx.log as unknown as FastifyBaseLogger,
    genReqId: () => crypto.randomUUID(),
    requestIdHeader: "x-request-id",
  });

  await app.register(cors, {
    origin: ctx.env.APP_URL,
    credentials: true,
  });

  await app.register(cookie, {
    secret: ctx.env.SESSION_SECRET,
  });

  app.addHook("preHandler", async (request, reply) => {
    await authHook(ctx, request, reply);
    if (reply.sent) {
      return;
    }
  });

  await registerIdempotency(app, ctx);

  app.setErrorHandler((error, request, reply) => {
    request.log.error({ err: error }, "Unhandled error");
    sendProblem(
      reply,
      request,
      createTabulaError(TabulaErrorCodes.VALIDATION_FAILED, {
        status: 500,
        title: "Internal server error",
        detail: error instanceof Error ? error.message : "Unknown error",
      }),
    );
  });

  app.get("/health", async () => ({ ok: true }));

  app.get("/v1/openapi.json", async (_request, reply) => {
    void reply.send(buildOpenApiDocument(ctx.env.API_URL));
  });

  await registerAuthRoutes(app, ctx);
  await registerInvitationRoutes(app, ctx);
  await registerWorkspaceRoutes(app, ctx);
  await registerBaseRoutes(app, ctx);
  await registerSchemaRoutes(app, ctx);
  await registerRecordsRoutes(app, ctx);
  await registerLinksRoutes(app, ctx);
  await registerHistoryRoutes(app, ctx);
  await registerQueryRoutes(app, ctx);
  await registerViewsRoutes(app, ctx);
  await registerWave4Routes(app, ctx);
  await registerBillingRoutes(app, ctx);
  await registerFeatureFlagRoutes(app, ctx);
  await registerAutomationsRoutes(app, ctx);

  app.setNotFoundHandler((request, reply) => {
    sendProblem(
      reply,
      request,
      createTabulaError(TabulaErrorCodes.NOT_FOUND, {
        detail: `Route ${request.method} ${request.url} not found`,
      }),
    );
  });

  return app;
}

export { PROBLEM_CONTENT_TYPE };
