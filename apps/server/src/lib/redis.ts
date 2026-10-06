import { Redis } from "ioredis";
import type { Env } from "@tabula/config";
import type { Logger } from "pino";

export async function connectRedis(env: Env, log: Logger): Promise<Redis | null> {
  try {
    const client = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
    await client.ping();
    log.info("Redis connected");
    return client;
  } catch (err) {
    log.warn({ err }, "Redis unavailable; using in-memory event bus");
    return null;
  }
}
