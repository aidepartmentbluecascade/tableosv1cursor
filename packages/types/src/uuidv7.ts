const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type UuidV7 = string & { readonly __uuidV7: unique symbol };

export interface UuidV7Clock {
  nowMs(): number;
}

export interface UuidV7Random {
  nextBytes(n: number): Uint8Array;
}

const defaultRandom: UuidV7Random = {
  nextBytes(n: number): Uint8Array {
    const buf = new Uint8Array(n);
    crypto.getRandomValues(buf);
    return buf;
  },
};

function formatUuid(bytes: Uint8Array): UuidV7 {
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  const s = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  return s as UuidV7;
}

/** Generate a UUIDv7 string (canonical application-side PK). */
export function generateUuidV7(
  clock: UuidV7Clock = { nowMs: () => Date.now() },
  random: UuidV7Random = defaultRandom,
): UuidV7 {
  const bytes = new Uint8Array(16);
  const ts = BigInt(clock.nowMs());

  bytes[0] = Number((ts >> 40n) & 0xffn);
  bytes[1] = Number((ts >> 32n) & 0xffn);
  bytes[2] = Number((ts >> 24n) & 0xffn);
  bytes[3] = Number((ts >> 16n) & 0xffn);
  bytes[4] = Number((ts >> 8n) & 0xffn);
  bytes[5] = Number(ts & 0xffn);

  const rand = random.nextBytes(10);
  bytes[6] = 0x70 | (rand[0]! & 0x0f);
  bytes[7] = rand[1]!;
  bytes[8] = 0x80 | (rand[2]! & 0x3f);
  for (let i = 0; i < 7; i++) {
    bytes[9 + i] = rand[3 + i]!;
  }

  return formatUuid(bytes);
}

export function isUuidV7(value: string): value is UuidV7 {
  return UUID_RE.test(value);
}

export function uuidToBytes(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, "").toLowerCase();
  if (hex.length !== 32) {
    throw new Error("Invalid UUID");
  }
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function bytesToUuid(bytes: Uint8Array): UuidV7 {
  if (bytes.length !== 16) {
    throw new Error("UUID requires 16 bytes");
  }
  return formatUuid(bytes);
}
