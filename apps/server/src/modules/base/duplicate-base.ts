import type { Database, TabulaDb } from "@tabula/db";
import { generateUuidV7 } from "@tabula/types";
import { sql, type Transaction } from "kysely";
import { nextOrderKey } from "../../lib/order-key.js";
import { pid } from "../../lib/public-ids.js";

type DbTrx = Transaction<Database>;

const UUID_RE =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const PUBLIC_ID_RE = /(?:tbl|fld|viw)_[0-9A-Za-z]+/g;

/**
 * Copy rows of `table` belonging to the source base into the target base,
 * remapping the given uuid columns through the `_dup_map` temp table. The
 * column list is read from information_schema so newly added columns are
 * copied automatically.
 */
async function copyRows(
  trx: DbTrx,
  params: {
    table: string; // schema-qualified, e.g. data.fields
    sourceBaseId: string;
    targetBaseId: string;
    targetWorkspaceId: string;
    remap: string[];
    /** Columns whose value is forced (SQL fragments). */
    overrides?: Record<string, ReturnType<typeof sql>>;
    /** Extra WHERE fragment on alias `src`. */
    where?: ReturnType<typeof sql>;
    /** Columns that must map (row skipped when the mapping is missing). */
    requireMapped?: string[];
  },
): Promise<void> {
  const [schema, name] = params.table.split(".") as [string, string];
  const cols = await sql<{ column_name: string }>`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = ${schema} AND table_name = ${name}
    ORDER BY ordinal_position
  `.execute(trx);
  const columnNames = cols.rows.map((c) => c.column_name);
  const hasDeletedAt = columnNames.includes("deleted_at");

  const selectExprs = columnNames.map((col) => {
    const override = params.overrides?.[col];
    if (override) return override;
    if (col === "base_id") return sql`${params.targetBaseId}::uuid`;
    if (col === "workspace_id") return sql`${params.targetWorkspaceId}::uuid`;
    if (params.remap.includes(col)) {
      return sql`COALESCE((SELECT m.new_id FROM _dup_map m WHERE m.old_id = src.${sql.ref(col)}), src.${sql.ref(col)})`;
    }
    return sql`src.${sql.ref(col)}`;
  });

  const conditions = [sql`src.base_id = ${params.sourceBaseId}`];
  if (hasDeletedAt) conditions.push(sql`src.deleted_at IS NULL`);
  if (params.where) conditions.push(params.where);
  for (const col of params.requireMapped ?? []) {
    conditions.push(
      sql`EXISTS (SELECT 1 FROM _dup_map m WHERE m.old_id = src.${sql.ref(col)})`,
    );
  }

  await sql`
    INSERT INTO ${sql.table(params.table)} (${sql.join(columnNames.map((c) => sql.ref(c)))})
    SELECT ${sql.join(selectExprs)}
    FROM ${sql.table(params.table)} src
    WHERE ${sql.join(conditions, sql` AND `)}
  `.execute(trx);
}

async function addMappings(
  trx: DbTrx,
  table: string,
  sourceBaseId: string,
  extraWhere?: ReturnType<typeof sql>,
): Promise<void> {
  const [schema, name] = table.split(".") as [string, string];
  const cols = await sql<{ column_name: string }>`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = ${schema} AND table_name = ${name}
  `.execute(trx);
  const hasDeletedAt = cols.rows.some((c) => c.column_name === "deleted_at");
  const conditions = [sql`base_id = ${sourceBaseId}`];
  if (hasDeletedAt) conditions.push(sql`deleted_at IS NULL`);
  if (extraWhere) conditions.push(extraWhere);
  await sql`
    INSERT INTO _dup_map (old_id, new_id)
    SELECT id, uuidv7() FROM ${sql.table(table)}
    WHERE ${sql.join(conditions, sql` AND `)}
    ON CONFLICT (old_id) DO NOTHING
  `.execute(trx);
}

