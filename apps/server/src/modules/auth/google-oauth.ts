import { randomBytes } from "node:crypto";
import type { Env } from "@tabula/config";
import { safeFetch } from "../../lib/http-egress.js";

const GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO = "https://www.googleapis.com/oauth2/v3/userinfo";

const pendingStates = new Map<string, number>();

export function googleOAuthEnabled(env: Env): boolean {
  return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
}

export function createOAuthState(): string {
  const state = randomBytes(16).toString("base64url");
  pendingStates.set(state, Date.now() + 600_000);
  return state;
}

export function consumeOAuthState(state: string): boolean {
  const exp = pendingStates.get(state);
  pendingStates.delete(state);
  return exp !== undefined && exp > Date.now();
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
  };
  if (!json.sub || !json.email) {
    throw new Error("GOOGLE_USERINFO_FAILED");
  }
  return { sub: json.sub, email: json.email, name: json.name ?? json.email };
}
