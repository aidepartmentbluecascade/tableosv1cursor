import {
  SESSION_COOKIE_NAME,
  generateSessionToken,
  hashSessionToken,
} from "@tabula/auth";
import { generateUuidV7 } from "@tabula/types";
import { sql } from "kysely";
import type { FastifyReply } from "fastify";
import type { TabulaDb } from "@tabula/db";
import type { Env } from "@tabula/config";

const SESSION_TTL_DAYS = 7;
const IDLE_HOURS = 24;

export async function createSession(
  db: TabulaDb,
  userId: string,
  reply: FastifyReply,
  env: Env,
): Promise<string> {
  const token = generateSessionToken();
  const tokenHash = hashSessionToken(token);
  const sessionId = generateUuidV7();

  await sql`
    INSERT INTO core.sessions (
      id, user_id, token_hash, auth_method, idle_expires_at, expires_at
    ) VALUES (
      ${sessionId},
      ${userId},
      ${tokenHash},
      'password',
      now() + interval '24 hours',
      now() + interval '7 days'
    )
  `.execute(db);

  const secure = env.NODE_ENV === "production";
  reply.setCookie(SESSION_COOKIE_NAME, token, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure,
    maxAge: SESSION_TTL_DAYS * 24 * 60 * 60,
  });

  return sessionId;
}

export async function revokeSession(
  db: TabulaDb,
  sessionId: string,
): Promise<void> {
  await sql`
    UPDATE core.sessions SET revoked_at = now() WHERE id = ${sessionId}
  `.execute(db);
}

export function clearSessionCookie(reply: FastifyReply, env: Env): void {
  const secure = env.NODE_ENV === "production";
  reply.clearCookie(SESSION_COOKIE_NAME, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure,
  });
}
