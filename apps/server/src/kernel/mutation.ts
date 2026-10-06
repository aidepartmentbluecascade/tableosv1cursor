import type { Database, TabulaDb } from "@tabula/db";
import { generateUuidV7 } from "@tabula/types";
import type { Redis } from "ioredis";
import { sql, type Transaction } from "kysely";
import { publishBaseChange } from "./realtime-fanout.js";
import { currentRequestContext } from "./request-context.js";

type DbTrx = Transaction<Database>;

export interface MutationActor {
  actorType: "user" | "system";
  actorId: string | null;
  sessionId?: string;
  via: "ui" | "api" | "system" | "undo" | "redo" | "restore";
}

export type AfterCommitFn = () => Promise<void> | void;

export interface BaseMutationContext {
  orgId: string;
  workspaceId: string;
  baseId: string;
  changeSeq: number;
  schemaVersion: number;
  /** Client mutation id for this change (explicit param or request header). */
  clientMutationId: string | null;
  /**
   * Register work that must only happen once the surrounding transaction has
   * committed (job enqueue, realtime publish, cache busting...). Callbacks run
   * in registration order; errors are logged, never thrown to the caller.
   * If the transaction rolls back, callbacks are dropped.
   */
  afterCommit(fn: AfterCommitFn): void;
}

/**
 * Pending after-commit callbacks for transactions opened by
 * `runTransactionWithAfterCommit`. Lets nested `withBaseTx(…, existingTrx)`
 * calls defer work to the outer commit.
 */
const pendingByTrx = new WeakMap<object, AfterCommitFn[]>();

async function runAfterCommitCallbacks(fns: AfterCommitFn[]): Promise<void> {
  for (const fn of fns) {
    try {
      await fn();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[kernel] afterCommit callback failed", err);
    }
  }
}

/**
 * Open a transaction whose `withBaseTx(…, trx)` children may register
 * `afterCommit` callbacks; they run after this transaction commits.
 */
export async function runTransactionWithAfterCommit<T>(
  db: TabulaDb,
  fn: (trx: DbTrx) => Promise<T>,
): Promise<T> {
  const callbacks: AfterCommitFn[] = [];
  const result = await db.transaction().execute(async (trx) => {
    pendingByTrx.set(trx, callbacks);
    return fn(trx);
  });
  await runAfterCommitCallbacks(callbacks);
  return result;
}

/** Register an after-commit callback on a transaction opened elsewhere. */
export function afterCommitOf(trx: DbTrx, fn: AfterCommitFn): boolean {
  const list = pendingByTrx.get(trx);
  if (!list) return false;
  list.push(fn);
  return true;
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
  const callbacks: AfterCommitFn[] = [];
  const clientMutationId =
    params.clientMutationId ?? currentRequestContext()?.clientMutationId ?? null;

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
      clientMutationId,
      afterCommit(fn) {
        callbacks.push(fn);
      },
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
        ${clientMutationId},
        ${schemaVersion}
      )
    `.execute(trx);

    const eventId = generateUuidV7();
    const actor = {
      type: params.actor.actorType,
      id: params.actor.actorId,
      via: params.actor.via,
    };

    // Event payloads always carry tableId/recordId where they can be derived
    // so downstream consumers (search indexer, notifications, automations)
    // never have to guess.
    const payload: Record<string, unknown> = { ...mutation.payload };
    if (payload["tableId"] === undefined && tableIds.length === 1) {
      payload["tableId"] = tableIds[0];
    }
    if (tableIds.length > 0 && payload["tableIds"] === undefined) {
      payload["tableIds"] = tableIds;
    }
    if (payload["recordId"] === undefined && mutation.aggregateType === "record") {
      payload["recordId"] = mutation.aggregateId;
    }
    if (payload["clientMutationId"] === undefined && clientMutationId) {
      payload["clientMutationId"] = clientMutationId;
    }

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
        ${JSON.stringify(payload)}::jsonb
      )
    `.execute(trx);

    const redis = params.redis;
    if (redis) {
      // Realtime fan-out must only happen once the change is durable.
      callbacks.push(() =>
        publishBaseChange(redis, {
          baseId: params.baseId,
          seq: changeSeq,
          kind: mutation.kind,
          tableIds,
          ops: mutation.ops,
          clientMutationId,
          actor: {
            type: params.actor.actorType,
            id: params.actor.actorId,
          },
        }),
      );
    }

    return changeSeq;
  };

  if (existingTrx) {
    const seq = await run(existingTrx);
    const outer = pendingByTrx.get(existingTrx);
    if (outer) {
      outer.push(...callbacks);
    } else {
      // The caller owns the transaction but did not open it through
      // runTransactionWithAfterCommit: we cannot observe its commit, so defer
      // to the next macrotask (best effort; most callers commit right away).
      setTimeout(() => void runAfterCommitCallbacks(callbacks), 50);
    }
    return seq;
  }
  const seq = await db.transaction().execute(run);
  await runAfterCommitCallbacks(callbacks);
  return seq;
}
