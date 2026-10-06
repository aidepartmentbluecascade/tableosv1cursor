import type { Database, TabulaDb } from "@tabula/db";
import { sql, type Transaction } from "kysely";
import type { Redis } from "ioredis";
import {
  withBaseTx,
  type MutationActor,
  type MutationResult,
} from "../../kernel/mutation.js";
import { loadTableFields, mapInputFieldsToCells } from "../schema/field-map.js";
import { afterRecordCellWrite } from "./post-write.js";
import {
  loadSidecarFields,
  loadSidecarTableMeta,
} from "../recordstore/load-meta.js";
import { upsertSidecars } from "../recordstore/sidecars.js";

type DbTrx = Transaction<Database>;

export class RecordFieldUpdateError extends Error {
  constructor(
    readonly code: "RECORD_NOT_FOUND" | "VERSION_CONFLICT" | "FIELD_NOT_FOUND",
    message?: string,
  ) {
    super(message ?? code);
    this.name = "RecordFieldUpdateError";
  }
}

export interface ApplyFieldUpdateParams {
  db: TabulaDb;
  redis: Redis | null;
  orgId: string;
  workspaceId: string;
  baseId: string;
  tableId: string;
  recordId: string;
  fieldPublicId: string;
  value: unknown;
  expectedVersion?: number;
  actor: MutationActor;
  clientMutationId?: string;
}

export interface ApplyFieldUpdateResult {
  seq: number;
  version: number;
  ops: unknown[];
}

export async function applyRecordFieldUpdate(
  params: ApplyFieldUpdateParams,
): Promise<ApplyFieldUpdateResult> {
  const fieldRows = await loadTableFields(params.db, params.tableId);
  const patchCells = mapInputFieldsToCells(fieldRows, {
    [params.fieldPublicId]: params.value,
  });
  if (Object.keys(patchCells).length === 0) {
    throw new RecordFieldUpdateError("FIELD_NOT_FOUND");
  }

  const sidecarFields = await loadSidecarFields(params.db, params.tableId);
  const sidecarTable = await loadSidecarTableMeta(
    params.db,
    params.tableId,
    params.workspaceId,
    params.baseId,
  );

  let newVersion = 0;
  let mutationOps: unknown[] = [];

  const txParams = {
    orgId: params.orgId,
    workspaceId: params.workspaceId,
    baseId: params.baseId,
    actor: params.actor,
    redis: params.redis,
    ...(params.clientMutationId !== undefined
      ? { clientMutationId: params.clientMutationId }
      : {}),
  };

  const seq = await withBaseTx(
    params.db,
    txParams,
    async (mctx, trx) => {
      const patchParams = {
        tableId: params.tableId,
        recordId: params.recordId,
        userId: params.actor.actorId ?? "",
        patchCells,
        changeSeq: mctx.changeSeq,
        baseId: params.baseId,
        workspaceId: params.workspaceId,
        fieldRows,
        sidecarFields,
        sidecarTable,
        redis: params.redis,
        ...(params.expectedVersion !== undefined
          ? { expectedVersion: params.expectedVersion }
          : {}),
      };
      const result = await patchRecordCellsInTx(trx, patchParams);
      newVersion = result.version;
      mutationOps = result.ops;
      return result.mutation;
    },
  );

  return { seq, version: newVersion, ops: mutationOps };
}

async function patchRecordCellsInTx(
  trx: DbTrx,
  params: {
    tableId: string;
    recordId: string;
    userId: string;
    patchCells: Record<string, unknown>;
    expectedVersion?: number;
    changeSeq: number;
    baseId: string;
    workspaceId: string;
    fieldRows: Awaited<ReturnType<typeof loadTableFields>>;
    sidecarFields: Awaited<ReturnType<typeof loadSidecarFields>>;
    sidecarTable: Awaited<ReturnType<typeof loadSidecarTableMeta>>;
    redis: Redis | null;
  },
): Promise<{ version: number; ops: unknown[]; mutation: MutationResult }> {
  const existing = await sql<{
    cells: unknown;
    version: string;
  }>`
    SELECT cells, version FROM data.records
    WHERE table_id = ${params.tableId} AND id = ${params.recordId} AND deleted_at IS NULL
    FOR UPDATE
  `.execute(trx);

  const row = existing.rows[0];
  if (!row) {
    throw new RecordFieldUpdateError("RECORD_NOT_FOUND");
  }

  const currentVersion = Number(row.version);
  if (
    params.expectedVersion !== undefined &&
    !Number.isNaN(params.expectedVersion) &&
    params.expectedVersion !== currentVersion
  ) {
    throw new RecordFieldUpdateError("VERSION_CONFLICT");
  }

  const merged = {
    ...(row.cells as Record<string, unknown>),
    ...params.patchCells,
  };

  await sql`
    UPDATE data.records
    SET cells = ${JSON.stringify(merged)}::jsonb,
        version = version + 1,
        updated_by = ${params.userId},
        updated_at = now(),
        last_change_seq = ${params.changeSeq}
    WHERE table_id = ${params.tableId} AND id = ${params.recordId}
  `.execute(trx);

  await upsertSidecars(
    trx,
    params.tableId,
    params.recordId,
    merged,
    params.sidecarFields,
    params.sidecarTable,
  );

  await afterRecordCellWrite(trx, {
    redis: params.redis,
    baseId: params.baseId,
    workspaceId: params.workspaceId,
    tableId: params.tableId,
    recordId: params.recordId,
    fieldRows: params.fieldRows,
    cells: merged,
    changedSlots: params.patchCells,
  });

  const newVersion = currentVersion + 1;
  const ops = [{ op: "record.updated", recordId: params.recordId, cells: merged }];

  return {
    version: newVersion,
    ops,
    mutation: {
      kind: "records",
      ops,
      inverseOps: [
        {
          op: "record.updated",
          recordId: params.recordId,
          cells: row.cells as Record<string, unknown>,
        },
      ],
      tableIds: [params.tableId],
      eventType: "record.updated",
      aggregateType: "record",
      aggregateId: params.recordId,
      payload: { version: newVersion },
    },
  };
}
