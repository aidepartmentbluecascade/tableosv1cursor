import { TabulaErrorCodes, createTabulaError } from "@tabula/types";

export function fieldValidationError(message: string, field?: string): never {
  throw createTabulaError(TabulaErrorCodes.FIELD_VALIDATION_FAILED, {
    detail: message,
    errors: field ? [{ field, message }] : [{ message }],
  });
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
