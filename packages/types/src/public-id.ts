import { bytesToUuid, isUuidV7, uuidToBytes, type UuidV7 } from "./uuidv7.js";

/** Public ID prefixes from architecture spine §3. */
export const PUBLIC_ID_PREFIXES = [
  "org",
  "wsp",
  "usr",
  "bas",
  "tbl",
  "fld",
  "rec",
  "viw",
  "tok",
  "evt",
  "chg",
  "opt",
  "vsc",
  "shr",
  "ctc",
  "itf",
  "pag",
  "elm",
  "tem",
  "aut",
  "atv",
  "run",
  "stp",
  "att",
  "cmt",
  "ntf",
  "ihk",
  "con",
  "sct",
  "svc",
  "app",
  "imp",
  "exp",
  "lop",
  "snp",
  "rev",
  "inv",
  "aij",
  "tpl",
  "whk",
] as const;

export type PublicIdPrefix = (typeof PUBLIC_ID_PREFIXES)[number];

const BASE62 =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

const PREFIX_SET = new Set<string>(PUBLIC_ID_PREFIXES);

export type PublicId = `${PublicIdPrefix}_${string}`;

export interface EncodePublicIdOptions {
  prefix: PublicIdPrefix;
  uuid: UuidV7 | string;
}

export interface DecodedPublicId {
  prefix: PublicIdPrefix;
  uuid: UuidV7;
}

function encodeBase62Fixed(bytes: Uint8Array, length: number): string {
  let value = 0n;
  for (const b of bytes) {
    value = (value << 8n) | BigInt(b);
  }
  if (value === 0n) {
    return BASE62[0]!.repeat(length);
  }
  let encoded = "";
  while (value > 0n) {
    const rem = Number(value % 62n);
    encoded = BASE62[rem]! + encoded;
    value /= 62n;
  }
  if (encoded.length > length) {
    throw new Error("Base62 overflow");
  }
  return encoded.padStart(length, "0");
}

function decodeBase62Fixed(encoded: string): Uint8Array {
  let value = 0n;
  for (const ch of encoded) {
    const idx = BASE62.indexOf(ch);
    if (idx < 0) {
      throw new Error("Invalid base62 character");
    }
    value = value * 62n + BigInt(idx);
  }
  const out = new Uint8Array(16);
  for (let i = 15; i >= 0; i--) {
    out[i] = Number(value & 0xffn);
    value >>= 8n;
  }
  return out;
}

/** Encode UUID bytes as `<prefix>_<22 base62 chars>`. */
export function encodePublicId({ prefix, uuid }: EncodePublicIdOptions): PublicId {
  if (!isUuidV7(uuid)) {
    throw new Error("encodePublicId requires a UUIDv7");
  }
  const payload = encodeBase62Fixed(uuidToBytes(uuid), 22);
  return `${prefix}_${payload}` as PublicId;
}

/** Decode a public ID; validates prefix and UUIDv7 layout. */
export function decodePublicId(
  publicId: string,
  expectedPrefix?: PublicIdPrefix,
): DecodedPublicId {
  const sep = publicId.indexOf("_");
  if (sep <= 0) {
    throw new Error("Invalid public id format");
  }
  const prefix = publicId.slice(0, sep);
  const payload = publicId.slice(sep + 1);
  if (!PREFIX_SET.has(prefix)) {
    throw new Error(`Unknown public id prefix: ${prefix}`);
  }
  if (expectedPrefix !== undefined && prefix !== expectedPrefix) {
    throw new Error(`Expected prefix ${expectedPrefix}, got ${prefix}`);
  }
  if (payload.length !== 22) {
    throw new Error("Public id payload must be 22 base62 characters");
  }
  const uuid = bytesToUuid(decodeBase62Fixed(payload));
  if (!isUuidV7(uuid)) {
    throw new Error("Decoded id is not UUIDv7");
  }
  return { prefix: prefix as PublicIdPrefix, uuid };
}
