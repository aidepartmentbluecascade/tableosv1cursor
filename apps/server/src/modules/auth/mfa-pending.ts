import { decryptMfaSecret, encryptMfaSecret, mfaKeyFromEnv } from "@tabula/auth";
import type { Env } from "@tabula/config";
import type { TabulaDb } from "@tabula/db";
import { sql } from "kysely";
import { createChallenge, findUserChallenge, consumeChallenge } from "./challenges.js";

/**
 * Pending TOTP enrollment, persisted (encrypted) in core.auth_challenges so it
 * survives API restarts and works across processes. Cleared on enable / TTL.
 */
const TTL_MS = 10 * 60 * 1000;

export function mfaKey(env: Env): Buffer {
  return mfaKeyFromEnv(env.MFA_ENCRYPTION_KEY ?? env.SESSION_SECRET);
}

export async function setPendingMfaSecret(
  db: TabulaDb,
  env: Env,
  userId: string,
  secret: string,
): Promise<void> {
  await createChallenge(db, "mfa_enroll", {
    userId,
    data: { secret: encryptMfaSecret(secret, mfaKey(env)) },
    ttlMs: TTL_MS,
  });
}

/** Return the pending secret (does not consume it; call `clearPendingMfaSecret`). */
export async function getPendingMfaSecret(
  db: TabulaDb,
  env: Env,
  userId: string,
): Promise<{ id: string; secret: string } | null> {
  const row = await findUserChallenge(db, "mfa_enroll", userId);
  const enc = row?.data["secret"];
  if (!row || typeof enc !== "string") return null;
  try {
    return { id: row.id, secret: decryptMfaSecret(enc, mfaKey(env)) };
  } catch {
    return null;
  }
}

export async function clearPendingMfaSecret(db: TabulaDb, id: string): Promise<void> {
  await consumeChallenge(db, id);
}

/** Confirmed TOTP secret for a user, or null when MFA is not enabled. */
export async function getConfirmedMfaSecret(
  db: TabulaDb,
  env: Env,
  userId: string,
): Promise<string | null> {
  const res = await sql<{ secret_ciphertext: string }>`
    SELECT secret_ciphertext FROM core.user_mfa_factors
    WHERE user_id = ${userId} AND kind = 'totp' AND confirmed_at IS NOT NULL
    ORDER BY confirmed_at DESC
    LIMIT 1
  `.execute(db);
  const row = res.rows[0];
  if (!row) return null;
  try {
    return decryptMfaSecret(row.secret_ciphertext, mfaKey(env));
  } catch {
    return null;
  }
}

export async function userHasMfa(db: TabulaDb, userId: string): Promise<boolean> {
  const res = await sql<{ n: number }>`
    SELECT 1 AS n FROM core.user_mfa_factors
    WHERE user_id = ${userId} AND confirmed_at IS NOT NULL
    LIMIT 1
  `.execute(db);
  return res.rows.length > 0;
}
