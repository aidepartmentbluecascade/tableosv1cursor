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
  parsePresenceSignal,
  parseRealtimeChangePayload,
  publishPresenceSignal,
  realtimeBaseChannel,
} from "../kernel/realtime-fanout.js";
import { toClientChangeFrame } from "../kernel/realtime-translate.js";
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
const PRESENCE_TTL_SECONDS = 120;
/** Presence entries not refreshed within this window are dropped. */
const PRESENCE_STALE_MS = 90_000;
/** Max change rows replayed on (re)subscribe before asking for a resync. */
const CATCH_UP_LIMIT = 500;

const PRESENCE_COLORS = [
  "#2d7ff9",
  "#e8384f",
  "#20c933",
  "#ff6f2c",
  "#8b46ff",
  "#18bfff",
  "#fcb400",
  "#f82b60",
  "#11a683",
  "#7c39ed",
];

function colorForUser(userId: string): string {
  let h = 0;
  for (let i = 0; i < userId.length; i++) {
    h = (h * 31 + userId.charCodeAt(i)) >>> 0;
  }
  return PRESENCE_COLORS[h % PRESENCE_COLORS.length] ?? "#2d7ff9";
}

const rootEnv = resolve(process.cwd(), "../../.env");
const localEnv = resolve(process.cwd(), ".env");
if (existsSync(rootEnv)) {
  process.loadEnvFile(rootEnv);
} else if (existsSync(localEnv)) {
  process.loadEnvFile(localEnv);
}

interface ConnectionState {
  ws: WebSocket;
  connId: string;
  userId?: string;
  sessionId?: string;
  userName?: string;
  userEmail?: string;
  authed: boolean;
  subscribedBases: Set<string>;
}

interface PresenceEntry {
  connId: string;
  userId: string;
  name: string;
  email: string;
  color: string;
  state: Record<string, unknown>;
  updatedAt: string;
}

/** Presence fallback when Redis is unavailable (single instance). */
const memoryPresence = new Map<string, Map<string, PresenceEntry>>();

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
  headSeq: number,
): Promise<void> {
  const rows = await sql<{
    seq: string;
    kind: string;
    ops: unknown;
    table_ids: string[] | null;
    client_mutation_id: string | null;
    actor_type: string;
    actor_id: string | null;
  }>`
    SELECT seq, kind, ops, table_ids, client_mutation_id, actor_type, actor_id
    FROM data.base_changes
    WHERE base_id = ${baseId} AND seq > ${afterSeq}
    ORDER BY seq ASC
    LIMIT ${CATCH_UP_LIMIT + 1}
  `.execute(db);

  const firstSeq = rows.rows[0] ? Number(rows.rows[0].seq) : null;
  const truncated = rows.rows.length > CATCH_UP_LIMIT;
  // A gap (missing seqs, e.g. pruned history) also means the client cannot
  // rebuild state from the log.
  const gap = firstSeq !== null && firstSeq > afterSeq + 1;
  if (truncated || gap) {
    sendMessage(ws, {
      type: "resync_required",
      baseId: pid("bas", baseId),
      reason: truncated ? "catch_up_truncated" : "change_log_gap",
      headSeq,
    });
    return;
  }

  for (const row of rows.rows) {
    sendMessage(
      ws,
      toClientChangeFrame({
        baseId,
        seq: Number(row.seq),
        kind: row.kind,
        tableIds: row.table_ids ?? [],
        ops: Array.isArray(row.ops) ? row.ops : [],
        clientMutationId: row.client_mutation_id,
        actor: {
          type: row.actor_type === "system" ? "system" : "user",
          id: row.actor_id,
        },
      }),
    );
  }
}

function presenceKey(baseId: string): string {
  return `presence:${baseId}`;
}

async function readPresence(
  redis: Redis | null,
  baseId: string,
): Promise<PresenceEntry[]> {
  const now = Date.now();
  if (!redis) {
    const map = memoryPresence.get(baseId);
    if (!map) return [];
    return [...map.values()].filter(
      (e) => now - Date.parse(e.updatedAt) < PRESENCE_STALE_MS,
    );
  }
  const raw = await redis.hgetall(presenceKey(baseId));
  const entries: PresenceEntry[] = [];
  const stale: string[] = [];
  for (const [connId, json] of Object.entries(raw)) {
    try {
      const entry = JSON.parse(json) as PresenceEntry;
      if (now - Date.parse(entry.updatedAt) >= PRESENCE_STALE_MS) {
        stale.push(connId);
        continue;
      }
      entries.push(entry);
    } catch {
      stale.push(connId);
    }
  }
  if (stale.length > 0) {
    await redis.hdel(presenceKey(baseId), ...stale);
  }
  return entries;
}

async function writePresence(
  redis: Redis | null,
  baseId: string,
  entry: PresenceEntry,
): Promise<void> {
  if (!redis) {
    let map = memoryPresence.get(baseId);
    if (!map) {
      map = new Map();
      memoryPresence.set(baseId, map);
    }
    map.set(entry.connId, entry);
    return;
  }
  await redis.hset(presenceKey(baseId), entry.connId, JSON.stringify(entry));
  await redis.expire(presenceKey(baseId), PRESENCE_TTL_SECONDS);
}

async function removePresence(
  redis: Redis | null,
  baseId: string,
  connId: string,
): Promise<void> {
  if (!redis) {
    memoryPresence.get(baseId)?.delete(connId);
    return;
  }
  await redis.hdel(presenceKey(baseId), connId);
}

