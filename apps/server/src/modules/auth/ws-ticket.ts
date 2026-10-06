import { createHash, randomBytes } from "node:crypto";
import type { Redis } from "ioredis";

const TICKET_PREFIX = "wst_";
const TTL_SECONDS = 30;

export interface WsTicketRecord {
  userId: string;
  sessionId: string;
  issuedAt: number;
}

interface MemoryEntry {
  record: WsTicketRecord;
  expiresAt: number;
}

const memoryTickets = new Map<string, MemoryEntry>();

function ticketRedisKey(ticket: string, secret: string): string {
  const hash = createHash("sha256")
    .update(`${secret}:${ticket}`)
    .digest("hex");
  return `wst:${hash}`;
}

function pruneMemory(): void {
  const now = Date.now();
  for (const [key, entry] of memoryTickets) {
    if (entry.expiresAt <= now) {
      memoryTickets.delete(key);
    }
  }
}

export function generateWsTicket(): string {
  return `${TICKET_PREFIX}${randomBytes(24).toString("base64url")}`;
}

export async function storeWsTicket(
  redis: Redis | null,
  secret: string,
  ticket: string,
  record: WsTicketRecord,
): Promise<void> {
  const payload = JSON.stringify(record);
  if (redis) {
    await redis.set(ticketRedisKey(ticket, secret), payload, "EX", TTL_SECONDS);
    return;
  }
  pruneMemory();
  memoryTickets.set(ticket, {
    record,
    expiresAt: Date.now() + TTL_SECONDS * 1000,
  });
}

/** Single-use: returns record and deletes storage. */
export async function consumeWsTicket(
  redis: Redis | null,
  secret: string,
  ticket: string,
): Promise<WsTicketRecord | null> {
  if (!ticket.startsWith(TICKET_PREFIX)) {
    return null;
  }
  if (redis) {
    const key = ticketRedisKey(ticket, secret);
    const raw = await redis.getdel(key);
    if (!raw) {
      return null;
    }
    try {
      return JSON.parse(raw) as WsTicketRecord;
    } catch {
      return null;
    }
  }
  pruneMemory();
  const entry = memoryTickets.get(ticket);
  if (!entry || entry.expiresAt <= Date.now()) {
    memoryTickets.delete(ticket);
    return null;
  }
  memoryTickets.delete(ticket);
  return entry.record;
}
