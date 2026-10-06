/** Bidirectional link relation metadata (mirrors data.link_relations). */
export interface LinkRelation {
  id: string;
  baseId: string;
  aTableId: string;
  aFieldId: string;
  bTableId: string;
  bFieldId: string | null;
  allowMultipleA: boolean;
  allowMultipleB: boolean;
}

/** One directed edge in record_links for a given side. */
export interface LinkEdge {
  relationId: string;
  fromRecordId: string;
  toRecordId: string;
  order: string;
}

export type LinkSetOp =
  | { kind: "add"; recordId: string; order?: string }
  | { kind: "remove"; recordId: string };

export interface MergedLinkOps {
  add: Array<{ recordId: string; order?: string }>;
  remove: string[];
}

export interface CardinalitySide {
  allowMultiple: boolean;
}

export interface CardinalityValidationResult {
  ok: boolean;
  nextIds: string[];
  reason?: string;
}
