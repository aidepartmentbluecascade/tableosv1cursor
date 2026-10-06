import { decodePublicId, encodePublicId, generateUuidV7, type PublicIdPrefix } from "@tabula/types";

/** Thrown for invalid cell values or field configs (maps to HTTP 422). */
export class FieldValidationError extends Error {
  readonly code = "FIELD_VALIDATION_FAILED";
  readonly status = 422;
  constructor(
    message: string,
    readonly field?: string,
  ) {
    super(message);
    this.name = "FieldValidationError";
  }
}

export function fieldValidationError(message: string, field?: string): never {
  throw new FieldValidationError(message, field);
}

export function isEmptyRaw(raw: unknown): boolean {
  return raw === null || raw === undefined || raw === "";
}

export function omitIfEmpty(result: { value?: unknown }): { value?: never } | { value: unknown } {
  if (result.value === undefined) {
    return {};
  }
  return { value: result.value };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(s: string): boolean {
  return UUID_RE.test(s);
}

/**
 * Accept a public id (`usr_…`) or a raw uuid; return the raw uuid.
 * Returns null when the string is neither.
 */
export function toRawId(value: string, prefix: PublicIdPrefix): string | null {
  const s = value.trim();
  if (isUuid(s)) return s.toLowerCase();
  if (s.startsWith(`${prefix}_`)) {
    try {
      return decodePublicId(s, prefix).uuid;
    } catch {
      return null;
    }
  }
  return null;
}

export function newOptionId(): string {
  return encodePublicId({ prefix: "opt", uuid: generateUuidV7() });
}

export const OPTION_COLOR_NAMES = [
  "blue",
  "cyan",
  "teal",
  "green",
  "yellow",
  "orange",
  "red",
  "pink",
  "purple",
  "gray",
] as const;

export function optionColorAt(index: number): string {
  return OPTION_COLOR_NAMES[index % OPTION_COLOR_NAMES.length]!;
}
