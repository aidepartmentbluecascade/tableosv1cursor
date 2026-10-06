import { AsyncLocalStorage } from "node:async_hooks";
import type { FastifyInstance } from "fastify";

/**
 * Per-request context that the mutation kernel can read without every route
 * threading it through explicitly. Today it carries the client mutation id
 * (`X-Tabula-Client-Op-Id`, falling back to `Idempotency-Key`) so realtime
 * change frames can be matched to the tab that issued the edit.
 */
export interface KernelRequestContext {
  clientMutationId?: string;
}

const storage = new AsyncLocalStorage<KernelRequestContext>();

export function currentRequestContext(): KernelRequestContext | undefined {
  return storage.getStore();
}

export function runWithRequestContext<T>(
  ctx: KernelRequestContext,
  fn: () => T,
): T {
  return storage.run(ctx, fn);
}

function headerValue(raw: string | string[] | undefined): string | undefined {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 200) return undefined;
  return trimmed;
}

/** Registers an onRequest hook that opens the request context. */
export function registerKernelRequestContext(app: FastifyInstance): void {
  app.addHook("onRequest", (request, _reply, done) => {
    const clientMutationId =
      headerValue(request.headers["x-tabula-client-op-id"]) ??
      headerValue(request.headers["idempotency-key"]);
    const ctx: KernelRequestContext = {};
    if (clientMutationId) ctx.clientMutationId = clientMutationId;
    storage.run(ctx, done);
  });
}
