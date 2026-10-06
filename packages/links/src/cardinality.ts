import type { CardinalitySide, CardinalityValidationResult, MergedLinkOps } from "./types.js";

/** Validate resulting link set after applying merged add/remove ops. */
export function validateCardinality(
  side: CardinalitySide,
  currentLinkedIds: readonly string[],
  merged: MergedLinkOps,
): CardinalityValidationResult {
  const set = new Set(currentLinkedIds);
  for (const id of merged.remove) {
    set.delete(id);
  }
  for (const { recordId } of merged.add) {
    set.add(recordId);
  }

  const nextIds = [...set].sort();

  if (!side.allowMultiple && nextIds.length > 1) {
    return {
      ok: false,
      nextIds,
      reason: "LINK_CARDINALITY: at most one linked record allowed",
    };
  }

  return { ok: true, nextIds };
}
