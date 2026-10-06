import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { resolve } from "node:path";
import { loadEnv } from "@tabula/config";
import { createDb } from "@tabula/db";
import {
  PROTOCOL_VERSION,
  safeParseClientMessage,
  type ServerMessage,
} from "@tabula/realtime-protocol";
import { createLogger } from "@tabula/observability";
import { sql } from "kysely";
import type { Redis } from "ioredis";
import { WebSocketServer, type WebSocket } from "ws";
import {
  parseRealtimeChangePayload,
  realtimeBaseChannel,
} from "../kernel/realtime-fanout.js";
import { connectRedis } from "../lib/redis.js";
import { parsePid, pid } from "../lib/public-ids.js";
import { compileForUser } from "../modules/access/compile.js";
import { assertCan } from "../modules/access/assert.js";
import { resolveBaseContext, resolveTableContext } from "../modules/access/helpers.js";
import { consumeWsTicket } from "../modules/auth/ws-ticket.js";
import {
  applyRecordFieldUpdate,
  RecordFieldUpdateError,
} from "../modules/records/apply-field-update.js";
import type { MutationActor } from "../kernel/mutation.js";

const HEARTBEAT_MS = 25_000;
const PRESENCE_TTL_SECONDS = 60;

const rootEnv = resolve(process.cwd(), "../../.env");
const localEnv = resolve(process.cwd(), ".env");
if (existsSync(rootEnv)) {
  process.loadEnvFile(rootEnv);
} else if (existsSync(localEnv)) {
  process.loadEnvFile(localEnv);
}

interface ConnectionState {
  ws: WebSocket;
  userId?: string;
  sessionId?: string;
  authed: boolean;
  subscribedBases: Set<string>;
}

const baseSubscribers = new Map<string, Set<WebSocket>>();
const socketState = new WeakMap<WebSocket, ConnectionState>();
const redisChannelRefCount = new Map<string, number>();

function wsTicketSecret(env: ReturnType<typeof loadEnv>): string {
  return env.WS_TICKET_SECRET ?? env.SESSION_SECRET;
}

