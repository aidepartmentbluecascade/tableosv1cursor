import {
  encryptMfaSecret,
  generateTotpSecret,
  hashPassword,
  mfaKeyFromEnv,
  verifyPassword,
  verifyTotp,
} from "@tabula/auth";
import { generateUuidV7 } from "@tabula/types";
import { sql } from "kysely";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../../lib/app-context.js";
import { pid } from "../../lib/public-ids.js";
import { slugify, uniqueSlug } from "../../lib/slug.js";
import {
  handleRouteError,
  notFound,
  validationProblem,
} from "../../http/errors.js";
import { clearSessionCookie, createSession, revokeSession } from "./session.js";
import { setPendingMfaSecret, takePendingMfaSecret } from "./mfa-pending.js";
import {
  consumeOAuthState,
  createOAuthState,
  exchangeGoogleCode,
  fetchGoogleProfile,
  googleAuthorizeUrl,
  googleOAuthEnabled,
} from "./google-oauth.js";
import { writeAuditEvent } from "../audit/write.js";
import { createFreeSubscriptionInTx } from "../billing/subscription.js";
import {
  generateWsTicket,
  storeWsTicket,
} from "./ws-ticket.js";

function wsTicketSecret(env: AppContext["env"]): string {
  return env.WS_TICKET_SECRET ?? env.SESSION_SECRET;
}

const signupBody = z.object({
  email: z.string().email().max(320),
  password: z.string().min(8).max(128),
  name: z.string().min(1).max(200),
});

const loginBody = z.object({
  email: z.string().email().max(320),
  password: z.string().min(1).max(128),
});

