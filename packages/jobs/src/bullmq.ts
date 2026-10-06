import { Queue, Worker, type Processor, type WorkerOptions } from "bullmq";
import type { Redis } from "ioredis";

import type { QueueName } from "./queues.js";

export function createQueue(
  name: QueueName | string,
  connection: Redis,
): Queue {
  return new Queue(name, { connection: connection.duplicate() });
}

export function createWorker(
  name: QueueName | string,
  processor: Processor,
  connection: Redis,
  options?: Omit<WorkerOptions, "connection">,
): Worker {
  return new Worker(name, processor, {
    ...options,
    connection: connection.duplicate(),
  });
}
