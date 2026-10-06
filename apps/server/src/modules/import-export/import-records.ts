import { generateUuidV7 } from "@tabula/types";
import type { Database } from "@tabula/db";
import { sql, type Transaction } from "kysely";
import { nextOrderKey } from "../../lib/order-key.js";
type DbTrx = Transaction<Database>;

/** Minimal record insert for import (no sidecars). */
export async function insertOneRecordFromImport(
  trx: DbTrx,
  params: {
    tableId: string;
    baseId: string;
    workspaceId: string;
    userId: string;
    cells: Record<string, unknown>;
  },
): Promise<string> {
  const recordId = generateUuidV7();

  const rowNum = await sql<{ row_number: string }>`
    UPDATE data.tables
    SET next_row_number = next_row_number + 1,
        record_count = record_count + 1,
        updated_at = now()
    WHERE id = ${params.tableId}
    RETURNING (next_row_number - 1) AS row_number
  `.execute(trx);

  const rowNumber = rowNum.rows[0]?.row_number ?? "1";
  const manualOrder = nextOrderKey();

  await sql`
    INSERT INTO data.records (
      table_id, id, workspace_id, base_id, row_number, manual_order, cells,
      created_by, created_via, last_change_seq
    ) VALUES (
      ${params.tableId}, ${recordId}, ${params.workspaceId}, ${params.baseId},
      ${rowNumber}, ${manualOrder}, ${JSON.stringify(params.cells)}::jsonb,
      ${params.userId}, 'import', 0
    )
  `.execute(trx);

  await sql`
    UPDATE data.base_runtime
    SET record_count = record_count + 1, updated_at = now()
    WHERE base_id = ${params.baseId}
  `.execute(trx);

  return recordId;
}
