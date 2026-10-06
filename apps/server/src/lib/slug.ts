import { randomBytes } from "node:crypto";

export function slugify(input: string): string {
  const base = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 55);
  if (base.length >= 2 && /^[a-z0-9]/.test(base)) {
    return base;
  }
  return `u-${randomBytes(4).toString("hex")}`;
}

export function uniqueSlug(base: string): string {
  const suffix = randomBytes(3).toString("hex");
  const trimmed = base.slice(0, 55);
  return `${trimmed}-${suffix}`;
}
