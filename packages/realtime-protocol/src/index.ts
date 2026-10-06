export {
  PROTOCOL_VERSION,
  clientMessageSchema,
  serverMessageSchema,
  presenceStateSchema,
  presencePeerSchema,
  parseClientMessage,
  safeParseClientMessage,
} from "./messages.js";

export type {
  ClientMessage,
  ServerMessage,
  RealtimeActor,
  PresenceState,
  PresencePeer,
} from "./messages.js";
