/** In-memory pending TOTP enrollment (MVP); cleared after enable or TTL. */
const pending = new Map<string, { secret: string; expiresAt: number }>();

const TTL_MS = 10 * 60 * 1000;

export function setPendingMfaSecret(userId: string, secret: string): void {
  pending.set(userId, { secret, expiresAt: Date.now() + TTL_MS });
}

export function takePendingMfaSecret(userId: string): string | null {
  const row = pending.get(userId);
  pending.delete(userId);
  if (!row || row.expiresAt < Date.now()) {
    return null;
  }
  return row.secret;
}
