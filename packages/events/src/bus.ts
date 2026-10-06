import type { DomainEvent } from "./envelope.js";

export interface EventBus {
  publish(topic: string, key: string, event: DomainEvent): Promise<void>;
  subscribe(
    topic: string,
    group: string,
    handler: (event: DomainEvent) => Promise<void>,
  ): Promise<void>;
  close(): Promise<void>;
}
