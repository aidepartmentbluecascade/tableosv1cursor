import { hashPassword, verifyPassword } from "@tabula/auth";
import { generateUuidV7 } from "@tabula/types";
import { sql } from "kysely";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../../lib/app-context.js";
import { parsePid, pid } from "../../lib/public-ids.js";
import {
  handleRouteError,
  notFound,
  unauthorized,
  validationProblem,
} from "../../http/errors.js";
import { resolveBaseContext } from "../access/helpers.js";
import {
  createShareToken,
  hashShareToken,
  parseShareToken,
} from "./tokens.js";
import { writeAuditEvent } from "../audit/write.js";

const createShareBody = z.object({
  targetType: z.enum(["view", "form"]),
  targetId: z.string(),
  password: z.string().min(4).max(200).optional(),
  expiresAt: z.string().datetime().optional(),
});

export async function registerShareRoutes(
  app: FastifyInstance,
  ctx: AppContext,
): Promise<void> {
  app.post<{ Params: { baseId: string } }>(
    "/v1/bases/:baseId/shares",
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

        const body = createShareBody.parse(request.body);
        const targetId = parsePid(
          body.targetId,
          body.targetType === "view" ? "viw" : "viw",
        );

        const view = await sql<{ id: string }>`
          SELECT id FROM data.views
          WHERE id = ${targetId} AND base_id = ${baseId} AND deleted_at IS NULL
          LIMIT 1
        `.execute(ctx.db);

        if (!view.rows[0]) {
          validationProblem(request, reply, "Target view not found");
          return;
        }

        const { token, tokenPrefix, tokenHash } = createShareToken();
        const shareId = generateUuidV7();
        const accessMode = body.password ? "password" : "public";
        const passwordHash = body.password
          ? await hashPassword(body.password)
          : null;
        const expiresAt = body.expiresAt ? new Date(body.expiresAt) : null;

        await ctx.db.transaction().execute(async (trx) => {
          await sql`
            INSERT INTO data.share_links (
              id, workspace_id, base_id, target_type, target_id,
              token_hash, token_prefix, access_mode, password_hash,
              expires_at, created_by
            ) VALUES (
              ${shareId}, ${base.workspaceId}, ${baseId}, ${body.targetType}, ${targetId},
              ${tokenHash}, ${tokenPrefix}, ${accessMode}, ${passwordHash},
              ${expiresAt}, ${user.id}
            )
          `.execute(trx);

          await sql`
            INSERT INTO core.public_link_directory (
              token_prefix, workspace_id, shard_id, share_link_id, kind
            ) VALUES (
              ${tokenPrefix}, ${base.workspaceId}, ${base.shardId}, ${shareId}, 'share_link'
            )
          `.execute(trx);
        });

        await writeAuditEvent(ctx.db, {
          orgId: base.orgId,
          workspaceId: base.workspaceId,
          actorUserId: user.id,
          action: "share.created",
          targetType: "share_link",
          targetId: shareId,
          metadata: {
            targetType: body.targetType,
            accessMode,
          },
          ip: request.ip,
          userAgent: request.headers["user-agent"] ?? null,
        });

        void reply.code(201).send({
          share: {
            id: pid("shr", shareId),
            token,
            targetType: body.targetType,
            targetId: pid("viw", targetId),
            accessMode,
            expiresAt: expiresAt?.toISOString() ?? null,
          },
        });
      } catch (err) {
        handleRouteError(request, reply, err);
      }
    },
  );

  app.get<{ Params: { token: string }; Querystring: { password?: string } }>(
    "/v1/public/shares/:token",
    async (request, reply) => {
      try {
        const parsed = parseShareToken(request.params.token);
        if (!parsed) {
          notFound(request, reply, "Share link not found");
          return;
        }

        const dir = await sql<{
          workspace_id: string;
          share_link_id: string;
        }>`
          SELECT workspace_id, share_link_id
          FROM core.public_link_directory
          WHERE token_prefix = ${parsed.prefix}
          LIMIT 1
        `.execute(ctx.db);

        const route = dir.rows[0];
        if (!route) {
          notFound(request, reply, "Share link not found");
          return;
        }

        const link = await sql<{
          id: string;
          base_id: string;
          target_type: string;
          target_id: string;
          token_hash: Buffer;
          access_mode: string;
          password_hash: string | null;
          expires_at: Date | null;
          revoked_at: Date | null;
        }>`
          SELECT id, base_id, target_type, target_id, token_hash, access_mode,
                 password_hash, expires_at, revoked_at
          FROM data.share_links
          WHERE id = ${route.share_link_id}
          LIMIT 1
        `.execute(ctx.db);

        const row = link.rows[0];
        if (!row || row.revoked_at) {
          notFound(request, reply, "Share link not found");
          return;
        }

        if (row.expires_at && row.expires_at.getTime() < Date.now()) {
          notFound(request, reply, "Share link expired");
          return;
        }

        const expectedHash = hashShareToken(parsed.token);
        if (!row.token_hash.equals(expectedHash)) {
          notFound(request, reply, "Share link not found");
          return;
        }

        if (row.access_mode === "password") {
          const password = request.query.password;
          if (!password || !row.password_hash) {
            unauthorized(request, reply);
            return;
          }
          const ok = await verifyPassword(password, row.password_hash);
          if (!ok) {
            unauthorized(request, reply);
            return;
          }
        }

        void reply.send({
          share: {
            id: pid("shr", row.id),
            workspaceId: pid("wsp", route.workspace_id),
            baseId: pid("bas", row.base_id),
            targetType: row.target_type,
            targetId: pid("viw", row.target_id),
          },
        });
      } catch (err) {
        handleRouteError(request, reply, err);
      }
    },
  );
}
