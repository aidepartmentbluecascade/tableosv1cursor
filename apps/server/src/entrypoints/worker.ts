import { loadEnv } from "@tabula/config";
import { ALL_QUEUE_NAMES, createWorker, type QueueName } from "@tabula/jobs";
import { createLogger } from "@tabula/observability";
import { createDb } from "@tabula/db";
import { QueueNames } from "@tabula/jobs";
import {
  createEventBus,
  DOMAIN_EVENTS_TOPIC,
  type DomainEvent,
} from "@tabula/events";
import { PostgresFtsBackend } from "@tabula/search";
import { handleComputeJob } from "../modules/compute/jobs.js";
import {
  handleCommentCreatedNotification,
  handleFileScanJob,
  handleSearchIndexEvent,
} from "../modules/collab/worker-handlers.js";
import { connectRedis } from "../lib/redis.js";

async function main(): Promise<void> {
  const env = loadEnv();
  const log = createLogger({ name: "tabula-worker", role: "worker" });

  const argQueues = process.argv
    .find((a) => a.startsWith("--queues="))
    ?.slice("--queues=".length)
    ?.split(",")
    .filter(Boolean) as QueueName[] | undefined;

  const queues = argQueues?.length ? argQueues : [...ALL_QUEUE_NAMES];

  const redis = await connectRedis(env, log);
  if (!redis) {
    log.error("Worker requires Redis (REDIS_URL)");
    process.exit(1);
  }

  const db = createDb(env.DATABASE_URL);
  const search = new PostgresFtsBackend(db);
  const eventBus = createEventBus(redis);

  await eventBus.subscribe(
    DOMAIN_EVENTS_TOPIC,
    "collab-notifications",
    async (event: DomainEvent) => {
      await handleCommentCreatedNotification(db, event);
    },
  );

  await eventBus.subscribe(
    DOMAIN_EVENTS_TOPIC,
    "search-indexer",
    async (event: DomainEvent) => {
      await handleSearchIndexEvent(db, search, event);
    },
  );

  log.info("Subscribed to domain events (notifications, search indexer)");

  const handles = queues.map((queue) => {
    const worker = createWorker(
      queue,
      async (job) => {
        if (queue === QueueNames.COMPUTE) {
          const payload = job.data as { baseId: string; workspaceId: string };
          await handleComputeJob(db, payload);
          log.info({ queue, jobId: job.id, baseId: payload.baseId }, "Compute job drained");
          return;
        }
        if (queue === QueueNames.FILE_SCAN) {
          const payload = job.data as { attachmentId: string };
          await handleFileScanJob(db, payload);
          log.info({ queue, jobId: job.id, attachmentId: payload.attachmentId }, "File scan stub");
          return;
        }
        if (queue === QueueNames.EMAIL || queue === QueueNames.NOTIFICATION) {
          log.info({ queue, jobId: job.id, name: job.name }, "Notification channel job (MVP log-only)");
          return;
        }
        log.info(
          { queue, jobId: job.id, name: job.name },
          "Job handled (MVP log-only handlers)",
        );
      },
      redis,
      { concurrency: 2 },
    );
    worker.on("failed", (job, err) => {
      log.error({ queue, jobId: job?.id, err }, "Job failed");
    });
    return { queue, worker };
  });

  log.info({ queues }, "BullMQ workers started");

  const shutdown = async (): Promise<void> => {
    await eventBus.close();
    await Promise.all(handles.map((h) => h.worker.close()));
    redis.disconnect();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

void main();
