import type { RealtimeActor } from "@tabula/realtime-protocol";
import type { Redis } from "ioredis";

/**
 * Internal (raw-uuid) change payload published on `rt:base:<uuid>` after a
 * base transaction commits. The realtime gateway translates it to the
 * client-facing `change` frame (public ids) — see `realtime-translate.ts`.
 */
export interface RealtimeChangePayload {
  baseId: string;
  seq: number;
  kind?: string;
  tableIds?: string[];
  ops: unknown[];
  clientMutationId?: string | null;
  actor: RealtimeActor;
}

/** Presence changed for a base; every gateway instance re-broadcasts. */
export interface RealtimePresenceSignal {
  type: "presence_changed";
  baseId: string;
}

export function realtimeBaseChannel(baseId: string): string {
  return `rt:base:${baseId}`;
}

export async function publishBaseChange(
  redis: Redis,
  payload: RealtimeChangePayload,
): Promise<void> {
  await redis.publish(
    realtimeBaseChannel(payload.baseId),
    JSON.stringify(payload),
  );
}

export async function publishPresenceSignal(
  redis: Redis,
  baseId: string,
): Promise<void> {
  const signal: RealtimePresenceSignal = { type: "presence_changed", baseId };
  await redis.publish(realtimeBaseChannel(baseId), JSON.stringify(signal));
}

export function parsePresenceSignal(raw: string): RealtimePresenceSignal | null {
  try {
    const parsed = JSON.parse(raw) as Partial<RealtimePresenceSignal>;
    if (parsed.type === "presence_changed" && typeof parsed.baseId === "string") {
      return { type: "presence_changed", baseId: parsed.baseId };
    }
    return null;
  } catch {
    return null;
  }
}

export function parseRealtimeChangePayload(raw: string): RealtimeChangePayload | null {
  try {
    const parsed = JSON.parse(raw) as RealtimeChangePayload;
    if (
      typeof parsed.baseId !== "string" ||
      typeof parsed.seq !== "number" ||
      !Array.isArray(parsed.ops) ||
      !parsed.actor ||
      typeof parsed.actor.type !== "string"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}
