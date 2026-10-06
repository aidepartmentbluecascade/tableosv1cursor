import type { Action } from "./actions.js";
import type { BaseRole } from "./roles.js";
import type { PermissionSnapshot } from "./snapshot.js";

const ROLE_ACTIONS: Record<BaseRole, ReadonlySet<Action>> = {
  creator: new Set([
    "base.read",
    "base.manage_schema",
    "base.manage_members",
    "record.read",
    "record.create",
    "record.update",
    "record.delete",
    "record.comment",
    "view.read",
    "view.create_collaborative",
    "view.update",
    "export.data",
    "api.access",
  ]),
  editor: new Set([
    "base.read",
    "record.read",
    "record.create",
    "record.update",
    "record.delete",
    "record.comment",
    "view.read",
    "view.create_collaborative",
    "view.update",
    "export.data",
    "api.access",
  ]),
  commenter: new Set([
    "base.read",
    "record.read",
    "record.comment",
    "view.read",
    "view.create_collaborative",
    "export.data",
    "api.access",
  ]),
  viewer: new Set([
    "base.read",
    "record.read",
    "view.read",
    "view.create_collaborative",
    "export.data",
    "api.access",
  ]),
  interface_only: new Set(["record.read", "view.read"]),
};

export function authorize(snapshot: PermissionSnapshot, action: Action): boolean {
  const role = snapshot.effectiveBaseRole;
  if (!role) return false;
  return ROLE_ACTIONS[role].has(action);
}
