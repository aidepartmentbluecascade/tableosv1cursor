import type { TabulaDb } from "./create-db.js";

export class ShardRouter {
  constructor(private readonly db: TabulaDb) {}

  /** Resolve shard placement for a workspace (MVP: single cluster; dsn omitted when secret ref is local). */
  async forWorkspace(workspaceId: string): Promise<{ shardId: string; dsn?: string }> {
    const row = await this.db
      .withSchema("core")
      .selectFrom("workspace_directory")
      .innerJoin("shards", "shards.id", "workspace_directory.shard_id")
      .select([
        "workspace_directory.shard_id as shardId",
        "shards.dsn_secret_ref as dsnSecretRef",
      ])
      .where("workspace_directory.workspace_id", "=", workspaceId)
      .executeTakeFirst();

    if (!row) {
      throw new Error(`No shard routing for workspace ${workspaceId}`);
    }

    const useLocalDsn =
      row.dsnSecretRef.startsWith("local/") || row.dsnSecretRef.startsWith("local/env:");

    if (useLocalDsn) {
      return { shardId: row.shardId };
    }
    return { shardId: row.shardId, dsn: row.dsnSecretRef };
  }

  /** Resolve workspace + shard for a base via control-plane directory. */
  async forBase(baseId: string): Promise<{ workspaceId: string; shardId: string }> {
    const row = await this.db
      .withSchema("core")
      .selectFrom("base_directory")
      .select(["workspace_id as workspaceId", "shard_id as shardId"])
      .where("base_id", "=", baseId)
      .executeTakeFirst();

    if (!row) {
      throw new Error(`No shard routing for base ${baseId}`);
    }

    return { workspaceId: row.workspaceId, shardId: row.shardId };
  }
}
