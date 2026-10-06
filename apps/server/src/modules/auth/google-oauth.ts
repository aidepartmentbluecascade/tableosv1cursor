import { randomBytes } from "node:crypto";
import type { Env } from "@tabula/config";
import type { TabulaDb } from "@tabula/db";
import { safeFetch } from "../../lib/http-egress.js";
import { consumeChallenge, createChallenge, findChallenge } from "./challenges.js";

const GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO = "https://www.googleapis.com/oauth2/v3/userinfo";

export function googleOAuthEnabled(env: Env): boolean {
  return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
}

/** OAuth `state` is persisted in core.auth_challenges (not process memory). */
export async function createOAuthState(db: TabulaDb): Promise<string> {
  const state = randomBytes(24).toString("base64url");
  await createChallenge(db, "oauth_state", { ttlMs: 600_000, token: state });
  return state;
}

export async function consumeOAuthState(db: TabulaDb, state: string): Promise<boolean> {
  const row = await findChallenge(db, "oauth_state", state);
  if (!row) return false;
  return consumeChallenge(db, row.id);
}

export function googleAuthorizeUrl(env: Env, state: string): string {
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID!,
    redirect_uri: `${env.API_URL}/v1/auth/google/callback`,
    response_type: "code",
    scope: "openid email profile",
    state,
    access_type: "online",
    prompt: "select_account",
  });
  return `${GOOGLE_AUTH}?${params.toString()}`;
}

export async function exchangeGoogleCode(
  env: Env,
  code: string,
): Promise<{ accessToken: string }> {
  const body = new URLSearchParams({
    code,
    client_id: env.GOOGLE_CLIENT_ID!,
    client_secret: env.GOOGLE_CLIENT_SECRET!,
    redirect_uri: `${env.API_URL}/v1/auth/google/callback`,
    grant_type: "authorization_code",
  });
  const res = await safeFetch(GOOGLE_TOKEN, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    throw new Error("GOOGLE_TOKEN_EXCHANGE_FAILED");
  }
  const json = (await res.json()) as { access_token?: string };
  if (!json.access_token) {
    throw new Error("GOOGLE_TOKEN_EXCHANGE_FAILED");
  }
  return { accessToken: json.access_token };
}

export async function fetchGoogleProfile(accessToken: string): Promise<{
  sub: string;
  email: string;
  name: string;
  emailVerified: boolean;
}> {
  const res = await safeFetch(GOOGLE_USERINFO, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error("GOOGLE_USERINFO_FAILED");
  }
  const json = (await res.json()) as {
    sub?: string;
    email?: string;
    name?: string;
    email_verified?: boolean | string;
  };
  if (!json.sub || !json.email) {
    throw new Error("GOOGLE_USERINFO_FAILED");
  }
  return {
    sub: json.sub,
    email: json.email,
    name: json.name ?? json.email,
    emailVerified: json.email_verified === true || json.email_verified === "true",
  };
}
