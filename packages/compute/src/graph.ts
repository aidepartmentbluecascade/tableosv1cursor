import type { FieldDependencyEdge, FieldGraphNode } from "./types.js";

export interface FieldDependencyGraph {
  nodes: FieldGraphNode[];
  /** depends_on → dependent (downstream recompute edges). */
  adjacency: Map<string, string[]>;
  edges: FieldDependencyEdge[];
}

export function buildFieldGraph(
  fieldIds: string[],
  dependencies: FieldDependencyEdge[],
): FieldDependencyGraph {
  const adjacency = new Map<string, string[]>();
  for (const id of fieldIds) {
    adjacency.set(id, []);
  }
  for (const dep of dependencies) {
    if (!adjacency.has(dep.dependsOnFieldId)) {
      adjacency.set(dep.dependsOnFieldId, []);
    }
    if (!adjacency.has(dep.dependentFieldId)) {
      adjacency.set(dep.dependentFieldId, []);
    }
    adjacency.get(dep.dependsOnFieldId)!.push(dep.dependentFieldId);
  }
  return {
    nodes: fieldIds.map((fieldId) => ({ fieldId })),
    adjacency,
    edges: dependencies,
  };
}
