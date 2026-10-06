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

export const clientPresenceMessage = z.object({
  type: z.literal("presence"),
  baseId: z.string().min(1),
  state: z.record(z.unknown()),
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

export const serverChangeMessage = z.object({
  type: z.literal("change"),
  baseId: z.string(),
  seq: z.number().int().positive(),
  ops: z.array(z.unknown()),
  actor: actorSchema,
});

export const serverOpAckMessage = z.object({
  type: z.literal("op_ack"),
  clientMutationId: z.string(),
  seq: z.number().int().positive(),
  version: z.number().int().positive(),
});

export const serverOpRejectMessage = z.object({
  type: z.literal("op_reject"),
  clientMutationId: z.string(),
  code: z.string(),
  detail: z.string().optional(),
});

const presencePeerSchema = z.object({
  userId: z.string(),
  state: z.record(z.unknown()),
});

export const serverPresenceMessage = z.object({
  type: z.literal("presence"),
  peers: z.array(presencePeerSchema),
});

export const serverResyncRequiredMessage = z.object({
  type: z.literal("resync_required"),
  baseId: z.string().optional(),
  reason: z.string().optional(),
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
