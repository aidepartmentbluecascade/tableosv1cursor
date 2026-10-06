import { sql } from "kysely";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../../lib/app-context.js";
import { parsePid, pid } from "../../lib/public-ids.js";
import { handleRouteError, notFound } from "../../http/errors.js";

export async function registerNotificationsRoutes(
  app: FastifyInstance,
  ctx: AppContext,
): Promise<void> {
  app.get("/v1/notifications", async (request, reply) => {
    try {
      const user = request.user;
      if (!user) {
        notFound(request, reply);
        return;
      }

      const rows = await sql<{
        id: string;
        category: string;
        title: string;
        body: unknown;
        read_at: Date | null;
        created_at: Date;
        workspace_id: string | null;
        base_id: string | null;
      }>`
        SELECT id, category, title, body, read_at, created_at, workspace_id, base_id
        FROM core.notifications
        WHERE user_id = ${user.id}
        ORDER BY created_at DESC
        LIMIT 100
      `.execute(ctx.db);

      void reply.send({
        notifications: rows.rows.map((n) => ({
          id: pid("ntf", n.id),
          category: n.category,
          title: n.title,
          body: n.body,
          read: n.read_at !== null,
          createdAt: n.created_at.toISOString(),
          workspaceId: n.workspace_id ? pid("wsp", n.workspace_id) : null,
          baseId: n.base_id ? pid("bas", n.base_id) : null,
        })),
      });
    } catch (err) {
      handleRouteError(request, reply, err);
    }
  });

  app.post<{ Params: { id: string } }>(
    "/v1/notifications/:id/read",
    async (request, reply) => {
      try {
        const user = request.user;
        if (!user) {
          notFound(request, reply);
          return;
        }

        const notificationId = parsePid(request.params.id, "ntf");

        await sql`
          UPDATE core.notifications
          SET read_at = now()
          WHERE id = ${notificationId} AND user_id = ${user.id} AND read_at IS NULL
        `.execute(ctx.db);

        void reply.send({ ok: true });
      } catch (err) {
        handleRouteError(request, reply, err);
      }
    },
  );
}
