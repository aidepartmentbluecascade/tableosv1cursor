import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { keyBetween, keysBetween } from "./order-key.js";

function check(a: string | null, b: string | null): string {
  const k = keyBetween(a, b);
  if (a !== null) assert.ok(a < k, `${a} < ${k}`);
  if (b !== null) assert.ok(k < b, `${k} < ${b}`);
  assert.ok(!k.endsWith("0"), `no trailing zero: ${k}`);
  return k;
}

describe("keyBetween", () => {
  it("handles null ends", () => {
    assert.equal(keyBetween(null, null), "a1");
    assert.equal(keyBetween("a1", null), "a2");
    assert.equal(keyBetween(null, "a1"), "Zz");
    assert.equal(keyBetween("a1", "a2"), "a1V");
    assert.equal(keyBetween("a1V", "a2"), "a1l");
    assert.equal(keyBetween("az", null), "b01");
    assert.equal(keyBetween("Zz", "a1"), "ZzV");
    assert.equal(keyBetween("a1", "a1V"), "a1G");
  });

  it("throws when a >= b", () => {
    assert.throws(() => keyBetween("a1", "a1"), RangeError);
    assert.throws(() => keyBetween("a2", "a1"), RangeError);
  });

  it("repeated append stays short", () => {
    let k: string | null = null;
    for (let i = 0; i < 10_000; i++) k = check(k, null);
    assert.ok(k!.length <= 5, k!);
  });

  it("repeated prepend stays short", () => {
    let k: string | null = null;
    for (let i = 0; i < 10_000; i++) k = check(null, k);
    assert.ok(k!.length <= 5, k!);
  });

  it("repeated insertion between converges correctly", () => {
    let lo = "a1";
    const hi = "a2";
    for (let i = 0; i < 200; i++) lo = check(lo, hi);
    let h2 = "a2";
    for (let i = 0; i < 200; i++) h2 = check("a1", h2);
  });

  it("random insertions keep order", () => {
    const keys: string[] = [keyBetween(null, null)];
    let seed = 42;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let i = 0; i < 2000; i++) {
      const pos = Math.floor(rnd() * (keys.length + 1));
      const a = pos === 0 ? null : keys[pos - 1]!;
      const b = pos === keys.length ? null : keys[pos]!;
      keys.splice(pos, 0, check(a, b));
    }
    const sorted = [...keys].sort();
    assert.deepEqual(keys, sorted);
    assert.equal(new Set(keys).size, keys.length);
  });

  it("tolerates legacy timestamp keys (a + base62 ms)", () => {
    const legacy = ["aVq3Kx1z", "aVq3Kx20", "aVq3Kx2A"]; // middle one ends in '0'
    check(null, legacy[0]!);
    check(legacy[0]!, legacy[1]!);
    check(legacy[1]!, legacy[2]!);
    check(legacy[2]!, null);
    check("a1", "a1V");
    check("a", "b");
    check("a", null);
  });

  it("keysBetween returns n ascending keys", () => {
    const ks = keysBetween("a1", "a2", 10);
    assert.equal(ks.length, 10);
    let prev = "a1";
    for (const k of ks) {
      assert.ok(prev < k);
      prev = k;
    }
    assert.ok(prev < "a2");
    const tail = keysBetween("a5", null, 3);
    assert.deepEqual(tail, ["a6", "a7", "a8"]);
    const head = keysBetween(null, "a5", 3);
    assert.deepEqual(head, ["a2", "a3", "a4"]);
  });
});
