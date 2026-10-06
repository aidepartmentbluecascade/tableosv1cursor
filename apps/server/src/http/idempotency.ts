import { createHash } from "node:crypto";
import type { TabulaDb } from "@tabula/db";
import { sql } from "kysely";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AppContext } from "../lib/app-context.js";
import { parsePid } from "../lib/public-ids.js";
import { conflict, unauthorized } from "./errors.js";

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const TTL_HOURS = 24;

declare module "fastify" {
  interface FastifyRequest {
    /** Set when an idempotency record was opened for this request. */
    idempotencyKey?: string;
    idempotencyWorkspaceId?: string;
  }
}

function requestHash(method: string, path: string, body: unknown): Buffer {
  const payload = JSON.stringify({ method, path, body: body ?? null });
  return createHash("sha256").update(payload, "utf8").digest();
}

async function resolveWorkspaceId(
  db: TabulaDb,
  request: FastifyRequest,
): Promise<string | null> {
  const path = request.url.split("?")[0] ?? request.url;
  const wsp = path.match(/\/v1\/workspaces\/([^/]+)/)?.[1];
  if (wsp) {
    try {
      return parsePid(wsp, "wsp");
    } catch {
      return null;
    }
  }
  const bas = path.match(/\/v1\/bases\/([^/]+)/)?.[1];
  if (!bas) {
    return null;
  }
  try {
    const baseId = parsePid(bas, "bas");
    const row = await sql<{ workspace_id: string }>`
      SELECT workspace_id FROM core.base_directory WHERE base_id = ${baseId} LIMIT 1
    `.execute(db);
    return row.rows[0]?.workspace_id ?? null;
  } catch {
    return null;
  }
}

export async function registerIdempotency(
  app: FastifyInstance,
  ctx: AppContext,
): Promise<void> {
  app.addHook("preHandler", async (request, reply) => {
    if (!MUTATING.has(request.method)) {
      return;
    }
    const rawKey = request.headers["idempotency-key"];
    if (typeof rawKey !== "string" || rawKey.length === 0) {
      return;
    }
    if (!request.user) {
      unauthorized(request, reply);
      return;
    }

    const workspaceId = await resolveWorkspaceId(ctx.db, request);
    if (!workspaceId) {
      return;
    }

    const path = request.url.split("?")[0] ?? request.url;
    const hash = requestHash(request.method, path, request.body);
    const expiresAt = new Date(Date.now() + TTL_HOURS * 3600 * 1000);
    const lockedUntil = new Date(Date.now() + 60_000);

    const existing = await sql<{
      status: string;
      response_status: number | null;
      response_body: Buffer | null;
      request_hash: Buffer;
      locked_until: Date;
    }>`
      SELECT status, response_status, response_body, request_hash, locked_until
      FROM data.idempotency_keys
      WHERE workspace_id = ${workspaceId}
        AND principal_id = ${request.user.id}
        AND key = ${rawKey}
      LIMIT 1
    `.execute(ctx.db);

    const row = existing.rows[0];
    if (row) {
      if (!row.request_hash.equals(hash)) {
        conflict(request, reply, "Idempotency key reused with different request body");
        return;
      }
      if (row.status === "completed" && row.response_status !== null) {
        const body = row.response_body
          ? JSON.parse(row.response_body.toString("utf8")) as unknown
          : null;
        void reply.code(row.response_status).send(body);
        return;
      }
      if (row.status === "in_progress" && row.locked_until > new Date()) {
        conflict(request, reply, "Request in progress");
        return;
      }
    } else {
      await sql`
        INSERT INTO data.idempotency_keys (
          workspace_id, principal_id, key, request_hash, method, path,
          status, locked_until, expires_at
        ) VALUES (
          ${workspaceId}, ${request.user.id}, ${rawKey}, ${hash},
          ${request.method}, ${path}, 'in_progress', ${lockedUntil}, ${expiresAt}
        )
        ON CONFLICT (workspace_id, principal_id, key) DO NOTHING
      `.execute(ctx.db);
    }

    request.idempotencyKey = rawKey;
    request.idempotencyWorkspaceId = workspaceId;
  });

  app.addHook("onSend", async (request, reply, payload) => {
    if (!request.idempotencyKey || !request.idempotencyWorkspaceId || !request.user) {
      return payload;
    }
    const path = request.url.split("?")[0] ?? request.url;
    const hash = requestHash(request.method, path, request.body);
    const bodyBuf =
      typeof payload === "string"
        ? Buffer.from(payload, "utf8")
        : Buffer.from(JSON.stringify(payload ?? null), "utf8");

    await sql`
      UPDATE data.idempotency_keys
      SET status = 'completed',
          response_status = ${reply.statusCode},
          response_body = ${bodyBuf},
          locked_until = now()
      WHERE workspace_id = ${request.idempotencyWorkspaceId}
        AND principal_id = ${request.user.id}
        AND key = ${request.idempotencyKey}
        AND request_hash = ${hash}
    `.execute(ctx.db);

    return payload;
  });
}