export async function registerAuthRoutes(
  app: FastifyInstance,
  ctx: AppContext,
): Promise<void> {
  app.post("/v1/auth/signup", async (request, reply) => {
    try {
      const body = signupBody.parse(request.body);
      const emailNormalized = body.email.toLowerCase();

      const existing = await sql<{ id: string }>`
        SELECT id FROM core.users WHERE email_normalized = ${emailNormalized} LIMIT 1
      `.execute(ctx.db);
      if (existing.rows[0]) {
        validationProblem(request, reply, "Email already registered");
        return;
      }

      const userId = generateUuidV7();
      const orgId = generateUuidV7();
      const workspaceId = generateUuidV7();
      const identityId = generateUuidV7();
      const passwordHash = await hashPassword(body.password);
      const orgSlug = uniqueSlug(slugify(body.email.split("@")[0] ?? "user"));

      await ctx.db.transaction().execute(async (trx) => {
        await sql`
          INSERT INTO core.users (id, email, email_normalized, display_name)
          VALUES (${userId}, ${body.email}, ${emailNormalized}, ${body.name})
        `.execute(trx);

        await sql`
          INSERT INTO core.organizations (id, name, slug, kind, created_by)
          VALUES (${orgId}, ${`${body.name}'s workspace`}, ${orgSlug}, 'personal', ${userId})
        `.execute(trx);

        await sql`
          INSERT INTO core.organization_members (org_id, user_id, role, source)
          VALUES (${orgId}, ${userId}, 'owner', 'org_creation')
        `.execute(trx);

        await sql`
          INSERT INTO core.user_identities (id, user_id, provider, subject, password_hash, password_changed_at)
          VALUES (${identityId}, ${userId}, 'password', ${emailNormalized}, ${passwordHash}, now())
        `.execute(trx);

        await sql`
          INSERT INTO core.workspaces (id, org_id, name, created_by)
          VALUES (${workspaceId}, ${orgId}, 'Home', ${userId})
        `.execute(trx);

        await sql`
          INSERT INTO core.workspace_directory (workspace_id, org_id, shard_id, region)
          VALUES (${workspaceId}, ${orgId}, ${ctx.defaultShardId}, 'local')
        `.execute(trx);

        await sql`
          INSERT INTO core.access_grants (
            id, org_id, resource_type, resource_id, workspace_id,
            principal_type, principal_id, role, source, granted_by
          ) VALUES (
            ${generateUuidV7()}, ${orgId}, 'workspace', ${workspaceId}, ${workspaceId},
            'user', ${userId}, 'owner', 'creator', ${userId}
          )
        `.execute(trx);

        await createFreeSubscriptionInTx(trx, orgId);
      });

      await createSession(ctx.db, userId, reply, ctx.env);

      await writeAuditEvent(ctx.db, {
        orgId,
        workspaceId,
        actorUserId: userId,
        action: "auth.signup",
        targetType: "user",
        targetId: userId,
        ip: request.ip,
        userAgent: request.headers["user-agent"] ?? null,
      });

      void reply.code(201).send({
        user: {
          id: pid("usr", userId),
          email: body.email,
          name: body.name,
        },
        organization: { id: pid("org", orgId), slug: orgSlug },
        workspace: { id: pid("wsp", workspaceId), name: "Home" },
      });
    } catch (err) {
      handleRouteError(request, reply, err);
    }
  });

  app.post("/v1/auth/login", async (request, reply) => {
    try {
      const body = loginBody.parse(request.body);
      const emailNormalized = body.email.toLowerCase();

      const userRow = await sql<{
        id: string;
        email: string;
        display_name: string;
        password_hash: string;
      }>`
        SELECT u.id, u.email, u.display_name, i.password_hash
        FROM core.users u
        INNER JOIN core.user_identities i ON i.user_id = u.id AND i.provider = 'password'
        WHERE u.email_normalized = ${emailNormalized} AND u.status = 'active'
        LIMIT 1
      `.execute(ctx.db);

      const user = userRow.rows[0];
      if (!user || !(await verifyPassword(body.password, user.password_hash))) {
        validationProblem(request, reply, "Invalid email or password");
        return;
      }

      await sql`
        UPDATE core.users SET last_login_at = now(), updated_at = now() WHERE id = ${user.id}
      `.execute(ctx.db);

      await createSession(ctx.db, user.id, reply, ctx.env);

      const loginOrg = await sql<{ org_id: string }>`
        SELECT org_id FROM core.organization_members
        WHERE user_id = ${user.id} AND status = 'active'
        ORDER BY joined_at ASC
        LIMIT 1
      `.execute(ctx.db);

      await writeAuditEvent(ctx.db, {
        orgId: loginOrg.rows[0]?.org_id ?? null,
        actorUserId: user.id,
        action: "auth.login",
        targetType: "user",
        targetId: user.id,
        ip: request.ip,
        userAgent: request.headers["user-agent"] ?? null,
      });

      void reply.send({
        user: {
          id: pid("usr", user.id),
          email: user.email,
          name: user.display_name,
        },
      });
    } catch (err) {
      handleRouteError(request, reply, err);
    }
  });

  app.post("/v1/auth/logout", async (request, reply) => {
    try {
      if (request.user) {
        await revokeSession(ctx.db, request.user.sessionId);
      }
      clearSessionCookie(reply, ctx.env);
      void reply.send({ ok: true });
    } catch (err) {
      handleRouteError(request, reply, err);
    }
  });

  app.post("/v1/auth/ws-ticket", async (request, reply) => {
    try {
      if (!request.user) {
        notFound(request, reply, "Not authenticated");
        return;
      }
      const ticket = generateWsTicket();
      await storeWsTicket(ctx.redis, wsTicketSecret(ctx.env), ticket, {
        userId: request.user.id,
        sessionId: request.user.sessionId,
        issuedAt: Date.now(),
      });
      const expiresAt = new Date(Date.now() + 30_000).toISOString();
      void reply.send({
        ticket,
        expiresAt,
        url: `ws://127.0.0.1:${ctx.env.REALTIME_PORT}/v1/ws`,
      });
    } catch (err) {
      handleRouteError(request, reply, err);
    }
  });

  app.get("/v1/auth/me", async (request, reply) => {
    try {
      if (!request.user) {
        notFound(request, reply, "Not authenticated");
        return;
      }
      void reply.send({
        user: {
          id: pid("usr", request.user.id),
          email: request.user.email,
          name: request.user.displayName,
        },
      });
    } catch (err) {
      handleRouteError(request, reply, err);
    }
  });

  const mfaEnableBody = z.object({
    code: z.string().min(6).max(8),
  });

  app.post("/v1/auth/mfa/setup", async (request, reply) => {
    try {
      if (!request.user) {
        notFound(request, reply, "Not authenticated");
        return;
      }
      const bundle = generateTotpSecret(request.user.email);
      setPendingMfaSecret(request.user.id, bundle.secret);
      void reply.send({
        secret: bundle.secret,
        otpauthUrl: bundle.otpauthUrl,
      });
    } catch (err) {
      handleRouteError(request, reply, err);
    }
  });

  app.post("/v1/auth/mfa/enable", async (request, reply) => {
    try {
      if (!request.user) {
        notFound(request, reply, "Not authenticated");
        return;
      }
      const body = mfaEnableBody.parse(request.body);
      const pendingSecret = takePendingMfaSecret(request.user.id);
      if (!pendingSecret || !verifyTotp(pendingSecret, body.code)) {
        validationProblem(request, reply, "Invalid verification code");
        return;
      }

      const encKeyRaw = ctx.env.MFA_ENCRYPTION_KEY ?? ctx.env.SESSION_SECRET;
      const encKey = mfaKeyFromEnv(encKeyRaw);
      const ciphertext = encryptMfaSecret(pendingSecret, encKey);
      const factorId = generateUuidV7();

      try {
        await sql`
          INSERT INTO core.user_mfa_factors (
            id, user_id, kind, secret_ciphertext, confirmed_at
          ) VALUES (
            ${factorId}, ${request.user.id}, 'totp', ${ciphertext}, now()
          )
        `.execute(ctx.db);
      } catch {
        // TODO: require migration 0006_mfa_invites.sql for durable MFA storage
        await sql`
          UPDATE core.user_identities
          SET profile = profile || ${JSON.stringify({ mfa_totp_enabled: true })}::jsonb,
              updated_at = now()
          WHERE user_id = ${request.user.id} AND provider = 'password'
        `.execute(ctx.db);
      }

      await writeAuditEvent(ctx.db, {
        actorUserId: request.user.id,
        action: "auth.mfa_enabled",
        targetType: "user",
        targetId: request.user.id,
        ip: request.ip,
        userAgent: request.headers["user-agent"] ?? null,
      });

      void reply.send({ ok: true });
    } catch (err) {
      handleRouteError(request, reply, err);
    }
  });

  if (googleOAuthEnabled(ctx.env)) {
    app.get("/v1/auth/google", async (_request, reply) => {
      const state = createOAuthState();
      const url = googleAuthorizeUrl(ctx.env, state);
      void reply.redirect(url);
    });

    app.get("/v1/auth/google/callback", async (request, reply) => {
      try {
        const query = request.query as { code?: string; state?: string };
        if (!query.code || !query.state || !consumeOAuthState(query.state)) {
          validationProblem(request, reply, "Invalid OAuth state");
          return;
        }

        const { accessToken } = await exchangeGoogleCode(ctx.env, query.code);
        const profile = await fetchGoogleProfile(accessToken);
        const emailNormalized = profile.email.toLowerCase();

        let userId: string | undefined;
        const existingIdentity = await sql<{ user_id: string }>`
          SELECT user_id FROM core.user_identities
          WHERE provider = 'google' AND subject = ${profile.sub}
          LIMIT 1
        `.execute(ctx.db);

        if (existingIdentity.rows[0]) {
          userId = existingIdentity.rows[0].user_id;
        } else {
          const byEmail = await sql<{ id: string }>`
            SELECT id FROM core.users WHERE email_normalized = ${emailNormalized} LIMIT 1
          `.execute(ctx.db);
          if (byEmail.rows[0]) {
            userId = byEmail.rows[0].id;
            await sql`
              INSERT INTO core.user_identities (id, user_id, provider, subject, email_at_provider)
              VALUES (${generateUuidV7()}, ${userId}, 'google', ${profile.sub}, ${profile.email})
            `.execute(ctx.db);
          }
        }

        if (!userId) {
          validationProblem(
            request,
            reply,
            "No account for this Google user; sign up with email first",
          );
          return;
        }

        await createSession(ctx.db, userId, reply, ctx.env);
        await writeAuditEvent(ctx.db, {
          actorUserId: userId,
          action: "auth.login",
          targetType: "user",
          targetId: userId,
          metadata: { provider: "google" },
          ip: request.ip,
          userAgent: request.headers["user-agent"] ?? null,
        });

        void reply.redirect(`${ctx.env.APP_URL}/`);
      } catch (err) {
        handleRouteError(request, reply, err);
      }
    });
  }
}
