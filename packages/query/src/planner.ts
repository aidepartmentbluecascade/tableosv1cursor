import { compileFilterToSql, type CompileFilterOptions } from "@tabula/filter";
import {
  decodeLegacyCursor,
  decodeRecordCursor,
  type RecordCursor,
} from "./cursor.js";
import type {
  RecordQueryInput,
  RecordQueryPlan,
  SortPlanEntry,
  SortSpec,
} from "./types.js";

export interface PlanQueryContext extends CompileFilterOptions {
  fieldSlotById: Map<string, number>;
}

const MANUAL_ORDER_FIELD = "manualOrder";

function resolveSort(
  sort: SortSpec[] | undefined,
  ctx: PlanQueryContext,
): SortPlanEntry[] {
  if (!sort || sort.length === 0) {
    return [{ fieldId: MANUAL_ORDER_FIELD, direction: "asc", source: "manual_order" }];
  }
  return sort.map((s) => {
    if (s.fieldId === MANUAL_ORDER_FIELD) {
      return {
        fieldId: MANUAL_ORDER_FIELD,
        direction: s.direction,
        source: "manual_order" as const,
      };
    }
    const slot = ctx.fieldSlotById.get(s.fieldId);
    const sidecarReady =
      slot !== undefined && ctx.sidecarReadySlots?.has(slot) && ctx.useSidecars;
    const fieldType = ctx.fieldTypeByFieldId?.get(s.fieldId);
    let sidecarKind: "text" | "num" | "time" | undefined;
    if (fieldType) {
      if (
        fieldType === "dateTime" ||
        fieldType === "createdTime" ||
        fieldType === "lastModifiedTime"
      ) {
        sidecarKind = "time";
      } else if (
        fieldType === "number" ||
        fieldType === "currency" ||
        fieldType === "date"
      ) {
        sidecarKind = "num";
      } else {
        sidecarKind = "text";
      }
    }
    const entry: SortPlanEntry = {
      fieldId: s.fieldId,
      direction: s.direction,
      source: sidecarReady ? "sidecar" : "cells",
    };
    if (slot !== undefined) entry.slot = slot;
    if (sidecarKind !== undefined) entry.sidecarKind = sidecarKind;
    return entry;
  });
}

function decodeCursor(input: string | null | undefined): RecordCursor | undefined {
  if (!input) return undefined;
  try {
    return decodeRecordCursor(input);
  } catch {
    const legacy = decodeLegacyCursor(input);
    if (legacy) return legacy;
    throw new Error("INVALID_CURSOR");
  }
}

export function planRecordQuery(
  input: RecordQueryInput,
  ctx: PlanQueryContext,
): RecordQueryPlan {
  const pageSize = Math.min(Math.max(input.pageSize, 1), 500);
  const sort = resolveSort(input.sort, ctx);
  const filter = input.filter
    ? compileFilterToSql(input.filter, ctx.fieldSlotById, ctx)
    : undefined;
  const cursor = decodeCursor(input.cursor);

  const plan: RecordQueryPlan = {
    pageSize,
    limit: pageSize + 1,
    sort,
  };
  if (filter) plan.filter = filter;
  if (cursor) plan.cursor = cursor;
  return plan;
}
