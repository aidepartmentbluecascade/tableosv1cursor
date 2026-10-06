import {
  SESSION_COOKIE_NAME,
  hashSessionToken,
} from "@tabula/auth";
import { sql } from "kysely";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { AppContext } from "../lib/app-context.js";
import { unauthorized } from "./errors.js";

export interface RequestUser {
  id: string;
  email: string;
  displayName: string;
  sessionId: string;
}

declare module "fastify" {
  interface FastifyRequest {
    user?: RequestUser;
  }
}

const PUBLIC_PREFIXES = [
  "/health",
  "/v1/openapi.json",
  "/v1/auth/signup",
  "/v1/auth/login",
  "/v1/auth/google",
  "/v1/auth/google/callback",
];

export function isPublicRoute(url: string, method?: string): boolean {
  const path = url.split("?")[0] ?? url;
  if (path.startsWith("/v1/public/")) {
    return true;
  }
  if (method === "PUT" && path.startsWith("/v1/uploads/")) {
    return true;
  }
  return PUBLIC_PREFIXES.some((p) => path === p || path.startsWith(`${p}?`));
}

export async function authHook(
  ctx: AppContext,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const path = request.url.split("?")[0] ?? request.url;
  if (isPublicRoute(path, request.method)) {
    return;
  }

  const token = request.cookies[SESSION_COOKIE_NAME];
  if (!token) {
    unauthorized(request, reply);
    return;
  }

  const tokenHash = hashSessionToken(token);
  try {
    const result = await sql<{
      session_id: string;
      user_id: string;
      email: string;
      display_name: string;
    }>`
      SELECT s.id AS session_id, u.id AS user_id, u.email, u.display_name
      FROM core.sessions s
      INNER JOIN core.users u ON u.id = s.user_id
      WHERE s.token_hash = ${tokenHash}
        AND s.revoked_at IS NULL
        AND s.expires_at > now()
        AND s.idle_expires_at > now()
        AND u.status = 'active'
      LIMIT 1
    `.execute(ctx.db);

    const row = result.rows[0];
    if (!row) {
      unauthorized(request, reply);
      return;
    }

    await sql`
      UPDATE core.sessions
      SET last_seen_at = now(),
          idle_expires_at = LEAST(expires_at, now() + interval '24 hours')
      WHERE id = ${row.session_id}
    `.execute(ctx.db);

    request.user = {
      id: row.user_id,
      email: row.email,
      displayName: row.display_name,
      sessionId: row.session_id,
    };
  } catch (err) {
    request.log.error({ err }, "auth session lookup failed");
    unauthorized(request, reply);
  }
}
