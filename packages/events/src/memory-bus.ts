import type { EventBus } from "./bus.js";
import type { DomainEvent } from "./envelope.js";

type Handler = (event: DomainEvent) => Promise<void>;

export class InMemoryEventBus implements EventBus {
  private readonly handlers = new Map<string, Map<string, Handler[]>>();

  async publish(
    _topic: string,
    _key: string,
    event: DomainEvent,
  ): Promise<void> {
    const topicHandlers = this.handlers.get(_topic);
    if (!topicHandlers) {
      return;
    }
    for (const groupHandlers of topicHandlers.values()) {
      for (const handler of groupHandlers) {
        await handler(event);
      }
    }
  }

  async subscribe(
    topic: string,
    group: string,
    handler: Handler,
  ): Promise<void> {
    let topicHandlers = this.handlers.get(topic);
    if (!topicHandlers) {
      topicHandlers = new Map();
      this.handlers.set(topic, topicHandlers);
    }
    let groupHandlers = topicHandlers.get(group);
    if (!groupHandlers) {
      groupHandlers = [];
      topicHandlers.set(group, groupHandlers);
    }
    groupHandlers.push(handler);
  }

  async close(): Promise<void> {
    this.handlers.clear();
  }
}
