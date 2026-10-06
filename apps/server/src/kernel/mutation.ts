import type { Database, TabulaDb } from "@tabula/db";
import { generateUuidV7 } from "@tabula/types";
import type { Redis } from "ioredis";
import { sql, type Transaction } from "kysely";
import { publishBaseChange } from "./realtime-fanout.js";

type DbTrx = Transaction<Database>;

export interface MutationActor {
  actorType: "user" | "system";
  actorId: string | null;
  sessionId?: string;
  via: "ui" | "api" | "system" | "undo" | "redo" | "restore";
}

export interface BaseMutationContext {
  orgId: string;
  workspaceId: string;
  baseId: string;
  changeSeq: number;
  schemaVersion: number;
}

export interface MutationResult {
  ops: unknown[];
  inverseOps?: unknown[] | null;
  tableIds?: string[];
  kind:
    | "records"
    | "links"
    | "schema"
    | "views"
    | "bulk"
    | "undo"
    | "redo"
    | "restore";
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
}

export async function withBaseTx(
  db: TabulaDb,
  params: {
    orgId: string;
    workspaceId: string;
    baseId: string;
    actor: MutationActor;
    clientMutationId?: string;
    redis?: Redis | null;
  },
  fn: (ctx: BaseMutationContext, trx: DbTrx) => Promise<MutationResult>,
  existingTrx?: DbTrx,
): Promise<number> {
  const run = async (trx: DbTrx): Promise<number> => {
    const runtime = await sql<{ change_seq: string; schema_version: string }>`
      UPDATE data.base_runtime
      SET change_seq = change_seq + 1,
          last_change_at = now(),
          updated_at = now()
      WHERE base_id = ${params.baseId}
      RETURNING change_seq, schema_version
    `.execute(trx);

    const row = runtime.rows[0];
    if (!row) {
      throw new Error("Base runtime not found");
    }

    const changeSeq = Number(row.change_seq);
    const schemaVersion = Number(row.schema_version);

    const ctx: BaseMutationContext = {
      orgId: params.orgId,
      workspaceId: params.workspaceId,
      baseId: params.baseId,
      changeSeq,
      schemaVersion,
    };

    const mutation = await fn(ctx, trx);

    const tableIds = mutation.tableIds ?? [];
    const inverseOps = mutation.inverseOps ?? null;
    const opCount = mutation.ops.length;

    await sql`
      INSERT INTO data.base_changes (
        base_id, seq, workspace_id, kind, ops, inverse_ops, op_count,
        table_ids, actor_type, actor_id, via, session_id, client_mutation_id,
        schema_version
      ) VALUES (
        ${params.baseId},
        ${changeSeq},
        ${params.workspaceId},
        ${mutation.kind},
        ${JSON.stringify(mutation.ops)}::jsonb,
        ${inverseOps === null ? null : JSON.stringify(inverseOps)}::jsonb,
        ${opCount},
        ${tableIds}::uuid[],
        ${params.actor.actorType},
        ${params.actor.actorId},
        ${params.actor.via},
        ${params.actor.sessionId ?? null},
        ${params.clientMutationId ?? null},
        ${schemaVersion}
      )
    `.execute(trx);

    const eventId = generateUuidV7();
    const actor = {
      type: params.actor.actorType,
      id: params.actor.actorId,
      via: params.actor.via,
    };

    await sql`
      INSERT INTO data.outbox_events (
        id, org_id, workspace_id, base_id, event_type, topic, partition_key,
        aggregate_type, aggregate_id, base_seq, actor, payload
      ) VALUES (
        ${eventId},
        ${params.orgId},
        ${params.workspaceId},
        ${params.baseId},
        ${mutation.eventType},
        'tabula.domain-events.v1',
        ${params.baseId},
        ${mutation.aggregateType},
        ${mutation.aggregateId},
        ${changeSeq},
        ${JSON.stringify(actor)}::jsonb,
        ${JSON.stringify(mutation.payload)}::jsonb
      )
    `.execute(trx);

    if (params.redis) {
      void publishBaseChange(params.redis, {
        baseId: params.baseId,
        seq: changeSeq,
        ops: mutation.ops,
        actor: {
          type: params.actor.actorType,
          id: params.actor.actorId,
        },
      }).catch(() => {
        /* fan-out is best-effort */
      });
    }

    return changeSeq;
  };

  if (existingTrx) {
    return run(existingTrx);
  }
  return db.transaction().execute(run);
}