function sendMessage(ws: WebSocket, message: ServerMessage): void {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

function addBaseSubscriber(baseId: string, ws: WebSocket): void {
  let set = baseSubscribers.get(baseId);
  if (!set) {
    set = new Set();
    baseSubscribers.set(baseId, set);
  }
  set.add(ws);
}

function removeBaseSubscriber(baseId: string, ws: WebSocket): void {
  const set = baseSubscribers.get(baseId);
  if (!set) {
    return;
  }
  set.delete(ws);
  if (set.size === 0) {
    baseSubscribers.delete(baseId);
  }
}

function broadcastToBase(
  baseId: string,
  message: ServerMessage,
  except?: WebSocket,
): void {
  const set = baseSubscribers.get(baseId);
  if (!set) {
    return;
  }
  const payload = JSON.stringify(message);
  for (const client of set) {
    if (client !== except && client.readyState === client.OPEN) {
      client.send(payload);
    }
  }
}

async function ensureRedisChannelSubscribed(
  redis: Redis,
  sub: Redis,
  baseId: string,
): Promise<void> {
  const channel = realtimeBaseChannel(baseId);
  const count = redisChannelRefCount.get(channel) ?? 0;
  redisChannelRefCount.set(channel, count + 1);
  if (count === 0) {
    await sub.subscribe(channel);
  }
}

async function releaseRedisChannel(
  sub: Redis,
  baseId: string,
): Promise<void> {
  const channel = realtimeBaseChannel(baseId);
  const count = redisChannelRefCount.get(channel) ?? 0;
  if (count <= 1) {
    redisChannelRefCount.delete(channel);
    await sub.unsubscribe(channel);
  } else {
    redisChannelRefCount.set(channel, count - 1);
  }
}

async function loadHeadSeq(
  db: ReturnType<typeof createDb>,
  baseId: string,
): Promise<number> {
  const row = await sql<{ change_seq: string }>`
    SELECT change_seq FROM data.base_runtime WHERE base_id = ${baseId} LIMIT 1
  `.execute(db);
  return Number(row.rows[0]?.change_seq ?? 0);
}

async function sendCatchUpChanges(
  db: ReturnType<typeof createDb>,
  ws: WebSocket,
  baseId: string,
  afterSeq: number,
): Promise<void> {
  const rows = await sql<{
    seq: string;
    ops: unknown;
    actor_type: string;
    actor_id: string | null;
  }>`
    SELECT seq, ops, actor_type, actor_id
    FROM data.base_changes
    WHERE base_id = ${baseId} AND seq > ${afterSeq}
    ORDER BY seq ASC
    LIMIT 500
  `.execute(db);

  for (const row of rows.rows) {
    sendMessage(ws, {
      type: "change",
      baseId: pid("bas", baseId),
      seq: Number(row.seq),
      ops: Array.isArray(row.ops) ? row.ops : [],
      actor: {
        type: row.actor_type === "system" ? "system" : "user",
        id: row.actor_id,
      },
    });
  }
}

async function broadcastPresence(
  redis: Redis | null,
  baseId: string,
): Promise<void> {
  if (!redis) {
    return;
  }
  const key = `presence:${baseId}`;
  const raw = await redis.hgetall(key);
  const peers = Object.entries(raw).map(([userId, stateJson]) => {
    let state: Record<string, unknown> = {};
    try {
      state = JSON.parse(stateJson) as Record<string, unknown>;
    } catch {
      state = {};
    }
    return { userId: pid("usr", userId), state };
  });
  broadcastToBase(baseId, { type: "presence", peers });
}

async function handleSubscribe(
  ctx: {
    db: ReturnType<typeof createDb>;
    redis: Redis | null;
    sub: Redis | null;
    ws: WebSocket;
    state: ConnectionState;
  },
  basePublicId: string,
  afterSeq?: number,
): Promise<void> {
  if (!ctx.state.userId) {
    sendMessage(ctx.ws, {
      type: "error",
      code: "unauthenticated",
      detail: "Authenticate before subscribe",
    });
    return;
  }

  let baseId: string;
  try {
    baseId = parsePid(basePublicId, "bas");
  } catch {
    sendMessage(ctx.ws, {
      type: "error",
      code: "invalid_base",
      detail: "Invalid base id",
    });
    return;
  }

  const base = await resolveBaseContext(ctx.db, ctx.state.userId, baseId);
  if (!base.ok) {
    sendMessage(ctx.ws, {
      type: "error",
      code: "forbidden",
      detail: "Base not found or access denied",
    });
    return;
  }

  const snapshot = await compileForUser(ctx.db, ctx.state.userId, baseId);
  try {
    assertCan(snapshot, "base.read");
  } catch {
    sendMessage(ctx.ws, {
      type: "error",
      code: "forbidden",
      detail: "Insufficient permissions",
    });
    return;
  }

  addBaseSubscriber(baseId, ctx.ws);
  ctx.state.subscribedBases.add(baseId);

  if (ctx.sub && ctx.redis) {
    await ensureRedisChannelSubscribed(ctx.redis, ctx.sub, baseId);
  }

  const headSeq = await loadHeadSeq(ctx.db, baseId);
  sendMessage(ctx.ws, {
    type: "subscribed",
    baseId: basePublicId,
    seq: headSeq,
  });

  if (afterSeq !== undefined && afterSeq < headSeq) {
    await sendCatchUpChanges(ctx.db, ctx.ws, baseId, afterSeq);
  }
}

async function handleUnsubscribe(
  ctx: {
    sub: Redis | null;
    ws: WebSocket;
    state: ConnectionState;
  },
  basePublicId?: string,
): Promise<void> {
  const targets =
    basePublicId !== undefined
      ? (() => {
          try {
            return [parsePid(basePublicId, "bas")];
          } catch {
            return [];
          }
        })()
      : [...ctx.state.subscribedBases];

  for (const baseId of targets) {
    if (!ctx.state.subscribedBases.has(baseId)) {
      continue;
    }
    removeBaseSubscriber(baseId, ctx.ws);
    ctx.state.subscribedBases.delete(baseId);
    if (ctx.sub) {
      await releaseRedisChannel(ctx.sub, baseId);
    }
  }
}

async function handleOp(
  ctx: {
    db: ReturnType<typeof createDb>;
    redis: Redis | null;
    ws: WebSocket;
    state: ConnectionState;
  },
  msg: Extract<
    import("@tabula/realtime-protocol").ClientMessage,
    { type: "op" }
  >,
): Promise<void> {
  if (!ctx.state.userId || !ctx.state.sessionId) {
    sendMessage(ctx.ws, {
      type: "op_reject",
      clientMutationId: msg.clientMutationId,
      code: "unauthenticated",
    });
    return;
  }

  let baseId: string;
  let tableId: string;
  let recordId: string;
  try {
    baseId = parsePid(msg.baseId, "bas");
    tableId = parsePid(msg.tableId, "tbl");
    recordId = parsePid(msg.recordId, "rec");
  } catch {
    sendMessage(ctx.ws, {
      type: "op_reject",
      clientMutationId: msg.clientMutationId,
      code: "invalid_id",
    });
    return;
  }

  const table = await resolveTableContext(
    ctx.db,
    ctx.state.userId,
    baseId,
    tableId,
  );
  if (!table.ok) {
    sendMessage(ctx.ws, {
      type: "op_reject",
      clientMutationId: msg.clientMutationId,
      code: "forbidden",
    });
    return;
  }

  const snapshot = await compileForUser(ctx.db, ctx.state.userId, baseId);
  try {
    assertCan(snapshot, "record.update");
  } catch {
    sendMessage(ctx.ws, {
      type: "op_reject",
      clientMutationId: msg.clientMutationId,
      code: "forbidden",
    });
    return;
  }

  const actor: MutationActor = {
    actorType: "user",
    actorId: ctx.state.userId,
    sessionId: ctx.state.sessionId,
    via: "ui",
  };

  try {
    const result = await applyRecordFieldUpdate({
      db: ctx.db,
      redis: ctx.redis,
      orgId: table.orgId,
      workspaceId: table.workspaceId,
      baseId,
      tableId,
      recordId,
      fieldPublicId: msg.fieldId,
      value: msg.value,
      actor,
      clientMutationId: msg.clientMutationId,
      ...(msg.version !== undefined ? { expectedVersion: msg.version } : {}),
    });

    sendMessage(ctx.ws, {
      type: "op_ack",
      clientMutationId: msg.clientMutationId,
      seq: result.seq,
      version: result.version,
    });

    if (!ctx.redis) {
      broadcastToBase(baseId, {
        type: "change",
        baseId: msg.baseId,
        seq: result.seq,
        ops: result.ops,
        actor: { type: "user", id: ctx.state.userId },
      });
    }
  } catch (err) {
    if (err instanceof RecordFieldUpdateError) {
      sendMessage(ctx.ws, {
        type: "op_reject",
        clientMutationId: msg.clientMutationId,
        code: err.code,
      });
      return;
    }
    sendMessage(ctx.ws, {
      type: "op_reject",
      clientMutationId: msg.clientMutationId,
      code: "internal_error",
    });
  }
}

async function handlePresence(
  ctx: {
    redis: Redis | null;
    state: ConnectionState;
  },
  basePublicId: string,
  state: Record<string, unknown>,
): Promise<void> {
  if (!ctx.state.userId || !ctx.redis) {
    return;
  }
  let baseId: string;
  try {
    baseId = parsePid(basePublicId, "bas");
  } catch {
    return;
  }
  if (!ctx.state.subscribedBases.has(baseId)) {
    return;
  }
  const key = `presence:${baseId}`;
  await ctx.redis.hset(key, ctx.state.userId, JSON.stringify(state));
  await ctx.redis.expire(key, PRESENCE_TTL_SECONDS);
  await broadcastPresence(ctx.redis, baseId);
}

function cleanupConnection(
  ws: WebSocket,
  sub: Redis | null,
): void {
  const state = socketState.get(ws);
  if (!state) {
    return;
  }
  for (const baseId of state.subscribedBases) {
    removeBaseSubscriber(baseId, ws);
    if (sub) {
      void releaseRedisChannel(sub, baseId);
    }
  }
  socketState.delete(ws);
}

async function main(): Promise<void> {
  const env = loadEnv();
  const log = createLogger({ name: "tabula-realtime", role: "realtime" });
  const db = createDb(env.DATABASE_URL);
  const redis = await connectRedis(env, log);
  const ticketSecret = wsTicketSecret(env);

  const sub = redis?.duplicate() ?? null;
  if (sub) {
    sub.on("message", (channel, message) => {
      const payload = parseRealtimeChangePayload(message);
      if (!payload) {
        return;
      }
      broadcastToBase(payload.baseId, {
        type: "change",
        baseId: pid("bas", payload.baseId),
        seq: payload.seq,
        ops: payload.ops,
        actor: payload.actor,
      });
    });
  }

  const httpServer = createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });

  const wss = new WebSocketServer({
    noServer: true,
    handleProtocols: (protocols) =>
      protocols.has("tabula.v1") ? "tabula.v1" : false,
  });

  httpServer.on("upgrade", (request: IncomingMessage, socket, head) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    if (url.pathname !== "/v1/ws") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  });

  wss.on("connection", (ws, request: IncomingMessage) => {
    const state: ConnectionState = {
      ws,
      authed: false,
      subscribedBases: new Set(),
    };
    socketState.set(ws, state);

    const connId = `c_${randomBytes(12).toString("base64url")}`;
    const url = new URL(
      request.url ?? "/",
      `http://${request.headers.host ?? "localhost"}`,
    );
    const ticketFromQuery = url.searchParams.get("ticket");

    void (async () => {
      if (!ticketFromQuery) {
        return;
      }
      const record = await consumeWsTicket(redis, ticketSecret, ticketFromQuery);
      if (!record) {
        sendMessage(ws, {
          type: "error",
          code: "invalid_ticket",
        });
        ws.close(4401, "invalid ticket");
        return;
      }
      state.userId = record.userId;
      state.sessionId = record.sessionId;
      state.authed = true;
      sendMessage(ws, {
        type: "hello",
        connId,
        protocol: "tabula.v1",
        protocolVersion: PROTOCOL_VERSION,
        heartbeatSec: Math.round(HEARTBEAT_MS / 1000),
        serverTime: new Date().toISOString(),
      });
    })();

    const heartbeat = setInterval(() => {
      if (ws.readyState === ws.OPEN) {
        ws.ping();
      }
    }, HEARTBEAT_MS);

    ws.on("message", (data) => {
      void (async () => {
        let raw: unknown;
        try {
          raw = JSON.parse(String(data));
        } catch {
          sendMessage(ws, {
            type: "error",
            code: "invalid_json",
          });
          return;
        }

        const parsed = safeParseClientMessage(raw);
        if (!parsed.success) {
          sendMessage(ws, {
            type: "error",
            code: "invalid_message",
            detail: parsed.error.message,
          });
          return;
        }

        const msg = parsed.data;

        if (!state.authed && msg.type !== "auth") {
          sendMessage(ws, {
            type: "error",
            code: "unauthenticated",
            detail: "Send auth first",
          });
          return;
        }

        switch (msg.type) {
          case "auth": {
            if (state.authed) {
              sendMessage(ws, {
                type: "authed",
                protocolVersion: PROTOCOL_VERSION,
              });
              break;
            }
            const record = await consumeWsTicket(redis, ticketSecret, msg.ticket);
            if (!record) {
              sendMessage(ws, {
                type: "error",
                code: "invalid_ticket",
              });
              ws.close(4401, "invalid ticket");
              return;
            }
            state.userId = record.userId;
            state.sessionId = record.sessionId;
            state.authed = true;
            sendMessage(ws, {
              type: "hello",
              connId,
              protocol: "tabula.v1",
              protocolVersion: PROTOCOL_VERSION,
              heartbeatSec: Math.round(HEARTBEAT_MS / 1000),
              serverTime: new Date().toISOString(),
            });
            break;
          }
          case "subscribe":
            await handleSubscribe(
              { db, redis, sub, ws, state },
              msg.baseId,
              msg.afterSeq,
            );
            break;
          case "unsubscribe":
            await handleUnsubscribe({ sub, ws, state }, msg.baseId);
            break;
          case "op":
            await handleOp({ db, redis, ws, state }, msg);
            break;
          case "presence":
            await handlePresence(
              { redis, state },
              msg.baseId,
              msg.state,
            );
            break;
          case "ping":
            sendMessage(ws, { type: "pong" });
            break;
          default:
            break;
        }
      })();
    });

    ws.on("close", () => {
      clearInterval(heartbeat);
      cleanupConnection(ws, sub);
    });
  });

  const port = env.REALTIME_PORT;
  httpServer.listen(port, "0.0.0.0", () => {
    log.info({ port }, "Tabula realtime WebSocket listening");
  });
}

void main();
