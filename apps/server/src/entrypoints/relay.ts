import { loadEnv } from "@tabula/config";
import { createDb } from "@tabula/db";
import {
  createEventBus,
  DOMAIN_EVENTS_TOPIC,
  type DomainEvent,
} from "@tabula/events";
import { createLogger } from "@tabula/observability";
import { sql } from "kysely";
import { connectRedis } from "../lib/redis.js";

const POLL_MS = 500;
const BATCH = 50;

async function main(): Promise<void> {
  const env = loadEnv();
  const log = createLogger({ name: "tabula-relay", role: "relay" });
  const db = createDb(env.DATABASE_URL);
  const redis = await connectRedis(env, log);
  const eventBus = createEventBus(redis);

  log.info("Relay polling data.outbox_events (MVP profile)");

  const tick = async (): Promise<void> => {
    try {
      const rows = await sql<{
        id: string;
        created_at: Date;
        org_id: string;
        workspace_id: string;
        base_id: string | null;
        event_type: string;
        aggregate_type: string;
        aggregate_id: string;
        base_seq: string | null;
        payload: unknown;
      }>`
        SELECT id, created_at, org_id, workspace_id, base_id, event_type,
               aggregate_type, aggregate_id, base_seq, payload
        FROM data.outbox_events
        WHERE published_at IS NULL
        ORDER BY created_at ASC
        LIMIT ${BATCH}
      `.execute(db);

      for (const row of rows.rows) {
        const event: DomainEvent = {
          id: row.id,
          type: row.event_type,
          schemaVersion: 1,
          occurredAt: row.created_at.toISOString(),
          tenant: {
            orgId: row.org_id,
            workspaceId: row.workspace_id,
            ...(row.base_id ? { baseId: row.base_id } : {}),
          },
          actor: { type: "system", id: null, via: "relay" },
          ...(row.base_seq !== null
            ? { baseSeq: Number(row.base_seq) }
            : {}),
          causationDepth: 0,
          data: {
            aggregateType: row.aggregate_type,
            aggregateId: row.aggregate_id,
            ...(row.payload !== null && typeof row.payload === "object"
              ? (row.payload as Record<string, unknown>)
              : {}),
          },
        };

        const key = row.base_id ?? row.workspace_id;
        await eventBus.publish(DOMAIN_EVENTS_TOPIC, key, event);

        await sql`
          UPDATE data.outbox_events
          SET published_at = now()
          WHERE id = ${row.id} AND created_at = ${row.created_at}
        `.execute(db);
      }
    } catch (err) {
      log.error({ err }, "Relay poll failed");
    }
  };

  await tick();
  setInterval(() => {
    void tick();
  }, POLL_MS);
}

void main();
