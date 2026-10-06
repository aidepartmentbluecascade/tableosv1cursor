import { sql } from "kysely";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../../lib/app-context.js";
import { parsePid } from "../../lib/public-ids.js";
import { handleRouteError, notFound, conflict } from "../../http/errors.js";
import { resolveBaseContext } from "../access/helpers.js";
import { compileForUser } from "../access/compile.js";
import { assertCan } from "../access/assert.js";
import { withBaseTx, type MutationActor } from "../../kernel/mutation.js";
import { applyInverseOpsInTx } from "./apply-inverse.js";

const undoBody = z.object({
  changeId: z.string().optional(),
});

const restoreBody = z.object({
  deletionBatchId: z.string().uuid(),
});

function actor(user: NonNullable<import("fastify").FastifyRequest["user"]>): MutationActor {
  return {
    actorType: "user",
    actorId: user.id,
    sessionId: user.sessionId,
    via: "api",
  };
}

async function loadUndoableChange(
  db: AppContext["db"],
  baseId: string,
  userId: string,
  sessionId: string | undefined,
  changeId?: string,
) {
  if (changeId) {
    const seq = Number(changeId);
    const bySeq = await sql<{
      seq: string;
      inverse_ops: unknown;
      table_ids: string[];
      ops: unknown;
    }>`
      SELECT seq, inverse_ops, table_ids, ops
      FROM data.base_changes
      WHERE base_id = ${baseId} AND seq = ${seq}
        AND inverse_ops IS NOT NULL
      LIMIT 1
    `.execute(db);
    return bySeq.rows[0] ?? null;
  }

  const latest = await sql<{
    seq: string;
    inverse_ops: unknown;
    table_ids: string[];
    ops: unknown;
  }>`
    SELECT seq, inverse_ops, table_ids, ops
    FROM data.base_changes
    WHERE base_id = ${baseId}
      AND actor_id = ${userId}
      AND (${sessionId ?? null}::uuid IS NULL OR session_id = ${sessionId ?? null})
      AND inverse_ops IS NOT NULL
      AND kind NOT IN ('undo', 'redo')
    ORDER BY seq DESC
    LIMIT 1
  `.execute(db);
  return latest.rows[0] ?? null;
}