/** Rewrite every mapped uuid that appears inside a JSON column. */
async function remapJsonColumn(
  trx: DbTrx,
  table: string,
  column: string,
  targetBaseId: string,
  map: Map<string, string>,
): Promise<void> {
  const rows = await sql<{ id: string; value: unknown }>`
    SELECT id, ${sql.ref(column)} AS value FROM ${sql.table(table)}
    WHERE base_id = ${targetBaseId}
  `.execute(trx);
  for (const row of rows.rows) {
    if (row.value === null || row.value === undefined) continue;
    const text = JSON.stringify(row.value);
    let changed = false;
    const next = text
      .replace(UUID_RE, (m) => {
        const mapped = map.get(m.toLowerCase());
        if (mapped) {
          changed = true;
          return mapped;
        }
        return m;
      })
      .replace(PUBLIC_ID_RE, (m) => {
        const mapped = map.get(m);
        if (mapped) {
          changed = true;
          return mapped;
        }
        return m;
      });
    if (changed) {
      await sql`
        UPDATE ${sql.table(table)} SET ${sql.ref(column)} = ${next}::jsonb
        WHERE id = ${row.id}
      `.execute(trx);
    }
  }
}

export async function duplicateBase(
  db: TabulaDb,
  params: {
    sourceBaseId: string;
    targetWorkspaceId: string;
    orgId: string;
    shardId: string;
    userId: string;
    name: string;
    withRecords: boolean;
  },
): Promise<{ baseId: string }> {
  const newBaseId = generateUuidV7();
  const src = params.sourceBaseId;
  const ws = params.targetWorkspaceId;

  await db.transaction().execute(async (trx) => {
    await sql`
      CREATE TEMP TABLE _dup_map (old_id uuid PRIMARY KEY, new_id uuid NOT NULL)
      ON COMMIT DROP
    `.execute(trx);

    await sql`
      INSERT INTO data.bases (id, workspace_id, kind, name, description, settings, created_by)
      SELECT ${newBaseId}, ${ws}, kind, ${params.name}, description, settings, ${params.userId}
      FROM data.bases WHERE id = ${src}
    `.execute(trx);
    await sql`
      INSERT INTO data.base_runtime (base_id, workspace_id)
      VALUES (${newBaseId}, ${ws})
    `.execute(trx);
    await sql`
      INSERT INTO core.base_directory (base_id, workspace_id, org_id, shard_id, name, order_key)
      VALUES (${newBaseId}, ${ws}, ${params.orgId}, ${params.shardId}, ${params.name}, ${nextOrderKey()})
    `.execute(trx);
    await sql`
      INSERT INTO core.access_grants (
        id, org_id, resource_type, resource_id, workspace_id, base_id,
        principal_type, principal_id, role, source, granted_by
      ) VALUES (
        ${generateUuidV7()}, ${params.orgId}, 'base', ${newBaseId}, ${ws}, ${newBaseId},
        'user', ${params.userId}, 'creator', 'creator', ${params.userId}
      )
    `.execute(trx);

    for (const table of [
      "data.tables",
      "data.fields",
      "data.view_sections",
      "data.views",
      "data.link_relations",
    ]) {
      await addMappings(trx, table, src);
    }
    if (params.withRecords) {
      await sql`
        INSERT INTO _dup_map (old_id, new_id)
        SELECT r.id, uuidv7() FROM data.records r
        JOIN data.tables t ON t.id = r.table_id AND t.deleted_at IS NULL
        WHERE r.base_id = ${src} AND r.deleted_at IS NULL
        ON CONFLICT (old_id) DO NOTHING
      `.execute(trx);
    }

    await copyRows(trx, {
      table: "data.tables",
      sourceBaseId: src,
      targetBaseId: newBaseId,
      targetWorkspaceId: ws,
      remap: ["id", "primary_field_id"],
      overrides: params.withRecords
        ? {}
        : { record_count: sql`0`, next_row_number: sql`1` },
    });
    await copyRows(trx, {
      table: "data.fields",
      sourceBaseId: src,
      targetBaseId: newBaseId,
      targetWorkspaceId: ws,
      remap: ["id", "table_id"],
      requireMapped: ["table_id"],
    });
    await copyRows(trx, {
      table: "data.view_sections",
      sourceBaseId: src,
      targetBaseId: newBaseId,
      targetWorkspaceId: ws,
      remap: ["id", "table_id"],
      requireMapped: ["table_id"],
    });
    await copyRows(trx, {
      table: "data.views",
      sourceBaseId: src,
      targetBaseId: newBaseId,
      targetWorkspaceId: ws,
      remap: ["id", "table_id", "section_id"],
      requireMapped: ["table_id"],
    });
    await copyRows(trx, {
      table: "data.link_relations",
      sourceBaseId: src,
      targetBaseId: newBaseId,
      targetWorkspaceId: ws,
      remap: ["id", "a_table_id", "a_field_id", "b_table_id", "b_field_id"],
      requireMapped: ["a_table_id", "b_table_id"],
    });
    await copyRows(trx, {
      table: "data.field_dependencies",
      sourceBaseId: src,
      targetBaseId: newBaseId,
      targetWorkspaceId: ws,
      remap: ["dependent_field_id", "depends_on_field_id", "via_link_field_id"],
      requireMapped: ["dependent_field_id", "depends_on_field_id"],
    });

    if (params.withRecords) {
      await copyRows(trx, {
        table: "data.records",
        sourceBaseId: src,
        targetBaseId: newBaseId,
        targetWorkspaceId: ws,
        remap: ["id", "table_id"],
        requireMapped: ["id"],
        overrides: {
          deletion_batch_id: sql`NULL`,
          last_change_seq: sql`0`,
        },
      });
      await copyRows(trx, {
        table: "data.record_links",
        sourceBaseId: src,
        targetBaseId: newBaseId,
        targetWorkspaceId: ws,
        remap: ["relation_id", "a_record_id", "b_record_id"],
        requireMapped: ["relation_id", "a_record_id", "b_record_id"],
        where: sql`src.deletion_batch_id IS NULL`,
      });
      for (const sidecar of [
        "data.record_index_num",
        "data.record_index_text",
        "data.record_index_time",
      ]) {
        await copyRows(trx, {
          table: sidecar,
          sourceBaseId: src,
          targetBaseId: newBaseId,
          targetWorkspaceId: ws,
          remap: ["table_id", "record_id"],
          requireMapped: ["table_id", "record_id"],
        });
      }
      await sql`
        UPDATE data.base_runtime br
        SET record_count = (SELECT count(*) FROM data.records r
                            WHERE r.base_id = ${newBaseId} AND r.deleted_at IS NULL)
        WHERE br.base_id = ${newBaseId}
      `.execute(trx);
    }

    // Configs reference other tables/fields/views by uuid (link targets,
    // lookup/rollup sources, view field orders...). Rewrite them.
    const mapRows = await sql<{ old_id: string; new_id: string }>`
      SELECT old_id, new_id FROM _dup_map
      WHERE old_id IN (
        SELECT id FROM data.tables WHERE base_id = ${src}
        UNION ALL SELECT id FROM data.fields WHERE base_id = ${src}
        UNION ALL SELECT id FROM data.views WHERE base_id = ${src}
        UNION ALL SELECT id FROM data.view_sections WHERE base_id = ${src}
        UNION ALL SELECT id FROM data.link_relations WHERE base_id = ${src}
      )
    `.execute(trx);
    const map = new Map<string, string>();
    for (const r of mapRows.rows) {
      map.set(r.old_id.toLowerCase(), r.new_id);
      for (const prefix of ["tbl", "fld", "viw"] as const) {
        map.set(pid(prefix, r.old_id), pid(prefix, r.new_id));
      }
    }
    await remapJsonColumn(trx, "data.fields", "config", newBaseId, map);
    await remapJsonColumn(trx, "data.views", "config", newBaseId, map);
    await remapJsonColumn(trx, "data.tables", "settings", newBaseId, map);
  });

  return { baseId: newBaseId };
}
