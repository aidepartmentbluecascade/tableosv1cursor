/**
 * Fractional order keys (base62, compared bytewise / `COLLATE "C"`).
 *
 * Format follows the well-known "fractional-indexing" scheme: a key is an
 * integer part (head char + N digits, where the head encodes N) followed by
 * an optional fraction that never ends in '0'. This keeps keys short when
 * appending/prepending repeatedly (integer part increments) while still
 * allowing arbitrary insertion between neighbours (fraction midpoint).
 *
 * Legacy keys (e.g. `"a" + base62(timestamp)`) are tolerated: when a bound is
 * not a valid key in this format, a plain lexicographic midpoint is used.
 */

export const ORDER_KEY_DIGITS =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

const ZERO = ORDER_KEY_DIGITS[0]!;
const SMALLEST_INTEGER = "A" + ZERO.repeat(26);

function digitIndex(ch: string): number {
  const i = ORDER_KEY_DIGITS.indexOf(ch);
  if (i < 0) throw new RangeError(`invalid order key digit: ${ch}`);
  return i;
}

/**
 * Midpoint between two fractions `a` < `b` (digit strings read as 0.xxx).
 * `b === null` means 1.0. Neither may end in '0'. Result never ends in '0'.
 */
function midpoint(a: string, b: string | null): string {
  if (b !== null && a >= b) throw new RangeError(`order key midpoint: ${a} >= ${b}`);
  if (a.endsWith(ZERO) || (b !== null && b.endsWith(ZERO))) {
    throw new RangeError("order key midpoint: trailing zero");
  }
  if (b !== null) {
    // Shared prefix (padding a with zeros).
    let n = 0;
    while ((a[n] ?? ZERO) === b[n]) n++;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }
  const dA = a.length > 0 ? digitIndex(a[0]!) : 0;
  const dB = b !== null ? digitIndex(b[0]!) : ORDER_KEY_DIGITS.length;
  if (dB - dA > 1) {
    return ORDER_KEY_DIGITS[Math.round((dA + dB) / 2)]!;
  }
  // Adjacent digits.
  if (b !== null && b.length > 1) return b.slice(0, 1);
  return ORDER_KEY_DIGITS[dA]! + midpoint(a.slice(1), null);
}

function integerLength(head: string): number {
  if (head >= "a" && head <= "z") return head.charCodeAt(0) - "a".charCodeAt(0) + 2;
  if (head >= "A" && head <= "Z") return "Z".charCodeAt(0) - head.charCodeAt(0) + 2;
  throw new RangeError(`invalid order key head: ${head}`);
}

function integerPart(key: string): string {
  const len = integerLength(key[0]!);
  if (len > key.length) throw new RangeError(`invalid order key: ${key}`);
  return key.slice(0, len);
}

function isValidKey(key: string): boolean {
  if (key.length === 0) return false;
  for (const ch of key) if (ORDER_KEY_DIGITS.indexOf(ch) < 0) return false;
  try {
    if (key === SMALLEST_INTEGER) return false;
    const i = integerPart(key);
    const f = key.slice(i.length);
    return !f.endsWith(ZERO);
  } catch {
    return false;
  }
}

function incrementInteger(x: string): string | null {
  const [head, ...digs] = x.split("");
  let carry = true;
  for (let i = digs.length - 1; carry && i >= 0; i--) {
    const d = digitIndex(digs[i]!) + 1;
    if (d === ORDER_KEY_DIGITS.length) {
      digs[i] = ZERO;
    } else {
      digs[i] = ORDER_KEY_DIGITS[d]!;
      carry = false;
    }
  }
  if (carry) {
    if (head === "Z") return "a" + ZERO;
    if (head === "z") return null;
    const h = String.fromCharCode(head!.charCodeAt(0) + 1);
    if (h > "a") digs.push(ZERO);
    else digs.pop();
    return h + digs.join("");
  }
  return head + digs.join("");
}

