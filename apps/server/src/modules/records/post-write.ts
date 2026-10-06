import type { Database } from "@tabula/db";
import type { Transaction } from "kysely";
import type { Redis } from "ioredis";
import { recomputeInTx } from "../compute/recompute-in-tx.js";
import { syncRecordLinksFromCells } from "../links/record-links.js";
import type { FieldRow } from "../schema/field-map.js";

type DbTrx = Transaction<Database>;

export function changedSlotsToFieldIds(
  fieldRows: FieldRow[],
  cellPatch: Record<string, unknown>,
): string[] {
  const ids: string[] = [];
  for (const f of fieldRows) {
    if (String(f.slot) in cellPatch) {
      ids.push(f.id);
    }
  }
  return ids;
}

export async function afterRecordCellWrite(
  trx: DbTrx,
  params: {
    redis: Redis | null;
    baseId: string;
    workspaceId: string;
    tableId: string;
    recordId: string;
    fieldRows: FieldRow[];
    cells: Record<string, unknown>;
    changedSlots: Record<string, unknown>;
  },
): Promise<void> {
  const linkFields = params.fieldRows
    .filter((f) => f.type === "link" || f.type === "contact")
    .map((f) => ({ fieldId: f.id, slot: f.slot }));

  const linkChanged = await syncRecordLinksFromCells(trx, {
    workspaceId: params.workspaceId,
    baseId: params.baseId,
    tableId: params.tableId,
    recordId: params.recordId,
    linkFields,
    cells: params.cells,
  });

  const changedFieldIds = [
    ...new Set([...changedSlotsToFieldIds(params.fieldRows, params.changedSlots), ...linkChanged]),
  ];

  if (changedFieldIds.length === 0) return;

  await recomputeInTx(
    trx,
    params.baseId,
    params.workspaceId,
    [{ tableId: params.tableId, recordId: params.recordId }],
    changedFieldIds,
    params.redis,
  );
}
