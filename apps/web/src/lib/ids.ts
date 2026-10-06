import { decodePublicId, type PublicIdPrefix } from "@tabula/types";

export function assertPublicId(value: string, prefix?: PublicIdPrefix): void {
  decodePublicId(value, prefix);
}

export function isPublicId(value: string, prefix?: PublicIdPrefix): boolean {
  try {
    decodePublicId(value, prefix);
    return true;
  } catch {
    return false;
  }
}
