import type { Database } from "@tabula/db";
import { generateUuidV7 } from "@tabula/types";
import { sql, type Transaction } from "kysely";

type DbTrx = Transaction<Database>;

interface InverseOp {
  op: string;
  recordId?: string;
  tableId?: string;
  cells?: Record<string, unknown>;
  batchId?: string;
}

export async function applyInverseOpsInTx(
  trx: DbTrx,
  params: {
    baseId: string;
    workspaceId: string;
    userId: string;
    tableIdsHint: string[];
    inverseOps: unknown;
  },
): Promise<void> {
  if (!Array.isArray(params.inverseOps)) return;

  for (const raw of params.inverseOps as InverseOp[]) {
    switch (raw.op) {
      case "record.deleted":
      case "record.soft_deleted": {
        if (!raw.recordId) break;
        const tableId = params.tableIdsHint[0];
        if (!tableId) break;
        await sql`
          UPDATE data.records
          SET deleted_at = now(), deleted_by = ${params.userId}, updated_at = now()
          WHERE table_id = ${tableId} AND id = ${raw.recordId} AND deleted_at IS NULL
        `.execute(trx);
        break;
      }
      case "record.created": {
        if (!raw.recordId) break;
        const tableId = params.tableIdsHint[0];
        if (!tableId) break;
        await sql`
          UPDATE data.records
          SET deleted_at = now(), deleted_by = ${params.userId}, updated_at = now()
          WHERE table_id = ${tableId} AND id = ${raw.recordId} AND deleted_at IS NULL
        `.execute(trx);
        break;
      }
      case "record.updated": {
        if (!raw.recordId || !raw.cells) break;
        const tableId = params.tableIdsHint[0];
        if (!tableId) break;
        await sql`
          UPDATE data.records
          SET cells = ${JSON.stringify(raw.cells)}::jsonb,
              version = version + 1,
              updated_by = ${params.userId},
              updated_at = now()
          WHERE table_id = ${tableId} AND id = ${raw.recordId} AND deleted_at IS NULL
        `.execute(trx);
        break;
      }
      case "record.restore": {
        if (!raw.batchId) break;
        await sql`
          UPDATE data.records
          SET deleted_at = NULL, deleted_by = NULL, deletion_batch_id = NULL, updated_at = now()
          WHERE base_id = ${params.baseId} AND deletion_batch_id = ${raw.batchId}
        `.execute(trx);
        await sql`
          UPDATE data.record_links
          SET deletion_batch_id = NULL
          WHERE base_id = ${params.baseId} AND deletion_batch_id = ${raw.batchId}
        `.execute(trx);
        await sql`
          UPDATE data.deletion_batches SET restored_at = now()
          WHERE id = ${raw.batchId} AND restored_at IS NULL
        `.execute(trx);
        break;
      }
      default:
        break;
    }
  }
}

export async function createDeletionBatchInTx(
  trx: DbTrx,
  params: { workspaceId: string; baseId: string; userId: string },
): Promise<string> {
  const batchId = generateUuidV7();
  await sql`
    INSERT INTO data.deletion_batches (id, workspace_id, base_id, created_by)
    VALUES (${batchId}, ${params.workspaceId}, ${params.baseId}, ${params.userId})
  `.execute(trx);
  return batchId;
}
