/** Canonical domain event type strings (see architecture §6). */

export const IdentityEvents = {
  USER_CREATED: "user.created",
  USER_UPDATED: "user.updated",
  USER_DEACTIVATED: "user.deactivated",
  SESSION_CREATED: "session.created",
  SESSION_REVOKED: "session.revoked",
  MFA_ENROLLED: "mfa.enrolled",
  API_TOKEN_CREATED: "api_token.created",
  API_TOKEN_REVOKED: "api_token.revoked",
} as const;

export const TenancyEvents = {
  ORGANIZATION_CREATED: "organization.created",
  ORGANIZATION_UPDATED: "organization.updated",
  WORKSPACE_CREATED: "workspace.created",
  WORKSPACE_UPDATED: "workspace.updated",
  WORKSPACE_DELETED: "workspace.deleted",
  WORKSPACE_RESTORED: "workspace.restored",
  MEMBER_ADDED: "member.added",
  MEMBER_ROLE_CHANGED: "member.role_changed",
  MEMBER_REMOVED: "member.removed",
  TEAM_UPDATED: "team.updated",
  INVITATION_CREATED: "invitation.created",
  INVITATION_ACCEPTED: "invitation.accepted",
  GRANT_CHANGED: "grant.changed",
} as const;

export const BaseEvents = {
  CREATED: "base.created",
  UPDATED: "base.updated",
  DELETED: "base.deleted",
  RESTORED: "base.restored",
  DUPLICATED: "base.duplicated",
} as const;

export const TableEvents = {
  CREATED: "table.created",
  UPDATED: "table.updated",
  DELETED: "table.deleted",
  RESTORED: "table.restored",
} as const;

export const FieldEvents = {
  CREATED: "field.created",
  UPDATED: "field.updated",
  TYPE_CHANGED: "field.type_changed",
  DELETED: "field.deleted",
  RESTORED: "field.restored",
} as const;

export const LinkRelationEvents = {
  CREATED: "link_relation.created",
  DELETED: "link_relation.deleted",
} as const;

export const RecordEvents = {
  CREATED: "record.created",
  UPDATED: "record.updated",
  DELETED: "record.deleted",
  RESTORED: "record.restored",
  BULK_CHANGED: "records.bulk_changed",
  LINKS_CHANGED: "record.links_changed",
  COMPUTED_UPDATED: "record.computed_updated",
  ASSIGNED: "record.assigned",
} as const;

export const ViewEvents = {
  CREATED: "view.created",
  UPDATED: "view.updated",
  DELETED: "view.deleted",
  RESTORED: "view.restored",
} as const;

export const InterfaceEvents = {
  CREATED: "interface.created",
  UPDATED: "interface.updated",
  PUBLISHED: "interface.published",
  DELETED: "interface.deleted",
} as const;

export const CommentEvents = {
  CREATED: "comment.created",
  UPDATED: "comment.updated",
  DELETED: "comment.deleted",
} as const;

export const CollaborationEvents = {
  MENTION_CREATED: "mention.created",
  REACTION_ADDED: "reaction.added",
  FORM_SUBMITTED: "form.submitted",
  BUTTON_CLICKED: "button.clicked",
} as const;

export const ContactEvents = {
  CREATED: "contact.created",
  UPDATED: "contact.updated",
  MERGED: "contact.merged",
  UNMERGED: "contact.unmerged",
  ACTIVITY_LOGGED: "contact.activity_logged",
} as const;

export const AttachmentEvents = {
  UPLOADED: "attachment.uploaded",
  SCANNED: "attachment.scanned",
  PROCESSED: "attachment.processed",
  REJECTED: "attachment.rejected",
} as const;

export const AutomationEvents = {
  CREATED: "automation.created",
  PUBLISHED: "automation.published",
  PAUSED: "automation.paused",
  TRIGGERED: "automation.triggered",
  COMPLETED: "automation.completed",
  FAILED: "automation.failed",
  STEP_FAILED: "automation.step_failed",
  DISABLED_BY_SYSTEM: "automation.disabled_by_system",
} as const;

export const IntegrationEvents = {
  CONNECTED: "integration.connected",
  TOKEN_REFRESHED: "integration.token_refreshed",
  AUTH_FAILED: "integration.auth_failed",
  DISCONNECTED: "integration.disconnected",
  INBOUND_WEBHOOK_RECEIVED: "inbound_webhook.received",
  SYNC_COMPLETED: "sync.completed",
  SYNC_FAILED: "sync.failed",
} as const;

export const SharingEvents = {
  SHARE_LINK_CREATED: "share_link.created",
  SHARE_LINK_REVOKED: "share_link.revoked",
  SHARE_LINK_ACCESSED: "share_link.accessed",
} as const;

export const AiEvents = {
  INVOCATION_COMPLETED: "ai.invocation_completed",
  INVOCATION_FAILED: "ai.invocation_failed",
  FIELD_VALUE_GENERATED: "ai_field.value_generated",
} as const;

export const HistoryEvents = {
  SNAPSHOT_CREATED: "snapshot.created",
  SNAPSHOT_RESTORED: "snapshot.restored",
  TRASH_PURGED: "trash.purged",
  CHANGE_UNDONE: "change.undone",
  CHANGE_REDONE: "change.redone",
} as const;

export const JobEvents = {
  IMPORT_COMPLETED: "import.completed",
  IMPORT_FAILED: "import.failed",
  EXPORT_COMPLETED: "export.completed",
  LONG_OPERATION_PROGRESSED: "long_operation.progressed",
  LONG_OPERATION_COMPLETED: "long_operation.completed",
} as const;

export const BillingEvents = {
  SUBSCRIPTION_CHANGED: "subscription.changed",
  USAGE_THRESHOLD_REACHED: "usage.threshold_reached",
  LIMIT_EXCEEDED: "limit.exceeded",
} as const;