/** Send the full presence list of a base to every local subscriber. */
async function broadcastPresence(
  redis: Redis | null,
  baseId: string,
): Promise<void> {
  const entries = await readPresence(redis, baseId);
  broadcastToBase(baseId, {
    type: "presence",
    baseId: pid("bas", baseId),
    full: true,
    peers: entries.map((e) => ({
      connId: e.connId,
      user: { id: pid("usr", e.userId), name: e.name, email: e.email },
      color: e.color,
      state: e.state,
      updatedAt: e.updatedAt,
    })),
  });
}

/** Tell every gateway instance (or just this one) that presence changed. */
async function signalPresence(redis: Redis | null, baseId: string): Promise<void> {
  if (redis) {
    await publishPresenceSignal(redis, baseId);
    return;
  }
  await broadcastPresence(null, baseId);
}

async function upsertConnectionPresence(
  redis: Redis | null,
  state: ConnectionState,
  baseId: string,
  presenceState: Record<string, unknown>,
): Promise<void> {
  if (!state.userId) return;
  await writePresence(redis, baseId, {
    connId: state.connId,
    userId: state.userId,
    name: state.userName ?? "Someone",
    email: state.userEmail ?? "",
    color: colorForUser(state.userId),
    state: presenceState,
    updatedAt: new Date().toISOString(),
  });
  await signalPresence(redis, baseId);
}

async function loadUserProfile(
  db: ReturnType<typeof createDb>,
  state: ConnectionState,
): Promise<void> {
  if (!state.userId) return;
  try {
    const row = await sql<{ email: string; display_name: string }>`
      SELECT email, display_name FROM core.users WHERE id = ${state.userId} LIMIT 1
    `.execute(db);
    const u = row.rows[0];
    if (u) {
      state.userEmail = u.email;
      state.userName = u.display_name || u.email;
    }
  } catch {
    /* presence falls back to "Someone" */
  }
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

  // Re-subscribing on the same socket (e.g. client retry) must not bump the
  // Redis channel refcount again, or the channel is never released.
  const alreadySubscribed = ctx.state.subscribedBases.has(baseId);
  if (!alreadySubscribed) {
    addBaseSubscriber(baseId, ctx.ws);
    ctx.state.subscribedBases.add(baseId);
    if (ctx.sub && ctx.redis) {
      await ensureRedisChannelSubscribed(ctx.redis, ctx.sub, baseId);
    }
  }

  const headSeq = await loadHeadSeq(ctx.db, baseId);
  sendMessage(ctx.ws, {
    type: "subscribed",
    baseId: basePublicId,
    seq: headSeq,
  });

  if (afterSeq !== undefined && afterSeq > 0) {
    if (afterSeq > headSeq) {
      // Client is ahead of the server (log reset / restored DB).
      sendMessage(ctx.ws, {
        type: "resync_required",
        baseId: basePublicId,
        reason: "client_ahead",
        headSeq,
      });
    } else if (afterSeq < headSeq) {
      await sendCatchUpChanges(ctx.db, ctx.ws, baseId, afterSeq, headSeq);
    }
  }

  if (!alreadySubscribed) {
    await upsertConnectionPresence(ctx.redis, ctx.state, baseId, {});
  } else {
    await broadcastPresence(ctx.redis, baseId);
  }
}

async function handleUnsubscribe(
  ctx: {
    redis: Redis | null;
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
    await removePresence(ctx.redis, baseId, ctx.state.connId);
    await signalPresence(ctx.redis, baseId);
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
      recordId: msg.recordId,
    });

    if (!ctx.redis) {
      broadcastToBase(
        baseId,
        toClientChangeFrame({
          baseId,
          seq: result.seq,
          kind: "records",
          tableIds: [tableId],
          ops: result.ops,
          clientMutationId: msg.clientMutationId,
          actor: { type: "user", id: ctx.state.userId },
        }),
      );
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
  if (!ctx.state.userId) {
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
  await upsertConnectionPresence(ctx.redis, ctx.state, baseId, state);
}

function cleanupConnection(
  ws: WebSocket,
  redis: Redis | null,
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
    void removePresence(redis, baseId, state.connId)
      .then(() => signalPresence(redis, baseId))
      .catch(() => undefined);
  }
  state.subscribedBases.clear();
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
    sub.on("message", (_channel, message) => {
      const presence = parsePresenceSignal(message);
      if (presence) {
        void broadcastPresence(redis, presence.baseId).catch((err: unknown) => {
          log.warn({ err }, "presence broadcast failed");
        });
        return;
      }
      const payload = parseRealtimeChangePayload(message);
      if (!payload) {
        return;
      }
      try {
        broadcastToBase(payload.baseId, toClientChangeFrame(payload));
      } catch (err) {
        log.warn({ err }, "change translation failed");
      }
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
    const connId = `c_${randomBytes(12).toString("base64url")}`;
    const state: ConnectionState = {
      ws,
      connId,
      authed: false,
      subscribedBases: new Set(),
    };
    socketState.set(ws, state);
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
      await loadUserProfile(db, state);
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

    // Handle frames strictly in order per connection (subscribe must finish
    // before a following presence frame is processed).
    let queue: Promise<void> = Promise.resolve();
    const handleFrame = async (data: unknown): Promise<void> => {
      await (async () => {
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
            await loadUserProfile(db, state);
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
            await handleUnsubscribe({ redis, sub, ws, state }, msg.baseId);
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
    };
    ws.on("message", (data) => {
      queue = queue.then(() => handleFrame(data)).catch((err: unknown) => {
        log.warn({ err }, "realtime frame failed");
      });
    });

    ws.on("close", () => {
      clearInterval(heartbeat);
      cleanupConnection(ws, redis, sub);
    });
  });

  const port = env.REALTIME_PORT;
  httpServer.listen(port, "0.0.0.0", () => {
    log.info({ port }, "Tabula realtime WebSocket listening");
  });
}

void main();
