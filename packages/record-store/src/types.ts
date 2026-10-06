import type { CellValue } from "@tabula/fields";

export type RecordId = string;
export type FieldId = string;
export type QueryHash = string;

export interface TabulaRecord {
  id: RecordId;
  version: number;
  /** Merged cell + computed values keyed by field id. */
  fields: Record<FieldId, CellValue | null>;
}

export interface WindowPage {
  queryHash: QueryHash;
  recordIds: RecordId[];
  /** Row index of first id in this window (for virtual scroll). */
  startRow: number;
}

export interface SetCellOp {
  op: "setCell" | "setComputed";
  recordId: RecordId;
  fieldId: FieldId;
  value: CellValue | null;
}

export interface ServerChangePayload {
  seq: number;
  tableId?: string;
  kind?: string;
  ops: SetCellOp[];
}

export interface PendingMutation {
  clientMutationId: string;
  recordId: RecordId;
  fieldId: FieldId;
  value: CellValue | null;
  previousValue: CellValue | null | undefined;
  previousVersion: number;
}

export interface RecordStoreSnapshot {
  version: number;
  lastSeq: number;
  recordCount: number;
  pendingCount: number;
}

export type StoreListener = () => void;
