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
import { registerKernelRequestContext } from "../kernel/request-context.js";
import { registerIdempotency } from "./idempotency.js";
import { PROBLEM_CONTENT_TYPE, sendProblem } from "./errors.js";
import { registerInvitationRoutes } from "../modules/invitations/routes.js";
import { registerWave4Routes } from "../modules/wave4/routes.js";
import { registerBillingRoutes } from "../modules/billing/routes.js";
import { registerFeatureFlagRoutes } from "../modules/feature-flags/routes.js";
import { registerAutomationsRoutes } from "../modules/automations/routes.js";
import { buildOpenApiDocument } from "./openapi.js";
import { TabulaErrorCodes, createTabulaError } from "@tabula/types";
import { internalErrorProblem, problemFromError } from "./errors.js";
import { setAuditLogger } from "../modules/audit/write.js";
import type { Env } from "@tabula/config";

/**
 * Origins allowed to make credentialed cross-origin calls: the web app, the
 * public share app (PUBLIC_APP_URL; dev default = web port + 1, i.e. 5184),
 * plus anything listed in CORS_ORIGINS (comma separated).
 */
export function corsOrigins(env: Env): Set<string> {
  const out = new Set<string>();
  const add = (u: string | undefined) => {
    if (!u) return;
    try {
      out.add(new URL(u).origin);
    } catch {
      /* ignore malformed */
    }
  };
  add(env.APP_URL);
  add(process.env["PUBLIC_APP_URL"]);
  for (const o of (process.env["CORS_ORIGINS"] ?? "").split(",")) add(o.trim() || undefined);
  if (env.NODE_ENV !== "production") {
    try {
      const app = new URL(env.APP_URL);
      if (app.port) {
        const pub = new URL(env.APP_URL);
        pub.port = String(Number(app.port) + 1);
        out.add(pub.origin);
      }
    } catch {
      /* ignore */
    }
    if (!process.env["PUBLIC_APP_URL"]) out.add("http://localhost:5184");
  }
  return out;
}

export async function buildFastify(ctx: AppContext) {
  const app = Fastify({
    loggerInstance: ctx.log as unknown as FastifyBaseLogger,
    genReqId: () => crypto.randomUUID(),
    requestIdHeader: "x-request-id",
  });

  setAuditLogger(ctx.log);

  const allowedOrigins = corsOrigins(ctx.env);
  await app.register(cors, {
    origin: (origin, cb) => {
      // Same-origin / server-to-server requests carry no Origin header.
      if (!origin || allowedOrigins.has(origin.replace(/\/$/, ""))) {
        cb(null, true);
        return;
      }
      cb(null, false);
    },
    credentials: true,
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    exposedHeaders: ["idempotent-replayed", "x-request-id", "retry-after"],
  });

  await app.register(cookie, {
    secret: ctx.env.SESSION_SECRET,
  });

  registerKernelRequestContext(app);

  app.addHook("preHandler", async (request, reply) => {
    await authHook(ctx, request, reply);
    if (reply.sent) {
      return;
    }
  });

  await registerIdempotency(app, ctx);

  app.setErrorHandler((error, request, reply) => {
    const problem = problemFromError(error);
    if (problem && problem.status < 500) {
      sendProblem(reply, request, problem);
      return;
    }
    request.log.error({ err: error }, "Unhandled error");
    sendProblem(reply, request, problem ?? internalErrorProblem());
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
