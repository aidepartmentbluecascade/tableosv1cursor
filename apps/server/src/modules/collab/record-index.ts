import type { TabulaDb } from "@tabula/db";
import type { SearchBackend } from "@tabula/search";
import { sql } from "kysely";

function cellsToSearchText(cells: unknown): string {
  if (!cells || typeof cells !== "object") return "";
  const parts: string[] = [];
  for (const value of Object.values(cells as Record<string, unknown>)) {
    if (value === null || value === undefined) continue;
    if (typeof value === "string") parts.push(value);
    else if (typeof value === "number" || typeof value === "boolean") {
      parts.push(String(value));
    } else if (typeof value === "object") {
      parts.push(JSON.stringify(value));
    }
  }
  return parts.join(" ");
}

export async function indexRecordDocument(
  db: TabulaDb,
  search: SearchBackend,
  params: {
    workspaceId: string;
    baseId: string;
    tableId: string;
    recordId: string;
  },
): Promise<void> {
  const row = await sql<{ cells: unknown; row_number: string }>`
    SELECT cells, row_number::text
    FROM data.records
    WHERE id = ${params.recordId}
      AND table_id = ${params.tableId}
      AND deleted_at IS NULL
    LIMIT 1
  `.execute(db);

  const rec = row.rows[0];
  if (!rec) {
    await search.remove(params.baseId, "record", params.recordId);
    return;
  }

  const body = cellsToSearchText(rec.cells);
  await search.upsert({
    workspaceId: params.workspaceId,
    baseId: params.baseId,
    docType: "record",
    refId: params.recordId,
    title: `Record ${rec.row_number}`,
    body,
  });
}