export async function registerHistoryRoutes(
  app: FastifyInstance,
  ctx: AppContext,
): Promise<void> {
  app.post<{ Params: { baseId: string } }>(
    "/v1/bases/:baseId/undo",
    async (request, reply) => {
      try {
        const user = request.user;
        if (!user) {
          notFound(request, reply);
          return;
        }
        const baseId = parsePid(request.params.baseId, "bas");
        const body = undoBody.parse(request.body ?? {});

        const base = await resolveBaseContext(ctx.db, user.id, baseId);
        if (!base.ok) {
          notFound(request, reply, "Base not found");
          return;
        }

        const snapshot = await compileForUser(ctx.db, user.id, baseId);
        assertCan(snapshot, "record.update");

        const change = await loadUndoableChange(
          ctx.db,
          baseId,
          user.id,
          user.sessionId,
          body.changeId,
        );
        if (!change) {
          conflict(request, reply, "Nothing to undo");
          return;
        }

        const seq = await withBaseTx(
          ctx.db,
          {
            orgId: base.orgId,
            workspaceId: base.workspaceId,
            baseId,
            actor: { ...actor(user), via: "undo" },
            redis: ctx.redis,
          },
          async (_mctx, trx) => {
            await applyInverseOpsInTx(trx, {
              baseId,
              workspaceId: base.workspaceId,
              userId: user.id,
              tableIdsHint: change.table_ids,
              inverseOps: change.inverse_ops,
            });
            return {
              kind: "undo" as const,
              ops: [{ op: "change.undone", seq: change.seq }],
              inverseOps: change.ops as unknown[],
              tableIds: change.table_ids,
              eventType: "change.undone",
              aggregateType: "base",
              aggregateId: baseId,
              payload: { undoneSeq: Number(change.seq) },
            };
          },
        );

        void reply.send({ changeSeq: seq, undoneSeq: Number(change.seq) });
      } catch (err) {
        handleRouteError(request, reply, err);
      }
    },
  );

  app.post<{ Params: { baseId: string } }>(
    "/v1/bases/:baseId/redo",
    async (request, reply) => {
      try {
        const user = request.user;
        if (!user) {
          notFound(request, reply);
          return;
        }
        const baseId = parsePid(request.params.baseId, "bas");
        const base = await resolveBaseContext(ctx.db, user.id, baseId);
        if (!base.ok) {
          notFound(request, reply, "Base not found");
          return;
        }

        const snapshot = await compileForUser(ctx.db, user.id, baseId);
        assertCan(snapshot, "record.update");

        const lastUndo = await sql<{
          seq: string;
          inverse_ops: unknown;
          table_ids: string[];
        }>`
          SELECT seq, inverse_ops, table_ids
          FROM data.base_changes
          WHERE base_id = ${baseId}
            AND actor_id = ${user.id}
            AND kind = 'undo'
            AND inverse_ops IS NOT NULL
          ORDER BY seq DESC
          LIMIT 1
        `.execute(ctx.db);

        const change = lastUndo.rows[0];
        if (!change) {
          conflict(request, reply, "Nothing to redo");
          return;
        }

        const seq = await withBaseTx(
          ctx.db,
          {
            orgId: base.orgId,
            workspaceId: base.workspaceId,
            baseId,
            actor: { ...actor(user), via: "redo" },
            redis: ctx.redis,
          },
          async (_mctx, trx) => {
            await applyInverseOpsInTx(trx, {
              baseId,
              workspaceId: base.workspaceId,
              userId: user.id,
              tableIdsHint: change.table_ids,
              inverseOps: change.inverse_ops,
            });
            return {
              kind: "redo" as const,
              ops: [{ op: "change.redone", seq: change.seq }],
              tableIds: change.table_ids,
              eventType: "change.redone",
              aggregateType: "base",
              aggregateId: baseId,
              payload: { redoneUndoSeq: Number(change.seq) },
            };
          },
        );

        void reply.send({ changeSeq: seq });
      } catch (err) {
        handleRouteError(request, reply, err);
      }
    },
  );

  app.post<{ Params: { baseId: string } }>(
    "/v1/bases/:baseId/trash/restore",
    async (request, reply) => {
      try {
        const user = request.user;
        if (!user) {
          notFound(request, reply);
          return;
        }
        const baseId = parsePid(request.params.baseId, "bas");
        const body = restoreBody.parse(request.body);

        const base = await resolveBaseContext(ctx.db, user.id, baseId);
        if (!base.ok) {
          notFound(request, reply, "Base not found");
          return;
        }

        const snapshot = await compileForUser(ctx.db, user.id, baseId);
        assertCan(snapshot, "record.update");

        const seq = await withBaseTx(
          ctx.db,
          {
            orgId: base.orgId,
            workspaceId: base.workspaceId,
            baseId,
            actor: { ...actor(user), via: "restore" },
            redis: ctx.redis,
          },
          async (_mctx, trx) => {
            await applyInverseOpsInTx(trx, {
              baseId,
              workspaceId: base.workspaceId,
              userId: user.id,
              tableIdsHint: [],
              inverseOps: [{ op: "record.restore", batchId: body.deletionBatchId }],
            });
            return {
              kind: "restore" as const,
              ops: [{ op: "trash.restored", batchId: body.deletionBatchId }],
              tableIds: [],
              eventType: "trash.restored",
              aggregateType: "base",
              aggregateId: baseId,
              payload: { deletionBatchId: body.deletionBatchId },
            };
          },
        );

        void reply.send({ changeSeq: seq, deletionBatchId: body.deletionBatchId });
      } catch (err) {
        handleRouteError(request, reply, err);
      }
    },
  );
}
