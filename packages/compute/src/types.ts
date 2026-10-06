export interface FieldDependencyEdge {
  dependentFieldId: string;
  dependsOnFieldId: string;
  viaLinkFieldId?: string | null;
}

export interface FieldGraphNode {
  fieldId: string;
}

export interface ComputedValue {
  value: unknown;
  status: "ok" | "error" | "stale";
  error?: string;
}

export interface StaleMarker {
  tableId: string;
  recordId: string;
  fieldId: string;
  enqueuedAt?: string;
}
