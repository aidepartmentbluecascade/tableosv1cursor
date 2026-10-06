import {
  SESSION_COOKIE_NAME,
  encryptMfaSecret,
  generateTotpSecret,
  hashPassword,
  verifyPassword,
  verifyTotp,
} from "@tabula/auth";
import { generateUuidV7 } from "@tabula/types";
import { sql } from "kysely";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppContext } from "../../lib/app-context.js";
import { pid } from "../../lib/public-ids.js";
import { slugify, uniqueSlug } from "../../lib/slug.js";
import {
  handleRouteError,
  notFound,
  sendApiError,
  unauthorized,
  validationProblem,
} from "../../http/errors.js";
import {
  clearSessionCookie,
  createSession,
  revokeSession,
  revokeSessionByToken,
} from "./session.js";
import {
  clearPendingMfaSecret,
  getConfirmedMfaSecret,
  getPendingMfaSecret,
  mfaKey,
  setPendingMfaSecret,
  userHasMfa,
} from "./mfa-pending.js";
import {
  consumeOAuthState,
  createOAuthState,
  exchangeGoogleCode,
  fetchGoogleProfile,
  googleAuthorizeUrl,
  googleOAuthEnabled,
} from "./google-oauth.js";
import {
  bumpChallengeAttempts,
  consumeChallenge,
  createChallenge,
  findChallenge,
} from "./challenges.js";
import { AuthRateLimiter } from "./rate-limit.js";
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

const mfaVerifyBody = z.object({
  mfaToken: z.string().min(16).max(200),
  code: z.string().min(6).max(10),
});

const mfaEnableBody = z.object({
  code: z.string().min(6).max(10),
});

const mfaDisableBody = z.object({
  code: z.string().min(6).max(10).optional(),
  password: z.string().min(1).max(128).optional(),
});

const passwordChangeBody = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: z.string().min(8).max(128),
});

const profileBody = z.object({
  name: z.string().trim().min(1).max(200),
});

/** Login attempts: per email+ip and per ip, within a 15 minute window. */
const LOGIN_WINDOW_SEC = 15 * 60;
const LOGIN_MAX_PER_ACCOUNT = 10;
const LOGIN_MAX_PER_IP = 50;
const MFA_MAX_ATTEMPTS = 5;
const MFA_LOGIN_TTL_MS = 5 * 60 * 1000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function clientMeta(request: FastifyRequest): { ip: string | null; userAgent: string | null } {
  return {
    ip: request.ip ?? null,
    userAgent: (request.headers["user-agent"] as string | undefined) ?? null,
  };
}

function rateLimited(request: FastifyRequest, reply: FastifyReply, retryAfterSec: number): void {
  void reply.header("retry-after", String(retryAfterSec));
  sendApiError(
    request,
    reply,
    429,
    "RATE_LIMITED",
    `Too many sign-in attempts. Try again in ${Math.ceil(retryAfterSec / 60)} minute(s).`,
  );
}

async function primaryOrgId(ctx: AppContext, userId: string): Promise<string | null> {
  const res = await sql<{ org_id: string }>`
    SELECT org_id FROM core.organization_members
    WHERE user_id = ${userId} AND status = 'active'
    ORDER BY joined_at ASC
    LIMIT 1
  `.execute(ctx.db);
  return res.rows[0]?.org_id ?? null;
}

