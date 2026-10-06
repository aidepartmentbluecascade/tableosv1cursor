const BASE62 =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** MVP fractional order key: prefix `a` + base62 timestamp ms. */
export function nextOrderKey(): string {
  let n = Date.now();
  if (n === 0) {
    return "a0";
  }
  let encoded = "";
  while (n > 0) {
    encoded = BASE62[n % 62]! + encoded;
    n = Math.floor(n / 62);
  }
  return `a${encoded || "0"}`;
}

/** Simple successor for table/view ordering within a base. */
export function bumpOrderKey(prev: string): string {
  return nextOrderKey();
}
