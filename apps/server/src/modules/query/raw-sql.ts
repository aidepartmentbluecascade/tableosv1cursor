import { CompiledQuery } from "kysely";
import type { TabulaDb } from "@tabula/db";

export async function executeRawQuery<T>(
  db: TabulaDb,
  sqlText: string,
  parameters: unknown[],
): Promise<T[]> {
  const result = await db.executeQuery<T>(
    CompiledQuery.raw(sqlText, parameters),
  );
  return result.rows;
}
