import { PublicIdError } from "../http/errors.js";
import {
  decodePublicId,
  encodePublicId,
  type PublicIdPrefix,
} from "@tabula/types";

export function pid(prefix: PublicIdPrefix, uuid: string): string {
  return encodePublicId({ prefix, uuid });
}

export function parsePid(
  value: string,
  expectedPrefix: PublicIdPrefix,
): string {
  try {
    return decodePublicId(value, expectedPrefix).uuid;
  } catch {
    // Surface malformed / wrong-prefix ids as 422 instead of an unhandled 500.
    throw new PublicIdError(`Invalid ${expectedPrefix} id: ${value}`);
  }
}
