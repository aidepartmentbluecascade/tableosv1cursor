const BASE62 =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

function encodeBase62(n: number): string {
  if (n <= 0) return "0";
  let encoded = "";
  let v = n;
  while (v > 0) {
    encoded = BASE62[v % 62]! + encoded;
    v = Math.floor(v / 62);
  }
  return encoded;
}

/** MVP fractional order key (timestamp-based, same family as table manual_order). */
export function nextFractionalOrderKey(): string {
  return `a${encodeBase62(Date.now())}`;
}

/**
 * Pick an order key between two neighbors (lexicographic base62 strings).
 * When neighbors are missing, falls back to timestamp keys.
 */
export function fractionalOrderKeyBetween(before: string | null, after: string | null): string {
  if (before === null && after === null) {
    return nextFractionalOrderKey();
  }
  if (before === null) {
    return `${after!.slice(0, 1)}0${encodeBase62(Date.now())}`;
  }
  if (after === null) {
    return `${before}a${encodeBase62(Date.now())}`;
  }
  if (before >= after) {
    return nextFractionalOrderKey();
  }
  const prefix = before.slice(0, Math.min(before.length, after.length));
  return `${prefix}m${encodeBase62(Date.now())}`;
}
