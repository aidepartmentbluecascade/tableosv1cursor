import { generateUuidV7 } from "@tabula/types";
import pg from "pg";

const { Client } = pg;

export interface SeedDefaultShardOptions {
  connectionString: string;
  /** DSN reference stored in core.shards (local dev uses DATABASE_URL). */
  dsnSecretRef?: string;
  writerEndpoint?: string;
  region?: string;
  shardName?: string;
}

/** Ensures a default active shard exists for local MVP (single Postgres cluster). */
export async function seedDefaultShard(
  options: SeedDefaultShardOptions,
): Promise<string> {
  const {
    connectionString,
    dsnSecretRef = "local/env:DATABASE_URL",
    writerEndpoint = "localhost:5432",
    region = "local",
    shardName = "dp-local-001",
  } = options;

  const client = new Client({ connectionString });
  await client.connect();

  try {
    const existing = await client.query<{ id: string }>(
      "SELECT id FROM core.shards WHERE name = $1 LIMIT 1",
      [shardName],
    );
    if (existing.rows[0]) {
      return existing.rows[0].id;
    }

    const id = generateUuidV7();
    await client.query(
      `INSERT INTO core.shards (
         id, name, region, status, dsn_secret_ref, writer_endpoint, reader_endpoints
       ) VALUES ($1, $2, $3, 'active', $4, $5, '{}')`,
      [id, shardName, region, dsnSecretRef, writerEndpoint],
    );
    console.log(`Seeded default shard ${shardName} (${id})`);
    return id;
  } finally {
    await client.end();
  }
}

const PLAN_SEEDS = [
  {
    code: "free",
    name: "Free",
    limits: {
      recordsPerBase: 2000,
      tablesPerBase: 50,
      attachmentBytesPerBase: 1_073_741_824,
      automationRunsPerMonth: 200,
      apiRatePerTokenRps: 5,
      revisionRetentionDays: 14,
    },
  },
  {
    code: "team",
    name: "Team",
    limits: {
      recordsPerBase: 100_000,
      tablesPerBase: 200,
      attachmentBytesPerBase: 53_687_091_200,
      automationRunsPerMonth: 50_000,
      apiRatePerTokenRps: 20,
      revisionRetentionDays: 365,
    },
  },
] as const;

/** Ensures Free and Team plan rows exist (also inserted by migration 0005). */
export async function seedPlans(connectionString: string): Promise<void> {
  const client = new Client({ connectionString });
  await client.connect();

  try {
    for (const plan of PLAN_SEEDS) {
      await client.query(
        `INSERT INTO core.plans (code, name, limits)
         VALUES ($1, $2, $3::jsonb)
         ON CONFLICT (code) DO NOTHING`,
        [plan.code, plan.name, JSON.stringify(plan.limits)],
      );
    }
  } finally {
    await client.end();
  }
}
