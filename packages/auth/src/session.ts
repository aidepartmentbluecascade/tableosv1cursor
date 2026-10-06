import { createHash, randomBytes } from "node:crypto";

export const SESSION_COOKIE_NAME = "tabula_session" as const;

const TOKEN_BYTES = 32;

/** Opaque session token for the HttpOnly cookie (never store raw in DB). */
export function generateSessionToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

/** SHA-256 hash stored in core.sessions.token_hash (32 bytes). */
export function hashSessionToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}
