import { authorize, type Action, type PermissionSnapshot } from "@tabula/permissions";

export class ForbiddenActionError extends Error {
  readonly action: Action;

  constructor(action: Action) {
    super(`Forbidden: ${action}`);
    this.name = "ForbiddenActionError";
    this.action = action;
  }
}

export function assertCan(snapshot: PermissionSnapshot, action: Action): void {
  if (!authorize(snapshot, action)) {
    throw new ForbiddenActionError(action);
  }
}
