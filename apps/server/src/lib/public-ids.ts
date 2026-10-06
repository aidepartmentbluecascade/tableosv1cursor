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
  return decodePublicId(value, expectedPrefix).uuid;
}
