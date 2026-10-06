export const WorkspaceRoles = [
  "owner",
  "creator",
  "editor",
  "commenter",
  "viewer",
] as const;
export type WorkspaceRole = (typeof WorkspaceRoles)[number];

export const BaseRoles = [
  "creator",
  "editor",
  "commenter",
  "viewer",
  "interface_only",
] as const;
export type BaseRole = (typeof BaseRoles)[number];

const WORKSPACE_RANK: Record<WorkspaceRole, number> = {
  owner: 50,
  creator: 40,
  editor: 30,
  commenter: 20,
  viewer: 10,
};

const BASE_RANK: Record<BaseRole, number> = {
  creator: 40,
  editor: 30,
  commenter: 20,
  viewer: 10,
  interface_only: 5,
};

export function mapWorkspaceRoleToBase(role: WorkspaceRole): BaseRole {
  switch (role) {
    case "owner":
    case "creator":
      return "creator";
    case "editor":
      return "editor";
    case "commenter":
      return "commenter";
    case "viewer":
      return "viewer";
    default:
      return "viewer";
  }
}

export function maxWorkspaceRole(a: WorkspaceRole, b: WorkspaceRole): WorkspaceRole {
  return WORKSPACE_RANK[a] >= WORKSPACE_RANK[b] ? a : b;
}

export function maxBaseRole(a: BaseRole, b: BaseRole): BaseRole {
  return BASE_RANK[a] >= BASE_RANK[b] ? a : b;
}
