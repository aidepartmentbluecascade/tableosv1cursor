import { createHash, randomBytes } from "node:crypto";

export interface ShareTokenParts {
  token: string;
  tokenPrefix: string;
  tokenHash: Buffer;
}

export function createShareToken(): ShareTokenParts {
  const secret = randomBytes(24).toString("base64url");
  const tokenPrefix = secret.slice(0, 12);
  const token = `shr_${tokenPrefix}.${secret}`;
  const tokenHash = createHash("sha256").update(token).digest();
  return { token, tokenPrefix, tokenHash };
}

export function parseShareToken(raw: string): { prefix: string; token: string } | null {
  const token = decodeURIComponent(raw);
  if (!token.startsWith("shr_")) return null;
  const dot = token.indexOf(".", 4);
  if (dot < 0) return null;
  const prefix = token.slice(4, dot);
  if (prefix.length < 8) return null;
  return { prefix, token };
}

export function hashShareToken(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}
