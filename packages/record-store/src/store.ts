import type { CellValue } from "@tabula/fields";
import { getMergedFieldValue, upsertRecordFromDto } from "./merge.js";
import type {
  PendingMutation,
  QueryHash,
  TabulaRecord,
  RecordId,
  RecordStoreSnapshot,
  ServerChangePayload,
  StoreListener,
  WindowPage,
} from "./types.js";

export class RecordStore {
  private readonly records = new Map<RecordId, TabulaRecord>();
  private readonly windows = new Map<QueryHash, WindowPage>();
  private readonly pending = new Map<string, PendingMutation>();
  private listeners = new Set<StoreListener>();
  private snapshotVersion = 0;
  private lastSeq = 0;
  private snapshot: RecordStoreSnapshot = this.buildSnapshot();

  subscribe(listener: StoreListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getSnapshot(): RecordStoreSnapshot {
    return this.snapshot;
  }

  getRecord(id: RecordId): TabulaRecord | undefined {
    return this.records.get(id);
  }

  getWindow(queryHash: QueryHash): WindowPage | undefined {
    return this.windows.get(queryHash);
  }

  getRecordIdsForWindow(queryHash: QueryHash): RecordId[] {
    return this.windows.get(queryHash)?.recordIds ?? [];
  }

  getFieldValue(recordId: RecordId, fieldId: string): CellValue | null {
    const rec = this.records.get(recordId);
    if (!rec) return null;
    return getMergedFieldValue(rec, fieldId);
  }

  setWindow(page: WindowPage): void {
    this.windows.set(page.queryHash, page);
    this.bump();
  }

  ingestQueryPage(
    queryHash: QueryHash,
    startRow: number,
    dtos: Array<{
      id: RecordId;
      version: number;
      fields: Record<string, CellValue | null | undefined>;
    }>,
  ): void {
    for (const dto of dtos) {
      upsertRecordFromDto(this.records, dto);
    }
    this.windows.set(queryHash, {
      queryHash,
      startRow,
      recordIds: dtos.map((d) => d.id),
    });
    this.bump();
  }

  applyServerOp(change: ServerChangePayload): void {
    if (change.seq > this.lastSeq) {
      this.lastSeq = change.seq;
    }
    for (const op of change.ops) {
      if (op.op !== "setCell" && op.op !== "setComputed") continue;
      let rec = this.records.get(op.recordId);
      if (!rec) {
        rec = {
          id: op.recordId,
          version: 0,
          fields: {},
        };
        this.records.set(op.recordId, rec);
      }
      rec.fields[op.fieldId] = op.value;
    }
    this.rebase();
  }

  applyOptimistic(mutation: Omit<PendingMutation, "previousValue" | "previousVersion">): void {
    const rec = this.records.get(mutation.recordId);
    const previousValue = rec ? getMergedFieldValue(rec, mutation.fieldId) : null;
    const previousVersion = rec?.version ?? 0;
    this.pending.set(mutation.clientMutationId, {
      ...mutation,
      previousValue,
      previousVersion,
    });
    if (rec) {
      rec.fields[mutation.fieldId] = mutation.value;
    } else {
      this.records.set(mutation.recordId, {
        id: mutation.recordId,
        version: previousVersion,
        fields: { [mutation.fieldId]: mutation.value },
      });
    }
    this.bump();
  }

  ack(clientMutationId: string, patch?: { recordId: RecordId; version: number }): void {
    const pending = this.pending.get(clientMutationId);
    if (pending && patch && patch.recordId === pending.recordId) {
      const rec = this.records.get(patch.recordId);
      if (rec) rec.version = patch.version;
    }
    this.pending.delete(clientMutationId);
    this.bump();
  }

  reject(clientMutationId: string): void {
    const pending = this.pending.get(clientMutationId);
    if (pending) {
      const rec = this.records.get(pending.recordId);
      if (rec) {
        if (pending.previousValue === undefined) {
          delete rec.fields[pending.fieldId];
        } else {
          rec.fields[pending.fieldId] = pending.previousValue;
        }
        rec.version = pending.previousVersion;
      }
      this.pending.delete(clientMutationId);
    }
    this.bump();
  }

  rebase(): void {
    for (const mutation of this.pending.values()) {
      let rec = this.records.get(mutation.recordId);
      if (!rec) {
        rec = {
          id: mutation.recordId,
          version: mutation.previousVersion,
          fields: {},
        };
        this.records.set(mutation.recordId, rec);
      }
      rec.fields[mutation.fieldId] = mutation.value;
    }
    this.bump();
  }

  setLastSeq(seq: number): void {
    if (seq > this.lastSeq) this.lastSeq = seq;
    this.bump();
  }

  private buildSnapshot(): RecordStoreSnapshot {
    return {
      version: this.snapshotVersion,
      lastSeq: this.lastSeq,
      recordCount: this.records.size,
      pendingCount: this.pending.size,
    };
  }

  private bump(): void {
    this.snapshotVersion += 1;
    this.snapshot = this.buildSnapshot();
    for (const listener of this.listeners) {
      listener();
    }
  }
}
