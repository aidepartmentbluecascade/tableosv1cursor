import { Redis } from "ioredis";

/** Redis connection tuned for BullMQ workers and queues. */
export function createRedisConnection(redisUrl: string): Redis {
  return new Redis(redisUrl, {
    maxRetriesPerRequest: null,
  });
}
