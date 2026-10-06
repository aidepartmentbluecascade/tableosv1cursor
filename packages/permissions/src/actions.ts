export const Actions = [
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
] as const;

export type Action = (typeof Actions)[number];
