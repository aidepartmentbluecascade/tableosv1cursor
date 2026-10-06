import type { FieldDependencyGraph } from "./graph.js";

export interface CycleDetectionResult {
  hasCycle: boolean;
  cyclePath?: string[];
}

/** Detect cycles in the dependent-field graph (depends_on → dependent). */
export function detectCycles(graph: FieldDependencyGraph): CycleDetectionResult {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];

  const dfs = (node: string): string[] | null => {
    if (visiting.has(node)) {
      const idx = stack.indexOf(node);
      return idx >= 0 ? [...stack.slice(idx), node] : [node, node];
    }
    if (visited.has(node)) {
      return null;
    }
    visiting.add(node);
    stack.push(node);
    for (const next of graph.adjacency.get(node) ?? []) {
      const cycle = dfs(next);
      if (cycle) return cycle;
    }
    stack.pop();
    visiting.delete(node);
    visited.add(node);
    return null;
  };

  for (const { fieldId } of graph.nodes) {
    const cycle = dfs(fieldId);
    if (cycle) {
      return { hasCycle: true, cyclePath: cycle };
    }
  }

  return { hasCycle: false };
}
