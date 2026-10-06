import { generateUuidV7 } from "@tabula/types";
import type { Database } from "@tabula/db";
import { sql, type Transaction } from "kysely";

type DbTrx = Transaction<Database>;
import { nextOrderKey } from "../../lib/order-key.js";

export interface BootstrappedTable {
  tableId: string;
  fieldId: string;
  viewId: string;
}

/** Creates a table with primary text field "Name" and default grid view. */
export async function bootstrapDefaultTable(
  trx: DbTrx,
  params: {
    workspaceId: string;
    baseId: string;
    userId: string;
    tableName?: string;
  },
): Promise<BootstrappedTable> {
  const tableId = generateUuidV7();
  const fieldId = generateUuidV7();
  const viewId = generateUuidV7();
  const orderKey = nextOrderKey();
  const fieldOrderKey = nextOrderKey();
  const viewOrderKey = nextOrderKey();
  const tableName = params.tableName?.trim() || "Table 1";

  await sql`
    INSERT INTO data.tables (
      id, workspace_id, base_id, name, order_key, next_field_slot, created_by
    ) VALUES (
      ${tableId}, ${params.workspaceId}, ${params.baseId}, ${tableName}, ${orderKey}, 2, ${params.userId}
    )
  `.execute(trx);

  await sql`
    INSERT INTO data.fields (
      id, workspace_id, base_id, table_id, slot, name, type, order_key, created_by
    ) VALUES (
      ${fieldId}, ${params.workspaceId}, ${params.baseId}, ${tableId}, 1, 'Name', 'text', ${fieldOrderKey}, ${params.userId}
    )
  `.execute(trx);

  await sql`
    UPDATE data.tables
    SET primary_field_id = ${fieldId}, updated_at = now()
    WHERE id = ${tableId}
  `.execute(trx);

  await sql`
    INSERT INTO data.views (
      id, workspace_id, base_id, table_id, type, name, order_key, is_default, created_by,
      config
    ) VALUES (
      ${viewId}, ${params.workspaceId}, ${params.baseId}, ${tableId}, 'grid', 'Grid view',
      ${viewOrderKey}, true, ${params.userId}, ${JSON.stringify({ visibleFieldSlots: [1] })}::jsonb
    )
  `.execute(trx);

  return { tableId, fieldId, viewId };
}
