import type { FieldDependencyGraph } from "./graph.js";

/** Topological order of fields for recompute (dependencies before dependents). */
export function topoOrder(graph: FieldDependencyGraph): string[] {
  const inDegree = new Map<string, number>();
  for (const { fieldId } of graph.nodes) {
    inDegree.set(fieldId, 0);
  }
  for (const [, targets] of graph.adjacency) {
    for (const t of targets) {
      inDegree.set(t, (inDegree.get(t) ?? 0) + 1);
    }
  }

  const queue: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }
  queue.sort();

  const order: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    order.push(id);
    for (const next of graph.adjacency.get(id) ?? []) {
      const d = (inDegree.get(next) ?? 1) - 1;
      inDegree.set(next, d);
      if (d === 0) {
        queue.push(next);
        queue.sort();
      }
    }
  }

  if (order.length !== graph.nodes.length) {
    return order;
  }
  return order;
}
