import { Secret, TOTP } from "otpauth";

const ISSUER = "Tabula";

export interface TotpSecretBundle {
  /** Base32 secret for manual entry */
  secret: string;
  /** otpauth:// URL for QR codes */
  otpauthUrl: string;
}

/** Generate a new TOTP secret and provisioning URI for the given account label. */
export function generateTotpSecret(accountLabel: string): TotpSecretBundle {
  const secret = new Secret().base32;
  const totp = new TOTP({
    issuer: ISSUER,
    label: accountLabel,
    secret,
    algorithm: "SHA1",
    digits: 6,
    period: 30,
  });
  return {
    secret,
    otpauthUrl: totp.toString(),
  };
}

/** Verify a 6-digit TOTP code against a base32 secret. */
export function verifyTotp(secret: string, code: string): boolean {
  const totp = new TOTP({
    secret,
    algorithm: "SHA1",
    digits: 6,
    period: 30,
  });
  const delta = totp.validate({ token: code.replace(/\s/g, ""), window: 1 });
  return delta !== null;
}
