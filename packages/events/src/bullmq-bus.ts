import { Queue, Worker } from "bullmq";
import type { Redis } from "ioredis";

import type { EventBus } from "./bus.js";
import type { DomainEvent } from "./envelope.js";

function queueNameForTopic(topic: string): string {
  return `evt:${topic}`;
}

export class BullMQEventBus implements EventBus {
  private readonly queues = new Map<string, Queue>();
  private readonly workers: Worker[] = [];

  constructor(private readonly connection: Redis) {}

  private getQueue(topic: string): Queue {
    let queue = this.queues.get(topic);
    if (!queue) {
      queue = new Queue(queueNameForTopic(topic), {
        connection: this.connection.duplicate(),
      });
      this.queues.set(topic, queue);
    }
    return queue;
  }

  async publish(
    topic: string,
    key: string,
    event: DomainEvent,
  ): Promise<void> {
    await this.getQueue(topic).add(key, event);
  }

  async subscribe(
    topic: string,
    group: string,
    handler: (event: DomainEvent) => Promise<void>,
  ): Promise<void> {
    const worker = new Worker(
      queueNameForTopic(topic),
      async (job) => {
        await handler(job.data as DomainEvent);
      },
      {
        connection: this.connection.duplicate(),
        name: group,
      },
    );
    this.workers.push(worker);
  }

  async close(): Promise<void> {
    await Promise.all(this.workers.map((worker) => worker.close()));
    this.workers.length = 0;
    await Promise.all([...this.queues.values()].map((queue) => queue.close()));
    this.queues.clear();
  }
}
