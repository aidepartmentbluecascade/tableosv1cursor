import { generateUuidV7 } from "@tabula/types";
import { createHash, randomBytes } from "node:crypto";
import { sql } from "kysely";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../../lib/app-context.js";
import { parsePid, pid } from "../../lib/public-ids.js";
import {
  handleRouteError,
  notFound,
  validationProblem,
} from "../../http/errors.js";
import { userCanAccessWorkspace } from "../access/helpers.js";
import { writeAuditEvent } from "../audit/write.js";

const createInviteBody = z.object({
  email: z.string().email().max(320),
  workspaceId: z.string(),
  role: z.enum(["owner", "creator", "editor", "commenter", "viewer"]),
});

const acceptBody = z.object({
  token: z.string().min(16).max(512),
});

function hashInviteToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

export async function registerInvitationRoutes(
  app: FastifyInstance,
  ctx: AppContext,
): Promise<void> {
  app.post("/v1/invitations", async (request, reply) => {
    try {
      const user = request.user;
      if (!user) {
        notFound(request, reply);
        return;
      }
      const body = createInviteBody.parse(request.body);
      const workspaceId = parsePid(body.workspaceId, "wsp");
      const access = await userCanAccessWorkspace(ctx.db, user.id, workspaceId);
      if (!access.ok) {
        notFound(request, reply, "Workspace not found");
        return;
      }

      const emailNormalized = body.email.toLowerCase();
      const token = randomBytes(32).toString("base64url");
      const tokenHash = hashInviteToken(token);
      const inviteId = generateUuidV7();
      const expiresAt = new Date(Date.now() + 7 * 24 * 3600 * 1000);

      await sql`
        INSERT INTO core.invitations (
          id, org_id, workspace_id, email, email_normalized, role,
          token_hash, invited_by, expires_at
        ) VALUES (
          ${inviteId}, ${access.orgId}, ${workspaceId}, ${body.email}, ${emailNormalized},
          ${body.role}, ${tokenHash}, ${user.id}, ${expiresAt}
        )
      `.execute(ctx.db);

      await writeAuditEvent(ctx.db, {
        orgId: access.orgId,
        workspaceId,
        actorUserId: user.id,
        action: "invite.created",
        targetType: "invitation",
        targetId: inviteId,
        metadata: { email: emailNormalized, role: body.role },
        ip: request.ip,
        userAgent: request.headers["user-agent"] ?? null,
      });

      void reply.code(201).send({
        invitation: {
          id: pid("inv", inviteId),
          email: body.email,
          workspaceId: pid("wsp", workspaceId),
          role: body.role,
          expiresAt: expiresAt.toISOString(),
          acceptToken: token,
        },
      });
    } catch (err) {
      handleRouteError(request, reply, err);
    }
  });

  app.post("/v1/invitations/accept", async (request, reply) => {
    try {
      const user = request.user;
      if (!user) {
        notFound(request, reply);
        return;
      }
      const body = acceptBody.parse(request.body);
      const tokenHash = hashInviteToken(body.token);

      const invite = await sql<{
        id: string;
        org_id: string;
        workspace_id: string | null;
        email_normalized: string;
        role: string;
        status: string;
        expires_at: Date;
      }>`
        SELECT id, org_id, workspace_id, email_normalized, role, status, expires_at
        FROM core.invitations
        WHERE token_hash = ${tokenHash}
        LIMIT 1
      `.execute(ctx.db);

      const row = invite.rows[0];
      if (!row || row.status !== "pending" || row.expires_at < new Date()) {
        validationProblem(request, reply, "Invalid or expired invitation");
        return;
      }

      if (row.email_normalized !== user.email.toLowerCase()) {
        validationProblem(request, reply, "Invitation email does not match your account");
        return;
      }

      await ctx.db.transaction().execute(async (trx) => {
        await sql`
          INSERT INTO core.organization_members (org_id, user_id, role, source)
          VALUES (${row.org_id}, ${user.id}, 'member', 'invite')
          ON CONFLICT (org_id, user_id) DO UPDATE SET status = 'active', updated_at = now()
        `.execute(trx);

        if (row.workspace_id) {
          await sql`
            INSERT INTO core.access_grants (
              id, org_id, resource_type, resource_id, workspace_id,
              principal_type, principal_id, role, source, granted_by
            ) VALUES (
              ${generateUuidV7()}, ${row.org_id}, 'workspace', ${row.workspace_id}, ${row.workspace_id},
              'user', ${user.id}, ${row.role}, 'invite', ${user.id}
            )
            ON CONFLICT (resource_type, resource_id, principal_type, principal_id)
            DO UPDATE SET role = EXCLUDED.role, updated_at = now()
          `.execute(trx);
        }

        await sql`
          UPDATE core.invitations
          SET status = 'accepted', accepted_at = now(), accepted_by = ${user.id}, updated_at = now()
          WHERE id = ${row.id}
        `.execute(trx);
      });

      await writeAuditEvent(ctx.db, {
        orgId: row.org_id,
        workspaceId: row.workspace_id,
        actorUserId: user.id,
        action: "invite.accepted",
        targetType: "invitation",
        targetId: row.id,
        metadata: { role: row.role },
        ip: request.ip,
        userAgent: request.headers["user-agent"] ?? null,
      });

      void reply.send({ ok: true });
    } catch (err) {
      handleRouteError(request, reply, err);
    }
  });
}
