import type { Env } from "@tabula/config";
import type { TabulaDb } from "@tabula/db";
import type { EventBus } from "@tabula/events";
import type { SearchBackend } from "@tabula/search";
import type { TabulaStorage } from "@tabula/storage";
import type { Redis } from "ioredis";
import type { Logger } from "pino";

export interface AppContext {
  env: Env;
  db: TabulaDb;
  log: Logger;
  defaultShardId: string;
  redis: Redis | null;
  eventBus: EventBus;
  storage: TabulaStorage | null;
  search: SearchBackend;
}
