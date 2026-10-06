export interface DomainEvent<T = unknown> {
  id: string;
  type: string;
  schemaVersion: number;
  occurredAt: string;
  tenant: { orgId: string; workspaceId: string; baseId?: string };
  actor: { type: string; id: string | null; via: string };
  baseSeq?: number;
  correlationId?: string;
  causationId?: string;
  causationDepth: number;
  data: T;
}
