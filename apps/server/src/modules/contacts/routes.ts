import { generateUuidV7 } from "@tabula/types";
import { sql } from "kysely";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../../lib/app-context.js";
import { parsePid, pid } from "../../lib/public-ids.js";
import { handleRouteError, notFound } from "../../http/errors.js";
import { userCanAccessWorkspace } from "../access/helpers.js";
import { ensureContactDirectory } from "./ensure-directory.js";

export async function registerContactsRoutes(
  app: FastifyInstance,
  ctx: AppContext,
): Promise<void> {
  app.get<{ Params: { workspaceId: string } }>(
    "/v1/workspaces/:workspaceId/contacts",
    async (request, reply) => {
      try {
        const user = request.user;
        if (!user) {
          notFound(request, reply);
          return;
        }

        const workspaceId = parsePid(request.params.workspaceId, "wsp");
        const access = await userCanAccessWorkspace(ctx.db, user.id, workspaceId);
        if (!access.ok) {
          notFound(request, reply, "Workspace not found");
          return;
        }

        const shard = await sql<{ shard_id: string }>`
          SELECT shard_id FROM core.workspace_directory
          WHERE workspace_id = ${workspaceId}
          LIMIT 1
        `.execute(ctx.db);

        const shardId = shard.rows[0]?.shard_id ?? ctx.defaultShardId;

        const directory = await ensureContactDirectory(ctx.db, {
          workspaceId,
          orgId: access.orgId,
          shardId,
          userId: user.id,
        });

        const records = await sql<{ id: string; cells: Record<string, unknown> }>`
          SELECT id, cells
          FROM data.records
          WHERE table_id = ${directory.contactsTableId}
            AND deleted_at IS NULL
          ORDER BY created_at DESC
          LIMIT 500
        `.execute(ctx.db);

        void reply.send({
          contactDirectoryBaseId: pid("bas", directory.baseId),
          contacts: records.rows.map((r) => ({
            id: pid("rec", r.id),
            fields: r.cells,
          })),
        });
      } catch (err) {
        handleRouteError(request, reply, err);
      }
    },
  );

  app.post<{ Params: { workspaceId: string } }>(
    "/v1/workspaces/:workspaceId/contacts/merge",
    async (request, reply) => {
      try {
        const user = request.user;
        if (!user) {
          notFound(request, reply);
          return;
        }

        const workspaceId = parsePid(request.params.workspaceId, "wsp");
        const access = await userCanAccessWorkspace(ctx.db, user.id, workspaceId);
        if (!access.ok) {
          notFound(request, reply, "Workspace not found");
          return;
        }

        const body = z
          .object({
            survivorContactId: z.string(),
            mergedContactId: z.string(),
          })
          .parse(request.body);

        const survivorId = parsePid(body.survivorContactId, "rec");
        const mergedId = parsePid(body.mergedContactId, "rec");

        await ctx.db.transaction().execute(async (trx) => {
          await sql`
            UPDATE data.records
            SET deleted_at = now(), deleted_by = ${user.id}
            WHERE id = ${mergedId} AND workspace_id = ${workspaceId}
          `.execute(trx);

          await sql`
            INSERT INTO data.contact_merge_events (
              id, workspace_id, survivor_contact_id, merged_contact_id, performed_by
            ) VALUES (
              ${generateUuidV7()}, ${workspaceId}, ${survivorId}, ${mergedId}, ${user.id}
            )
          `.execute(trx);
        });

        void reply.send({
          ok: true,
          survivorContactId: pid("rec", survivorId),
        });
      } catch (err) {
        handleRouteError(request, reply, err);
      }
    },
  );
}
