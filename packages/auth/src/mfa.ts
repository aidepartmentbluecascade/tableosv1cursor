import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * Encrypt a TOTP secret for storage (MVP: base64 ciphertext in DB).
 * Requires a 32-byte key (base64 or utf-8 padded); use `MFA_ENCRYPTION_KEY` from env.
 */
export function encryptMfaSecret(plaintextSecret: string, encryptionKey: Buffer): string {
  if (encryptionKey.length !== 32) {
    throw new Error("MFA encryption key must be 32 bytes");
  }
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintextSecret, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

/** Decrypt a stored MFA secret ciphertext (base64). */
export function decryptMfaSecret(ciphertextBase64: string, encryptionKey: Buffer): string {
  if (encryptionKey.length !== 32) {
    throw new Error("MFA encryption key must be 32 bytes");
  }
  const buf = Buffer.from(ciphertextBase64, "base64");
  const iv = buf.subarray(0, IV_BYTES);
  const tag = buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const encrypted = buf.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}

/** Derive a 32-byte key from the env string (hex or base64, else SHA-256 of utf-8). */
export function mfaKeyFromEnv(raw: string): Buffer {
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    return Buffer.from(raw, "hex");
  }
  try {
    const b = Buffer.from(raw, "base64");
    if (b.length === 32) {
      return b;
    }
  } catch {
    // fall through
  }
  return createHash("sha256").update(raw, "utf8").digest();
}