function decrementInteger(x: string): string | null {
  const [head, ...digs] = x.split("");
  let borrow = true;
  for (let i = digs.length - 1; borrow && i >= 0; i--) {
    const d = digitIndex(digs[i]!) - 1;
    if (d === -1) {
      digs[i] = ORDER_KEY_DIGITS[ORDER_KEY_DIGITS.length - 1]!;
    } else {
      digs[i] = ORDER_KEY_DIGITS[d]!;
      borrow = false;
    }
  }
  if (borrow) {
    if (head === "a") return "Z" + ORDER_KEY_DIGITS[ORDER_KEY_DIGITS.length - 1]!;
    if (head === "A") return null;
    const h = String.fromCharCode(head!.charCodeAt(0) - 1);
    if (h < "Z") digs.push(ORDER_KEY_DIGITS[ORDER_KEY_DIGITS.length - 1]!);
    else digs.pop();
    return h + digs.join("");
  }
  return head + digs.join("");
}

/** Integer keys are skipped when they end in '0' so generated keys never do. */
function incIntNoZero(x: string): string | null {
  let i: string | null = incrementInteger(x);
  while (i !== null && i.endsWith(ZERO)) i = incrementInteger(i);
  return i;
}

function decIntNoZero(x: string): string | null {
  let i: string | null = decrementInteger(x);
  while (i !== null && i.endsWith(ZERO)) i = decrementInteger(i);
  return i;
}

function stripTrailingZeros(s: string): string {
  let end = s.length;
  while (end > 0 && s[end - 1] === ZERO) end--;
  return s.slice(0, end);
}

/** Lexicographic fallback for legacy / non-conforming keys. */
function looseBetween(a: string | null, b: string | null): string {
  const lo = a === null ? "" : stripTrailingZeros(a);
  const hi = b === null ? null : stripTrailingZeros(b);
  if (hi !== null && hi.length === 0) {
    throw new RangeError(`no order key exists below ${JSON.stringify(b)}`);
  }
  if (hi !== null && lo >= hi) {
    throw new RangeError(`no order key exists between ${JSON.stringify(a)} and ${JSON.stringify(b)}`);
  }
  return midpoint(lo, hi);
}

/**
 * Return a key strictly between `a` and `b` (bytewise). `null` means
 * "no bound" on that side. Throws `RangeError` when `a >= b`.
 * Generated keys never end in '0'.
 */
export function keyBetween(a: string | null, b: string | null): string {
  if (a !== null && b !== null && a >= b) {
    throw new RangeError(`keyBetween: ${JSON.stringify(a)} >= ${JSON.stringify(b)}`);
  }
  const aOk = a === null || isValidKey(a);
  const bOk = b === null || isValidKey(b);
  if (!aOk || !bOk) return looseBetween(a, b);

  if (a === null) {
    if (b === null) return "a1";
    const ib = integerPart(b);
    const fb = b.slice(ib.length);
    if (ib === SMALLEST_INTEGER) return ib + midpoint("", fb);
    if (ib < b) return ib.endsWith(ZERO) ? ib + midpoint("", fb) : ib;
    const res = decIntNoZero(ib);
    if (res === null) return ib + midpoint("", fb);
    return res;
  }
  if (b === null) {
    const ia = integerPart(a);
    const fa = a.slice(ia.length);
    const i = incIntNoZero(ia);
    return i === null ? ia + midpoint(fa, null) : i;
  }
  const ia = integerPart(a);
  const fa = a.slice(ia.length);
  const ib = integerPart(b);
  const fb = b.slice(ib.length);
  if (ia === ib) return ia + midpoint(fa, fb);
  const i = incIntNoZero(ia);
  if (i !== null && i < b) return i;
  return ia + midpoint(fa, null);
}

/** `n` keys strictly between `a` and `b`, ascending. */
export function keysBetween(a: string | null, b: string | null, n: number): string[] {
  if (n <= 0) return [];
  if (n === 1) return [keyBetween(a, b)];
  if (b === null) {
    const out: string[] = [];
    let prev = a;
    for (let i = 0; i < n; i++) {
      prev = keyBetween(prev, null);
      out.push(prev);
    }
    return out;
  }
  if (a === null) {
    const out: string[] = [];
    let next = b;
    for (let i = 0; i < n; i++) {
      next = keyBetween(null, next);
      out.push(next);
    }
    return out.reverse();
  }
  const mid = Math.floor(n / 2);
  const c = keyBetween(a, b);
  return [...keysBetween(a, c, mid), c, ...keysBetween(c, b, n - mid - 1)];
}
