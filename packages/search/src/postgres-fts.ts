import type { TabulaDb } from "@tabula/db";
import { sql } from "kysely";
import type { SearchBackend, SearchDocument, SearchHit } from "./backend.js";

export class PostgresFtsBackend implements SearchBackend {
  constructor(private readonly db: TabulaDb) {}

  async upsert(doc: SearchDocument): Promise<void> {
    await sql`
      INSERT INTO data.search_documents (
        workspace_id, base_id, doc_type, ref_id, title, body, updated_at
      ) VALUES (
        ${doc.workspaceId},
        ${doc.baseId},
        ${doc.docType},
        ${doc.refId},
        ${doc.title},
        ${doc.body},
        now()
      )
      ON CONFLICT (base_id, doc_type, ref_id)
      DO UPDATE SET
        title = EXCLUDED.title,
        body = EXCLUDED.body,
        updated_at = now()
    `.execute(this.db);
  }

  async remove(baseId: string, docType: string, refId: string): Promise<void> {
    await sql`
      DELETE FROM data.search_documents
      WHERE base_id = ${baseId}
        AND doc_type = ${docType}
        AND ref_id = ${refId}
    `.execute(this.db);
  }

  async search(params: {
    query: string;
    baseIds: string[];
    limit?: number;
  }): Promise<SearchHit[]> {
    const q = params.query.trim();
    if (!q || params.baseIds.length === 0) {
      return [];
    }
    const limit = params.limit ?? 50;

    const result = await sql<{
      id: string;
      workspace_id: string;
      base_id: string;
      doc_type: string;
      ref_id: string;
      title: string;
      rank: number;
    }>`
      SELECT
        id,
        workspace_id,
        base_id,
        doc_type,
        ref_id,
        title,
        ts_rank(tsv, plainto_tsquery('english', ${q})) AS rank
      FROM data.search_documents
      WHERE base_id = ANY(${params.baseIds}::uuid[])
        AND tsv @@ plainto_tsquery('english', ${q})
      ORDER BY rank DESC, updated_at DESC
      LIMIT ${limit}
    `.execute(this.db);

    return result.rows.map((row) => ({
      id: row.id,
      workspaceId: row.workspace_id,
      baseId: row.base_id,
      docType: row.doc_type,
      refId: row.ref_id,
      title: row.title,
      rank: row.rank,
    }));
  }
}
