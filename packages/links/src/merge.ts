import type { LinkSetOp, MergedLinkOps } from "./types.js";

/**
 * Merge link set-operations so add/remove commute (order-independent).
 * A later add cancels a pending remove for the same id and vice versa.
 */
export function mergeLinkOps(ops: LinkSetOp[]): MergedLinkOps {
  const state = new Map<string, "add" | "remove">();
  const addOrder = new Map<string, string | undefined>();

  for (const op of ops) {
    if (op.kind === "add") {
      state.set(op.recordId, "add");
      if (op.order !== undefined) {
        addOrder.set(op.recordId, op.order);
      }
    } else {
      state.set(op.recordId, "remove");
      addOrder.delete(op.recordId);
    }
  }

  const add: MergedLinkOps["add"] = [];
  const remove: string[] = [];

  for (const [recordId, kind] of state) {
    if (kind === "add") {
      const order = addOrder.get(recordId);
      add.push(order !== undefined ? { recordId, order } : { recordId });
    } else {
      remove.push(recordId);
    }
  }

  add.sort((a, b) => a.recordId.localeCompare(b.recordId));
  remove.sort();

  return { add, remove };
}
