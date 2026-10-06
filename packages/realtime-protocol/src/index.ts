export {
  PROTOCOL_VERSION,
  clientMessageSchema,
  serverMessageSchema,
  parseClientMessage,
  safeParseClientMessage,
} from "./messages.js";

export type {
  ClientMessage,
  ServerMessage,
  RealtimeActor,
} from "./messages.js";
