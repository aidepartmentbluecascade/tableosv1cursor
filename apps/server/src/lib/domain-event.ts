import { generateUuidV7 } from "@tabula/types";
import {
  DOMAIN_EVENTS_TOPIC,
  type DomainEvent,
  type EventBus,
} from "@tabula/events";

export async function publishDomainEvent(
  eventBus: EventBus,
  event: Omit<DomainEvent, "id" | "schemaVersion" | "occurredAt" | "causationDepth">,
): Promise<void> {
  const full: DomainEvent = {
    id: generateUuidV7(),
    schemaVersion: 1,
    occurredAt: new Date().toISOString(),
    causationDepth: 0,
    ...event,
  };
  const key = event.tenant.baseId ?? event.tenant.workspaceId;
  await eventBus.publish(DOMAIN_EVENTS_TOPIC, key, full);
}
