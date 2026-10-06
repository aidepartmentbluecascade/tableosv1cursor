import type { FilterAst, FilterNode } from "./ast.js";

const MAX_GROUP_DEPTH = 8;

function groupDepth(node: FilterNode, depth = 0): number {
  if (node.kind === "condition") return depth;
  const childDepth = Math.max(
    ...node.children.map((c) => groupDepth(c, depth + 1)),
    depth,
  );
  return childDepth;
}

function isFilterNode(value: unknown): value is FilterNode {
  if (!value || typeof value !== "object") return false;
  const o = value as Record<string, unknown>;
  if (o["kind"] === "condition") {
    return typeof o["fieldId"] === "string" && typeof o["op"] === "string";
  }
  if (o["kind"] === "and" || o["kind"] === "or") {
    return Array.isArray(o["children"]) && o["children"].every(isFilterNode);
  }
  return false;
}

/** Parse persisted / API filter JSON into a validated AST (depth ≤ 8). */
export function parseFilterAst(input: unknown): FilterAst | null {
  if (input === undefined || input === null) return null;
  if (!isFilterNode(input)) {
    throw new Error("INVALID_FILTER_AST");
  }
  if (groupDepth(input) > MAX_GROUP_DEPTH) {
    throw new Error("FILTER_DEPTH_EXCEEDED");
  }
  return input;
}

export { MAX_GROUP_DEPTH };
