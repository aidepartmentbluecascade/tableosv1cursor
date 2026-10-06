import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import type { Database } from "./database.js";

const { Pool } = pg;

export type TabulaDb = Kysely<Database>;

export function createDb(connectionString: string): TabulaDb {
  const pool = new Pool({ connectionString });
  return new Kysely<Database>({
    dialect: new PostgresDialect({ pool }),
  });
}
