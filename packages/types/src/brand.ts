export type Brand<T, B extends string> = T & { readonly __brand: B };

export type OrgId = Brand<string, "OrgId">;
export type WorkspaceId = Brand<string, "WorkspaceId">;
export type UserId = Brand<string, "UserId">;
export type BaseId = Brand<string, "BaseId">;
export type TableId = Brand<string, "TableId">;
export type FieldId = Brand<string, "FieldId">;
export type RecordId = Brand<string, "RecordId">;
export type ViewId = Brand<string, "ViewId">;
export type SessionId = Brand<string, "SessionId">;
export type ShardId = Brand<string, "ShardId">;
export type EventId = Brand<string, "EventId">;
export type ChangeId = Brand<string, "ChangeId">;
export type TokenId = Brand<string, "TokenId">;

export function asBrand<T extends Brand<string, string>>(value: string): T {
  return value as T;
}
