import { sql, type Kysely, type Transaction } from "kysely";
import type { TabulaDb } from "./create-db.js";
import type { Database } from "./database.js";

type DbExecutor = TabulaDb | Transaction<Database>;

async function setLocalConfig(
  trx: DbExecutor,
  key: string,
  value: string,
): Promise<void> {
  await sql`SELECT set_config(${key}, ${value}, true)`.execute(trx);
}

/**
 * Runs `fn` in a transaction with `SET LOCAL app.workspace_id` (via set_config is_local).
 */
export async function withTenant<T>(
  db: TabulaDb,
  workspaceId: string,
  fn: (trx: Transaction<Database>) => Promise<T>,
): Promise<T> {
  return db.transaction().execute(async (trx) => {
    await setLocalConfig(trx, "app.workspace_id", workspaceId);
    return fn(trx);
  });
}

/** Admin/migrator path: bypass workspace RLS policies for the transaction. */
export async function withBypassRls<T>(
  db: TabulaDb | Kysely<Database>,
  fn: (trx: Transaction<Database>) => Promise<T>,
): Promise<T> {
  return db.transaction().execute(async (trx) => {
    await setLocalConfig(trx, "app.bypass_rls", "on");
    return fn(trx);
  });
}
