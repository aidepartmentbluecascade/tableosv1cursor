import type { Redis } from "ioredis";

import type { EventBus } from "./bus.js";
import { BullMQEventBus } from "./bullmq-bus.js";
import { InMemoryEventBus } from "./memory-bus.js";

export const DOMAIN_EVENTS_TOPIC = "tabula.domain-events.v1";

export function createEventBus(connection: Redis | null): EventBus {
  if (connection) {
    return new BullMQEventBus(connection);
  }
  return new InMemoryEventBus();
}
