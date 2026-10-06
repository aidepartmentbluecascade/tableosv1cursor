import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { RecordEvents } from "./catalogue.js";
import type { DomainEvent } from "./envelope.js";
import { InMemoryEventBus } from "./memory-bus.js";

describe("InMemoryEventBus", () => {
  it("delivers published events to subscribers", async () => {
    const bus = new InMemoryEventBus();
    const received: DomainEvent[] = [];

    await bus.subscribe("tabula.domain-events.v1", "test", async (event) => {
      received.push(event);
    });

    const event: DomainEvent = {
      id: "evt_test",
      type: RecordEvents.CREATED,
      schemaVersion: 1,
      occurredAt: new Date().toISOString(),
      tenant: { orgId: "org_1", workspaceId: "wsp_1", baseId: "bas_1" },
      actor: { type: "user", id: "usr_1", via: "api" },
      causationDepth: 0,
      data: { recordId: "rec_1" },
    };

    await bus.publish("tabula.domain-events.v1", "bas_1", event);
    await bus.close();

    assert.equal(received.length, 1);
    assert.equal(received[0]?.id, "evt_test");
  });
});
