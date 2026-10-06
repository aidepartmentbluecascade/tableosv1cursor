import { createHash } from "node:crypto";
import type { TabulaDb } from "@tabula/db";
import { sql } from "kysely";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AppContext } from "../lib/app-context.js";
import { parsePid } from "../lib/public-ids.js";
import { sendApiError, unauthorized } from "./errors.js";

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const TTL_HOURS = 24;
const LOCK_MS = 60_000;

declare module "fastify" {
  interface FastifyRequest {
    /** Set when this request owns an idempotency record (handler will run). */
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

interface KeyRow {
  status: string;
  response_status: number | null;
  response_body: Buffer | null;
  request_hash: Buffer;
  locked_until: Date;
}

export async function registerIdempotency(
  app: FastifyInstance,
  ctx: AppContext,
): Promise<void> {
  app.addHook("preHandler", async (request, reply) => {
    if (reply.sent || !MUTATING.has(request.method)) {
      return;
    }
    const rawKey = request.headers["idempotency-key"];
    if (typeof rawKey !== "string" || rawKey.length === 0) {
      return;
    }
    if (rawKey.length > 255) {
      sendApiError(request, reply, 422, "VALIDATION_FAILED", "Idempotency-Key is too long");
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

    const userId = request.user.id;
    const path = request.url.split("?")[0] ?? request.url;
    const hash = requestHash(request.method, path, request.body);
    const expiresAt = new Date(Date.now() + TTL_HOURS * 3600 * 1000);
    const lockedUntil = new Date(Date.now() + LOCK_MS);

    // Expired keys behave as if absent.
    await sql`
      DELETE FROM data.idempotency_keys
      WHERE workspace_id = ${workspaceId} AND principal_id = ${userId}
        AND key = ${rawKey} AND expires_at <= now()
    `.execute(ctx.db);

    const inserted = await sql`
      INSERT INTO data.idempotency_keys (
        workspace_id, principal_id, key, request_hash, method, path,
        status, locked_until, expires_at
      ) VALUES (
        ${workspaceId}, ${userId}, ${rawKey}, ${hash},
        ${request.method}, ${path}, 'in_progress', ${lockedUntil}, ${expiresAt}
      )
      ON CONFLICT (workspace_id, principal_id, key) DO NOTHING
    `.execute(ctx.db);

    if (Number(inserted.numAffectedRows ?? 0n) === 0) {
      // Someone (a previous attempt or a concurrent request) owns this key.
      const existing = await sql<KeyRow>`
        SELECT status, response_status, response_body, request_hash, locked_until
        FROM data.idempotency_keys
        WHERE workspace_id = ${workspaceId} AND principal_id = ${userId} AND key = ${rawKey}
        LIMIT 1
      `.execute(ctx.db);
      const row = existing.rows[0];
      if (!row) {
        sendApiError(request, reply, 409, "IDEMPOTENCY_CONFLICT", "Request in progress; retry shortly");
        return;
      }
      if (!row.request_hash.equals(hash)) {
        sendApiError(request, reply, 409, "IDEMPOTENCY_CONFLICT", "Idempotency key reused with a different request");
        return;
      }
      if (row.status === "completed" && row.response_status !== null) {
        void reply.header("idempotent-replayed", "true");
        const status = row.response_status;
        const bodyText = row.response_body ? row.response_body.toString("utf8") : "";
        if (status === 204 || bodyText.length === 0) {
          void reply.code(status).send();
          return;
        }
        let parsed: unknown = bodyText;
        try {
          parsed = JSON.parse(bodyText) as unknown;
        } catch {
          /* non-JSON body: replay as text */
        }
        if (status >= 400) {
          void reply.header("content-type", "application/problem+json");
        }
        void reply.code(status).send(parsed);
        return;
      }
      // in_progress: take over only when the previous attempt's lock expired.
      const takeover = await sql`
        UPDATE data.idempotency_keys
        SET locked_until = ${lockedUntil}
        WHERE workspace_id = ${workspaceId} AND principal_id = ${userId} AND key = ${rawKey}
          AND status = 'in_progress' AND locked_until <= now()
      `.execute(ctx.db);
      if (Number(takeover.numAffectedRows ?? 0n) === 0) {
        sendApiError(request, reply, 409, "IDEMPOTENCY_CONFLICT", "Request in progress; retry shortly");
        return;
      }
    }

    request.idempotencyKey = rawKey;
    request.idempotencyWorkspaceId = workspaceId;
  });

  app.addHook("onSend", async (request, reply, payload) => {
    if (!request.idempotencyKey || !request.idempotencyWorkspaceId || !request.user) {
      return payload;
    }
    const key = request.idempotencyKey;
    const workspaceId = request.idempotencyWorkspaceId;
    delete request.idempotencyKey;

    try {
      if (reply.statusCode >= 500) {
        // Never cache server errors: release the key so the client can retry.
        await sql`
          DELETE FROM data.idempotency_keys
          WHERE workspace_id = ${workspaceId} AND principal_id = ${request.user.id} AND key = ${key}
        `.execute(ctx.db);
        return payload;
      }

      let bodyBuf: Buffer | null;
      if (payload === null || payload === undefined || payload === "") {
        bodyBuf = null;
      } else if (typeof payload === "string") {
        bodyBuf = Buffer.from(payload, "utf8");
      } else if (Buffer.isBuffer(payload)) {
        bodyBuf = payload;
      } else {
        // Streams are not replayable; store nothing so a replay returns the status only.
        bodyBuf = null;
      }

      await sql`
        UPDATE data.idempotency_keys
        SET status = 'completed',
            response_status = ${reply.statusCode},
            response_body = ${bodyBuf},
            locked_until = now()
        WHERE workspace_id = ${workspaceId}
          AND principal_id = ${request.user.id}
          AND key = ${key}
      `.execute(ctx.db);
    } catch (err) {
      request.log.error({ err }, "idempotency record update failed");
    }

    return payload;
  });
}
