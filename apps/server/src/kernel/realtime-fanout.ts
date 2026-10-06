import type { RealtimeActor } from "@tabula/realtime-protocol";
import type { Redis } from "ioredis";

export interface RealtimeChangePayload {
  baseId: string;
  seq: number;
  ops: unknown[];
  actor: RealtimeActor;
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
