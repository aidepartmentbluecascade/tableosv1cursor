import type { FieldDependencyGraph } from "./graph.js";
import { topoOrder } from "./topo.js";

export interface PropagationPlan {
  /** Field ids to recompute, in safe dependency order. */
  fieldIds: string[];
  /** Estimated record touch count (caller supplies fan-out estimate). */
  estimatedFanOut: number;
}

/**
 * Plan which computed fields must refresh when the given source fields changed.
 */
export function planPropagation(
  graph: FieldDependencyGraph,
  changedFieldIds: string[],
): PropagationPlan {
  const changed = new Set(changedFieldIds);
  const affected = new Set<string>();

  const queue = [...changed];
  while (queue.length > 0) {
    const source = queue.shift()!;
    for (const dependent of graph.adjacency.get(source) ?? []) {
      if (!affected.has(dependent)) {
        affected.add(dependent);
        queue.push(dependent);
      }
    }
  }

  const subgraphNodes = [...affected].sort();
  const subgraph: FieldDependencyGraph = {
    nodes: subgraphNodes.map((fieldId) => ({ fieldId })),
    adjacency: new Map(
      subgraphNodes.map((id) => [
        id,
        (graph.adjacency.get(id) ?? []).filter((t) => affected.has(t)),
      ]),
    ),
    edges: graph.edges.filter(
      (e) => affected.has(e.dependentFieldId) && affected.has(e.dependsOnFieldId),
    ),
  };

  const ordered = topoOrder(subgraph).filter((id) => affected.has(id));

  return {
    fieldIds: ordered,
    estimatedFanOut: ordered.length,
  };
}
