import type { Redis } from "ioredis";

/**
 * Fixed-window counters for auth endpoints. Uses Redis when available (shared
 * across API processes), otherwise an in-process map (dev / no Redis).
 */
export interface RateLimitResult {
  allowed: boolean;
  count: number;
  retryAfterSec: number;
}

const memory = new Map<string, { count: number; resetAt: number }>();

function memoryHit(key: string, windowSec: number): { count: number; ttl: number } {
  const now = Date.now();
  const row = memory.get(key);
  if (!row || row.resetAt <= now) {
    memory.set(key, { count: 1, resetAt: now + windowSec * 1000 });
    return { count: 1, ttl: windowSec };
  }
  row.count += 1;
  return { count: row.count, ttl: Math.ceil((row.resetAt - now) / 1000) };
}

function memoryPeek(key: string): { count: number; ttl: number } {
  const now = Date.now();
  const row = memory.get(key);
  if (!row || row.resetAt <= now) return { count: 0, ttl: 0 };
  return { count: row.count, ttl: Math.ceil((row.resetAt - now) / 1000) };
}

export class AuthRateLimiter {
  constructor(
    private readonly redis: Redis | null,
    private readonly prefix = "tabula:rl:",
  ) {}

  /** Current count without incrementing. */
  async peek(key: string, limit: number): Promise<RateLimitResult> {
    const k = this.prefix + key;
    if (this.redis) {
      try {
        const [count, ttl] = await Promise.all([this.redis.get(k), this.redis.ttl(k)]);
        const n = Number(count ?? 0);
        return { allowed: n < limit, count: n, retryAfterSec: Math.max(ttl, 1) };
      } catch {
        /* fall through to memory */
      }
    }
    const m = memoryPeek(k);
    return { allowed: m.count < limit, count: m.count, retryAfterSec: Math.max(m.ttl, 1) };
  }

  /** Increment and report whether the caller is still under the limit. */
  async hit(key: string, limit: number, windowSec: number): Promise<RateLimitResult> {
    const k = this.prefix + key;
    if (this.redis) {
      try {
        const count = await this.redis.incr(k);
        if (count === 1) await this.redis.expire(k, windowSec);
        const ttl = await this.redis.ttl(k);
        return { allowed: count <= limit, count, retryAfterSec: Math.max(ttl, 1) };
      } catch {
        /* fall through to memory */
      }
    }
    const m = memoryHit(k, windowSec);
    return { allowed: m.count <= limit, count: m.count, retryAfterSec: Math.max(m.ttl, 1) };
  }

  async reset(key: string): Promise<void> {
    const k = this.prefix + key;
    memory.delete(k);
    if (this.redis) {
      try {
        await this.redis.del(k);
      } catch {
        /* ignore */
      }
    }
  }
}
