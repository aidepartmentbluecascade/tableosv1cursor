import type { BaseRole } from "./roles.js";
import { mapWorkspaceRoleToBase, maxBaseRole, type WorkspaceRole } from "./roles.js";

export interface AccessGrantRow {
  resource_type: "org" | "workspace" | "base" | "interface";
  resource_id: string;
  workspace_id?: string | null;
  base_id?: string | null;
  role: string;
}

export interface CompileSnapshotInput {
  baseId: string;
  workspaceId: string;
  grants: AccessGrantRow[];
}

export interface PermissionSnapshot {
  baseId: string;
  workspaceId: string;
  effectiveBaseRole: BaseRole | null;
  permEpoch: number;
}

/**
 * Compile effective base role from grant rows (workspace + base scoped).
 * @param grants — rows from `core.access_grants` for the principal
 */
export function compileSnapshot(
  input: CompileSnapshotInput,
  permEpoch?: number,
): PermissionSnapshot;
export function compileSnapshot(
  grants: AccessGrantRow[],
  context: Pick<CompileSnapshotInput, "baseId" | "workspaceId">,
  permEpoch?: number,
): PermissionSnapshot;
export function compileSnapshot(
  inputOrGrants: CompileSnapshotInput | AccessGrantRow[],
  permEpochOrContext?: number | Pick<CompileSnapshotInput, "baseId" | "workspaceId">,
  permEpoch = 1,
): PermissionSnapshot {
  const input: CompileSnapshotInput = Array.isArray(inputOrGrants)
    ? {
        baseId: (permEpochOrContext as Pick<CompileSnapshotInput, "baseId" | "workspaceId">)
          .baseId,
        workspaceId: (
          permEpochOrContext as Pick<CompileSnapshotInput, "baseId" | "workspaceId">
        ).workspaceId,
        grants: inputOrGrants,
      }
    : inputOrGrants;
  const epoch = Array.isArray(inputOrGrants)
    ? (typeof permEpochOrContext === "number" ? permEpochOrContext : permEpoch)
    : (permEpochOrContext as number | undefined) ?? 1;

  return compileSnapshotInner(input, epoch);
}

function compileSnapshotInner(
  input: CompileSnapshotInput,
  permEpoch: number,
): PermissionSnapshot {
  let role: BaseRole | null = null;

  for (const grant of input.grants) {
    if (grant.resource_type === "base" && grant.base_id === input.baseId) {
      const baseRole = grant.role as BaseRole;
      role = role ? maxBaseRole(role, baseRole) : baseRole;
    }
    if (
      grant.resource_type === "workspace" &&
      grant.workspace_id === input.workspaceId
    ) {
      const mapped = mapWorkspaceRoleToBase(grant.role as WorkspaceRole);
      role = role ? maxBaseRole(role, mapped) : mapped;
    }
  }

  return {
    baseId: input.baseId,
    workspaceId: input.workspaceId,
    effectiveBaseRole: role,
    permEpoch,
  };
}

export { compileSnapshotInner as compileSnapshotFromInput };
