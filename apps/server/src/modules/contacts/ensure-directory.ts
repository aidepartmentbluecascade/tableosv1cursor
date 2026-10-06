import { generateUuidV7 } from "@tabula/types";
import type { TabulaDb } from "@tabula/db";
import { sql } from "kysely";
import { nextOrderKey } from "../../lib/order-key.js";

export interface ContactDirectory {
  baseId: string;
  contactsTableId: string;
}

/** Ensures one contact_directory base with a Contacts table per workspace. */
export async function ensureContactDirectory(
  db: TabulaDb,
  params: {
    workspaceId: string;
    orgId: string;
    shardId: string;
    userId: string;
  },
): Promise<ContactDirectory> {
  const existing = await sql<{ base_id: string; table_id: string }>`
    SELECT b.id AS base_id, t.id AS table_id
    FROM data.bases b
    INNER JOIN data.tables t ON t.base_id = b.id AND t.name = 'Contacts' AND t.deleted_at IS NULL
    WHERE b.workspace_id = ${params.workspaceId}
      AND b.kind = 'contact_directory'
      AND b.deleted_at IS NULL
    LIMIT 1
  `.execute(db);

  const row = existing.rows[0];
  if (row) {
    return { baseId: row.base_id, contactsTableId: row.table_id };
  }

  const baseId = generateUuidV7();
  const tableId = generateUuidV7();
  const fieldId = generateUuidV7();
  const viewId = generateUuidV7();

  await db.transaction().execute(async (trx) => {
    await sql`
      INSERT INTO data.bases (id, workspace_id, kind, name, created_by)
      VALUES (${baseId}, ${params.workspaceId}, 'contact_directory', 'Contacts', ${params.userId})
    `.execute(trx);

    await sql`
      INSERT INTO data.base_runtime (base_id, workspace_id)
      VALUES (${baseId}, ${params.workspaceId})
    `.execute(trx);

    await sql`
      INSERT INTO core.base_directory (
        base_id, workspace_id, org_id, shard_id, name, order_key, kind
      ) VALUES (
        ${baseId}, ${params.workspaceId}, ${params.orgId}, ${params.shardId},
        'Contacts', ${nextOrderKey()}, 'contact_directory'
      )
    `.execute(trx);

    await sql`
      INSERT INTO data.tables (
        id, workspace_id, base_id, name, order_key, next_field_slot, created_by
      ) VALUES (
        ${tableId}, ${params.workspaceId}, ${baseId}, 'Contacts', ${nextOrderKey()}, 3, ${params.userId}
      )
    `.execute(trx);

    await sql`
      INSERT INTO data.fields (
        id, workspace_id, base_id, table_id, slot, name, type, order_key, created_by
      ) VALUES (
        ${fieldId}, ${params.workspaceId}, ${baseId}, ${tableId}, 1, 'Name', 'text', ${nextOrderKey()}, ${params.userId}
      )
    `.execute(trx);

    await sql`
      UPDATE data.tables SET primary_field_id = ${fieldId}, updated_at = now()
      WHERE id = ${tableId}
    `.execute(trx);

    await sql`
      INSERT INTO data.views (
        id, workspace_id, base_id, table_id, type, name, order_key, is_default, created_by, config
      ) VALUES (
        ${viewId}, ${params.workspaceId}, ${baseId}, ${tableId}, 'grid', 'Grid view',
        ${nextOrderKey()}, true, ${params.userId}, ${JSON.stringify({ visibleFieldSlots: [1] })}::jsonb
      )
    `.execute(trx);
  });

  return { baseId, contactsTableId: tableId };
}