export async function registerAuthRoutes(
  app: FastifyInstance,
  ctx: AppContext,
): Promise<void> {
  const limiter = new AuthRateLimiter(ctx.redis);

  app.post("/v1/auth/signup", async (request, reply) => {
    try {
      const body = signupBody.parse(request.body);
      const emailNormalized = body.email.toLowerCase();

      const ipHit = await limiter.hit(`signup:ip:${request.ip}`, 30, 3600);
      if (!ipHit.allowed) {
        rateLimited(request, reply, ipHit.retryAfterSec);
        return;
      }

      const existing = await sql<{ id: string }>`
        SELECT id FROM core.users WHERE email_normalized = ${emailNormalized} LIMIT 1
      `.execute(ctx.db);
      if (existing.rows[0]) {
        sendApiError(request, reply, 409, "CONFLICT", "Email already registered");
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

      await createSession(ctx.db, userId, reply, ctx.env, clientMeta(request));

      await writeAuditEvent(ctx.db, {
        orgId,
        workspaceId,
        actorUserId: userId,
        action: "auth.signup",
        targetType: "user",
        targetId: userId,
        ...clientMeta(request),
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

  /**
   * Password login. When the account has MFA enabled, no session is created;
   * the response is `200 { mfaRequired: true, mfaToken }` and the client must
   * call `POST /v1/auth/mfa/verify { mfaToken, code }` to finish signing in.
   */
  app.post("/v1/auth/login", async (request, reply) => {
    try {
      const body = loginBody.parse(request.body);
      const emailNormalized = body.email.toLowerCase();
      const accountKey = `login:acct:${emailNormalized}:${request.ip}`;
      const ipKey = `login:ip:${request.ip}`;

      const [acct, ip] = await Promise.all([
        limiter.peek(accountKey, LOGIN_MAX_PER_ACCOUNT),
        limiter.peek(ipKey, LOGIN_MAX_PER_IP),
      ]);
      if (!acct.allowed || !ip.allowed) {
        rateLimited(request, reply, Math.max(acct.allowed ? 0 : acct.retryAfterSec, ip.allowed ? 0 : ip.retryAfterSec));
        return;
      }

      const userRow = await sql<{
        id: string;
        email: string;
        display_name: string;
        password_hash: string | null;
      }>`
        SELECT u.id, u.email, u.display_name, i.password_hash
        FROM core.users u
        INNER JOIN core.user_identities i ON i.user_id = u.id AND i.provider = 'password'
        WHERE u.email_normalized = ${emailNormalized} AND u.status = 'active'
        LIMIT 1
      `.execute(ctx.db);

      const user = userRow.rows[0];
      if (!user || !user.password_hash || !(await verifyPassword(body.password, user.password_hash))) {
        await Promise.all([
          limiter.hit(accountKey, LOGIN_MAX_PER_ACCOUNT, LOGIN_WINDOW_SEC),
          limiter.hit(ipKey, LOGIN_MAX_PER_IP, LOGIN_WINDOW_SEC),
        ]);
        if (user) {
          await writeAuditEvent(ctx.db, {
            orgId: await primaryOrgId(ctx, user.id),
            actorUserId: user.id,
            action: "auth.login_failed",
            targetType: "user",
            targetId: user.id,
            ...clientMeta(request),
          });
        }
        sendApiError(request, reply, 401, "UNAUTHENTICATED", "Invalid email or password");
        return;
      }
      await limiter.reset(accountKey);

      if (await userHasMfa(ctx.db, user.id)) {
        const mfaToken = await createChallenge(ctx.db, "mfa_login", {
          userId: user.id,
          data: { method: "password" },
          ttlMs: MFA_LOGIN_TTL_MS,
        });
        void reply.send({ mfaRequired: true, mfaToken });
        return;
      }

      await completeLogin(request, reply, user.id, "password", "none");
    } catch (err) {
      handleRouteError(request, reply, err);
    }
  });

  async function completeLogin(
    request: FastifyRequest,
    reply: FastifyReply,
    userId: string,
    method: "password" | "oauth",
    mfaLevel: "none" | "mfa",
    redirectTo?: string,
  ): Promise<void> {
    await sql`
      UPDATE core.users SET last_login_at = now(), updated_at = now() WHERE id = ${userId}
    `.execute(ctx.db);
    await createSession(ctx.db, userId, reply, ctx.env, {
      authMethod: method,
      mfaLevel,
      ...clientMeta(request),
    });
    await writeAuditEvent(ctx.db, {
      orgId: await primaryOrgId(ctx, userId),
      actorUserId: userId,
      action: "auth.login",
      targetType: "user",
      targetId: userId,
      metadata: { method, mfa: mfaLevel === "mfa" },
      ...clientMeta(request),
    });
    if (redirectTo) {
      void reply.redirect(redirectTo);
      return;
    }
    const u = await sql<{ email: string; display_name: string }>`
      SELECT email, display_name FROM core.users WHERE id = ${userId}
    `.execute(ctx.db);
    void reply.send({
      user: {
        id: pid("usr", userId),
        email: u.rows[0]?.email ?? "",
        name: u.rows[0]?.display_name ?? "",
      },
    });
  }

  /** Second login step for MFA-enabled accounts. */
  app.post("/v1/auth/mfa/verify", async (request, reply) => {
    try {
      const body = mfaVerifyBody.parse(request.body);
      const challenge = await findChallenge(ctx.db, "mfa_login", body.mfaToken);
      if (!challenge || !challenge.user_id) {
        sendApiError(request, reply, 401, "UNAUTHENTICATED", "Sign-in expired. Enter your password again.");
        return;
      }
      if (challenge.attempts >= MFA_MAX_ATTEMPTS) {
        await consumeChallenge(ctx.db, challenge.id);
        rateLimited(request, reply, 60);
        return;
      }
      const secret = await getConfirmedMfaSecret(ctx.db, ctx.env, challenge.user_id);
      if (!secret || !verifyTotp(secret, body.code)) {
        const attempts = await bumpChallengeAttempts(ctx.db, challenge.id);
        sendApiError(
          request,
          reply,
          401,
          "UNAUTHENTICATED",
          attempts >= MFA_MAX_ATTEMPTS
            ? "Too many invalid codes. Sign in again."
            : "Invalid authentication code",
        );
        return;
      }
      if (!(await consumeChallenge(ctx.db, challenge.id))) {
        sendApiError(request, reply, 401, "UNAUTHENTICATED", "Sign-in expired. Enter your password again.");
        return;
      }
      const method = challenge.data["method"] === "oauth" ? "oauth" : "password";
      await completeLogin(request, reply, challenge.user_id, method, "mfa");
    } catch (err) {
      handleRouteError(request, reply, err);
    }
  });

  /** Public: revokes the cookie's session (if any) and always clears the cookie. */
  app.post("/v1/auth/logout", async (request, reply) => {
    try {
      const token = request.cookies[SESSION_COOKIE_NAME];
      if (token) {
        await revokeSessionByToken(ctx.db, token);
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
        unauthorized(request, reply);
        return;
      }
      const ticket = generateWsTicket();
      await storeWsTicket(ctx.redis, wsTicketSecret(ctx.env), ticket, {
        userId: request.user.id,
        sessionId: request.user.sessionId,
        issuedAt: Date.now(),
      });
      const expiresAt = new Date(Date.now() + 30_000).toISOString();
      const url =
        process.env["REALTIME_PUBLIC_URL"] ??
        `ws://127.0.0.1:${ctx.env.REALTIME_PORT}/v1/ws`;
      void reply.send({ ticket, expiresAt, url });
    } catch (err) {
      handleRouteError(request, reply, err);
    }
  });

  app.get("/v1/auth/me", async (request, reply) => {
    try {
      if (!request.user) {
        unauthorized(request, reply);
        return;
      }
      const mfa = await userHasMfa(ctx.db, request.user.id);
      const hasPassword = await sql<{ n: number }>`
        SELECT 1 AS n FROM core.user_identities
        WHERE user_id = ${request.user.id} AND provider = 'password' AND password_hash IS NOT NULL
        LIMIT 1
      `.execute(ctx.db);
      void reply.send({
        user: {
          id: pid("usr", request.user.id),
          email: request.user.email,
          name: request.user.displayName,
          mfaEnabled: mfa,
          hasPassword: hasPassword.rows.length > 0,
        },
      });
    } catch (err) {
      handleRouteError(request, reply, err);
    }
  });

  /** Update profile (display name). */
  app.patch("/v1/auth/me", async (request, reply) => {
    try {
      if (!request.user) {
        unauthorized(request, reply);
        return;
      }
      const body = profileBody.parse(request.body);
      await sql`
        UPDATE core.users SET display_name = ${body.name}, updated_at = now()
        WHERE id = ${request.user.id}
      `.execute(ctx.db);
      void reply.send({
        user: {
          id: pid("usr", request.user.id),
          email: request.user.email,
          name: body.name,
        },
      });
    } catch (err) {
      handleRouteError(request, reply, err);
    }
  });

  /** Change password; revokes every other session of the user. */
  app.post("/v1/auth/password", async (request, reply) => {
    try {
      if (!request.user) {
        unauthorized(request, reply);
        return;
      }
      const body = passwordChangeBody.parse(request.body);
      const rlKey = `pwchange:${request.user.id}`;
      const rl = await limiter.peek(rlKey, 10);
      if (!rl.allowed) {
        rateLimited(request, reply, rl.retryAfterSec);
        return;
      }
      const identity = await sql<{ id: string; password_hash: string | null }>`
        SELECT id, password_hash FROM core.user_identities
        WHERE user_id = ${request.user.id} AND provider = 'password'
        LIMIT 1
      `.execute(ctx.db);
      const row = identity.rows[0];
      if (!row || !row.password_hash || !(await verifyPassword(body.currentPassword, row.password_hash))) {
        await limiter.hit(rlKey, 10, 900);
        validationProblem(request, reply, "Current password is incorrect", [
          { field: "currentPassword", message: "Current password is incorrect" },
        ]);
        return;
      }
      const newHash = await hashPassword(body.newPassword);
      await sql`
        UPDATE core.user_identities
        SET password_hash = ${newHash}, password_changed_at = now(), updated_at = now()
        WHERE id = ${row.id}
      `.execute(ctx.db);
      const revoked = await sql`
        UPDATE core.sessions SET revoked_at = now()
        WHERE user_id = ${request.user.id} AND id <> ${request.user.sessionId}
          AND revoked_at IS NULL AND auth_method <> 'automation'
      `.execute(ctx.db);
      await writeAuditEvent(ctx.db, {
        orgId: await primaryOrgId(ctx, request.user.id),
        actorUserId: request.user.id,
        action: "auth.password_changed",
        targetType: "user",
        targetId: request.user.id,
        metadata: { otherSessionsRevoked: Number(revoked.numAffectedRows ?? 0n) },
        ...clientMeta(request),
      });
      void reply.send({ ok: true, otherSessionsRevoked: Number(revoked.numAffectedRows ?? 0n) });
    } catch (err) {
      handleRouteError(request, reply, err);
    }
  });

  /** Active sessions of the current user. */
  app.get("/v1/auth/sessions", async (request, reply) => {
    try {
      if (!request.user) {
        unauthorized(request, reply);
        return;
      }
      const res = await sql<{
        id: string;
        auth_method: string;
        mfa_level: string;
        ip: string | null;
        user_agent: string | null;
        created_at: Date;
        last_seen_at: Date;
        expires_at: Date;
      }>`
        SELECT id, auth_method, mfa_level, host(ip) AS ip, user_agent, created_at, last_seen_at, expires_at
        FROM core.sessions
        WHERE user_id = ${request.user.id}
          AND revoked_at IS NULL
          AND expires_at > now()
          AND idle_expires_at > now()
          AND auth_method <> 'automation'
        ORDER BY last_seen_at DESC
      `.execute(ctx.db);
      void reply.send({
        sessions: res.rows.map((s) => ({
          id: s.id,
          current: s.id === request.user!.sessionId,
          authMethod: s.auth_method,
          mfa: s.mfa_level !== "none",
          ip: s.ip,
          userAgent: s.user_agent,
          createdAt: s.created_at.toISOString(),
          lastSeenAt: s.last_seen_at.toISOString(),
          expiresAt: s.expires_at.toISOString(),
        })),
      });
    } catch (err) {
      handleRouteError(request, reply, err);
    }
  });

  app.delete<{ Params: { sessionId: string } }>(
    "/v1/auth/sessions/:sessionId",
    async (request, reply) => {
      try {
        if (!request.user) {
          unauthorized(request, reply);
          return;
        }
        const { sessionId } = request.params;
        if (!UUID_RE.test(sessionId)) {
          validationProblem(request, reply, "Invalid session id");
          return;
        }
        const res = await sql`
          UPDATE core.sessions SET revoked_at = now()
          WHERE id = ${sessionId} AND user_id = ${request.user.id} AND revoked_at IS NULL
        `.execute(ctx.db);
        if (Number(res.numAffectedRows ?? 0n) === 0) {
          notFound(request, reply, "Session not found");
          return;
        }
        if (sessionId === request.user.sessionId) {
          clearSessionCookie(reply, ctx.env);
        }
        await writeAuditEvent(ctx.db, {
          actorUserId: request.user.id,
          action: "auth.session_revoked",
          targetType: "session",
          targetId: sessionId,
          ...clientMeta(request),
        });
        void reply.code(204).send();
      } catch (err) {
        handleRouteError(request, reply, err);
      }
    },
  );

  /** Sign out everywhere else. */
  app.post("/v1/auth/sessions/revoke-others", async (request, reply) => {
    try {
      if (!request.user) {
        unauthorized(request, reply);
        return;
      }
      const res = await sql`
        UPDATE core.sessions SET revoked_at = now()
        WHERE user_id = ${request.user.id} AND id <> ${request.user.sessionId}
          AND revoked_at IS NULL AND auth_method <> 'automation'
      `.execute(ctx.db);
      void reply.send({ revoked: Number(res.numAffectedRows ?? 0n) });
    } catch (err) {
      handleRouteError(request, reply, err);
    }
  });

  app.get("/v1/auth/mfa", async (request, reply) => {
    try {
      if (!request.user) {
        unauthorized(request, reply);
        return;
      }
      void reply.send({ enabled: await userHasMfa(ctx.db, request.user.id) });
    } catch (err) {
      handleRouteError(request, reply, err);
    }
  });

  app.post("/v1/auth/mfa/setup", async (request, reply) => {
    try {
      if (!request.user) {
        unauthorized(request, reply);
        return;
      }
      if (await userHasMfa(ctx.db, request.user.id)) {
        sendApiError(request, reply, 409, "CONFLICT", "Two-factor authentication is already enabled");
        return;
      }
      const bundle = generateTotpSecret(request.user.email);
      await setPendingMfaSecret(ctx.db, ctx.env, request.user.id, bundle.secret);
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
        unauthorized(request, reply);
        return;
      }
      const body = mfaEnableBody.parse(request.body);
      const pending = await getPendingMfaSecret(ctx.db, ctx.env, request.user.id);
      if (!pending) {
        validationProblem(request, reply, "Setup expired. Start two-factor setup again.");
        return;
      }
      if (!verifyTotp(pending.secret, body.code)) {
        validationProblem(request, reply, "Invalid verification code", [
          { field: "code", message: "Invalid verification code" },
        ]);
        return;
      }

      const ciphertext = encryptMfaSecret(pending.secret, mfaKey(ctx.env));
      await ctx.db.transaction().execute(async (trx) => {
        await sql`
          DELETE FROM core.user_mfa_factors WHERE user_id = ${request.user!.id} AND kind = 'totp'
        `.execute(trx);
        await sql`
          INSERT INTO core.user_mfa_factors (id, user_id, kind, secret_ciphertext, confirmed_at)
          VALUES (${generateUuidV7()}, ${request.user!.id}, 'totp', ${ciphertext}, now())
        `.execute(trx);
        await sql`
          UPDATE core.sessions SET mfa_level = 'mfa' WHERE id = ${request.user!.sessionId}
        `.execute(trx);
      });
      await clearPendingMfaSecret(ctx.db, pending.id);

      await writeAuditEvent(ctx.db, {
        orgId: await primaryOrgId(ctx, request.user.id),
        actorUserId: request.user.id,
        action: "auth.mfa_enabled",
        targetType: "user",
        targetId: request.user.id,
        ...clientMeta(request),
      });

      void reply.send({ ok: true, enabled: true });
    } catch (err) {
      handleRouteError(request, reply, err);
    }
  });

  /** Disable MFA — requires a current TOTP code or the account password. */
  app.post("/v1/auth/mfa/disable", async (request, reply) => {
    try {
      if (!request.user) {
        unauthorized(request, reply);
        return;
      }
      const body = mfaDisableBody.parse(request.body ?? {});
      const secret = await getConfirmedMfaSecret(ctx.db, ctx.env, request.user.id);
      if (!secret) {
        void reply.send({ ok: true, enabled: false });
        return;
      }
      let ok = false;
      if (body.code) {
        ok = verifyTotp(secret, body.code);
      } else if (body.password) {
        const identity = await sql<{ password_hash: string | null }>`
          SELECT password_hash FROM core.user_identities
          WHERE user_id = ${request.user.id} AND provider = 'password' LIMIT 1
        `.execute(ctx.db);
        const hash = identity.rows[0]?.password_hash;
        ok = Boolean(hash) && (await verifyPassword(body.password, hash!));
      }
      if (!ok) {
        validationProblem(request, reply, "Enter a valid authentication code or your password");
        return;
      }
      await sql`
        DELETE FROM core.user_mfa_factors WHERE user_id = ${request.user.id}
      `.execute(ctx.db);
      await writeAuditEvent(ctx.db, {
        orgId: await primaryOrgId(ctx, request.user.id),
        actorUserId: request.user.id,
        action: "auth.mfa_disabled",
        targetType: "user",
        targetId: request.user.id,
        ...clientMeta(request),
      });
      void reply.send({ ok: true, enabled: false });
    } catch (err) {
      handleRouteError(request, reply, err);
    }
  });

  if (googleOAuthEnabled(ctx.env)) {
    app.get("/v1/auth/google", async (request, reply) => {
      try {
        const state = await createOAuthState(ctx.db);
        const url = googleAuthorizeUrl(ctx.env, state);
        void reply.redirect(url);
      } catch (err) {
        handleRouteError(request, reply, err);
      }
    });

    app.get("/v1/auth/google/callback", async (request, reply) => {
      try {
        const query = request.query as { code?: string; state?: string };
        if (!query.code || !query.state || !(await consumeOAuthState(ctx.db, query.state))) {
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
          // Linking by email is only safe when Google has verified the address;
          // otherwise anyone could claim an existing account's email.
          if (!profile.emailVerified) {
            void reply.redirect(
              `${ctx.env.APP_URL}/login?error=${encodeURIComponent("google_email_unverified")}`,
            );
            return;
          }
          const byEmail = await sql<{ id: string }>`
            SELECT id FROM core.users WHERE email_normalized = ${emailNormalized} AND status = 'active' LIMIT 1
          `.execute(ctx.db);
          if (byEmail.rows[0]) {
            userId = byEmail.rows[0].id;
            await sql`
              INSERT INTO core.user_identities (id, user_id, provider, subject, email_at_provider)
              VALUES (${generateUuidV7()}, ${userId}, 'google', ${profile.sub}, ${profile.email})
            `.execute(ctx.db);
            await writeAuditEvent(ctx.db, {
              actorUserId: userId,
              action: "auth.identity_linked",
              targetType: "user",
              targetId: userId,
              metadata: { provider: "google" },
              ...clientMeta(request),
            });
          }
        }

        if (!userId) {
          void reply.redirect(
            `${ctx.env.APP_URL}/signup?error=${encodeURIComponent("google_no_account")}`,
          );
          return;
        }

        if (await userHasMfa(ctx.db, userId)) {
          const mfaToken = await createChallenge(ctx.db, "mfa_login", {
            userId,
            data: { method: "oauth" },
            ttlMs: MFA_LOGIN_TTL_MS,
          });
          void reply.redirect(`${ctx.env.APP_URL}/login?mfaToken=${encodeURIComponent(mfaToken)}`);
          return;
        }

        await completeLogin(request, reply, userId, "oauth", "none", `${ctx.env.APP_URL}/`);
      } catch (err) {
        handleRouteError(request, reply, err);
      }
    });
  }

  // Keep the exported helper referenced for callers that revoke by id.
  void revokeSession;
}
