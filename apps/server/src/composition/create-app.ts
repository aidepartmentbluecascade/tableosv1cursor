import { loadEnv } from "@tabula/config";
import { createDb, seedDefaultShard } from "@tabula/db";
import { createEventBus } from "@tabula/events";
import { createLogger } from "@tabula/observability";
import { PostgresFtsBackend } from "@tabula/search";
import { createStorage, storageEnvFromProcess } from "@tabula/storage";
import type { AppContext } from "../lib/app-context.js";
import { connectRedis } from "../lib/redis.js";
import { buildFastify } from "../http/app.js";

export async function createApp(): Promise<{
  app: Awaited<ReturnType<typeof buildFastify>>;
  ctx: AppContext;
}> {
  const env = loadEnv();
  const log = createLogger({ name: "tabula-api", role: env.ROLE });
  const db = createDb(env.DATABASE_URL);

  const defaultShardId = await seedDefaultShard({
    connectionString: env.DATABASE_URL,
  });

  const redis = await connectRedis(env, log);
  const eventBus = createEventBus(redis);

  const storageConfig = storageEnvFromProcess(env);
  let storage: AppContext["storage"] = null;
  if (storageConfig) {
    storage = createStorage(storageConfig);
    try {
      await storage.ensureBucket();
    } catch (err) {
      log.warn({ err }, "S3 bucket ensure failed (attachments may be unavailable)");
    }
  }

  const search = new PostgresFtsBackend(db);

  const ctx: AppContext = {
    env,
    db,
    log,
    defaultShardId,
    redis,
    eventBus,
    storage,
    search,
  };
  const app = await buildFastify(ctx);
  return { app, ctx };
}
