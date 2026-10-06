import type { FilterAst } from "@tabula/filter";
import type { CompiledFilterSql } from "@tabula/filter";

export type SortDirection = "asc" | "desc";

export interface SortSpec {
  /** Public field id or `manualOrder` for table manual order. */
  fieldId: string;
  direction: SortDirection;
}

export interface RecordQueryInput {
  filter?: FilterAst | unknown | undefined;
  sort?: SortSpec[] | undefined;
  pageSize: number;
  cursor?: string | null | undefined;
}

export interface SortPlanEntry {
  fieldId: string;
  slot?: number | undefined;
  direction: SortDirection;
  source: "manual_order" | "cells" | "sidecar";
  sidecarKind?: "text" | "num" | "time" | undefined;
}

export interface RecordQueryPlan {
  pageSize: number;
  limit: number;
  sort: SortPlanEntry[];
  filter?: CompiledFilterSql | undefined;
  cursor?: ManualOrderCursor | FieldSortCursor | undefined;
}

export interface ManualOrderCursor {
  kind: "manualOrder";
  manualOrder: string;
  id: string;
}

export interface FieldSortCursor {
  kind: "fieldSort";
  fieldId: string;
  slot: number;
  direction: SortDirection;
  sortKey: string | number;
  id: string;
}
