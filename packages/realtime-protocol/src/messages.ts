import { z } from "zod";

export const PROTOCOL_VERSION = 1 as const;

const actorSchema = z.object({
  type: z.enum(["user", "system"]),
  id: z.string().nullable(),
});

export const clientAuthMessage = z.object({
  type: z.literal("auth"),
  ticket: z.string().min(1),
});

export const clientSubscribeMessage = z.object({
  type: z.literal("subscribe"),
  baseId: z.string().min(1),
  afterSeq: z.number().int().nonnegative().optional(),
});

export const clientUnsubscribeMessage = z.object({
  type: z.literal("unsubscribe"),
  baseId: z.string().min(1).optional(),
});

export const clientOpMessage = z.object({
  type: z.literal("op"),
  baseId: z.string().min(1),
  tableId: z.string().min(1),
  recordId: z.string().min(1),
  fieldId: z.string().min(1),
  value: z.unknown(),
  clientMutationId: z.string().min(1),
  version: z.number().int().positive().optional(),
});

/**
 * What a client is looking at. All ids are public ids. Unknown keys are
 * tolerated so the client can add hints without a protocol bump.
 */
export const presenceStateSchema = z
  .object({
    tableId: z.string().nullable().optional(),
    viewId: z.string().nullable().optional(),
    recordId: z.string().nullable().optional(),
    cell: z
      .object({ recordId: z.string(), fieldId: z.string() })
      .nullable()
      .optional(),
  })
  .passthrough();

export type PresenceState = z.infer<typeof presenceStateSchema>;

export const clientPresenceMessage = z.object({
  type: z.literal("presence"),
  baseId: z.string().min(1),
  state: presenceStateSchema,
});

export const clientPingMessage = z.object({
  type: z.literal("ping"),
});

export const clientMessageSchema = z.discriminatedUnion("type", [
  clientAuthMessage,
  clientSubscribeMessage,
  clientUnsubscribeMessage,
  clientOpMessage,
  clientPresenceMessage,
  clientPingMessage,
]);

export type ClientMessage = z.infer<typeof clientMessageSchema>;

export const serverHelloMessage = z.object({
  type: z.literal("hello"),
  connId: z.string().min(1),
  protocol: z.literal("tabula.v1"),
  protocolVersion: z.literal(PROTOCOL_VERSION),
  heartbeatSec: z.number().int().positive(),
  serverTime: z.string().min(1),
});

export const serverAuthedMessage = z.object({
  type: z.literal("authed"),
  protocolVersion: z.literal(PROTOCOL_VERSION),
});

export const serverSubscribedMessage = z.object({
  type: z.literal("subscribed"),
  baseId: z.string(),
  seq: z.number().int().nonnegative(),
});

/**
 * Client-facing change frame. All ids are public ids (`bas_ tbl_ rec_ fld_
 * viw_ usr_`). Clients should treat `ops` as hints and refetch:
 * - `recordTableIds` → invalidate `["records", baseId, tableId]` and
 *   `["record", baseId, tableId, recordId]` for `recordIds`
 * - `schemaChanged` → invalidate `["bases", baseId]`
 * - `clientMutationId` matching an id the client sent → it is the client's own
 *   edit and may be skipped.
 */
export const serverChangeMessage = z.object({
  type: z.literal("change"),
  baseId: z.string(),
  seq: z.number().int().positive(),
  kind: z.string().optional(),
  /** Every table touched (records or schema). */
  tableIds: z.array(z.string()).optional(),
  /** First touched table, for convenience. */
  tableId: z.string().optional(),
  /** Tables whose record data changed. */
  recordTableIds: z.array(z.string()).optional(),
  recordIds: z.array(z.string()).optional(),
  /** Record data changed (if `recordTableIds` is empty: in unknown tables). */
  recordsChanged: z.boolean().optional(),
  schemaChanged: z.boolean().optional(),
  clientMutationId: z.string().nullable().optional(),
  ops: z.array(z.unknown()),
  actor: actorSchema,
});

export const serverOpAckMessage = z.object({
  type: z.literal("op_ack"),
  clientMutationId: z.string(),
  seq: z.number().int().positive(),
  version: z.number().int().positive(),
  recordId: z.string().optional(),
});

export const serverOpRejectMessage = z.object({
  type: z.literal("op_reject"),
  clientMutationId: z.string(),
  code: z.string(),
  detail: z.string().optional(),
});

export const presencePeerSchema = z.object({
  connId: z.string(),
  user: z.object({
    id: z.string(),
    name: z.string(),
    email: z.string().optional(),
  }),
  color: z.string(),
  state: presenceStateSchema,
  updatedAt: z.string(),
});

export type PresencePeer = z.infer<typeof presencePeerSchema>;

/** Full presence snapshot for a base (always the complete list). */
export const serverPresenceMessage = z.object({
  type: z.literal("presence"),
  baseId: z.string(),
  full: z.literal(true),
  peers: z.array(presencePeerSchema),
});

export const serverResyncRequiredMessage = z.object({
  type: z.literal("resync_required"),
  baseId: z.string().optional(),
  reason: z.string().optional(),
  headSeq: z.number().int().nonnegative().optional(),
});

export const serverPongMessage = z.object({
  type: z.literal("pong"),
});

export const serverErrorMessage = z.object({
  type: z.literal("error"),
  code: z.string(),
  detail: z.string().optional(),
});

export const serverMessageSchema = z.discriminatedUnion("type", [
  serverHelloMessage,
  serverAuthedMessage,
  serverSubscribedMessage,
  serverChangeMessage,
  serverOpAckMessage,
  serverOpRejectMessage,
  serverPresenceMessage,
  serverResyncRequiredMessage,
  serverPongMessage,
  serverErrorMessage,
]);

export type ServerMessage = z.infer<typeof serverMessageSchema>;
export type RealtimeActor = z.infer<typeof actorSchema>;

export function parseClientMessage(raw: unknown): ClientMessage {
  return clientMessageSchema.parse(raw);
}

export function safeParseClientMessage(
  raw: unknown,
): z.SafeParseReturnType<unknown, ClientMessage> {
  return clientMessageSchema.safeParse(raw);
}
