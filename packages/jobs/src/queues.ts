/** BullMQ queue names from the platform spine (architecture §7). */

export const QueueNames = {
  COMPUTE: "compute",
  AUTOMATION_TRIGGER: "automation-trigger",
  AUTOMATION_STEP: "automation-step",
  WEBHOOK_OUT: "webhook-out",
  EMAIL: "email",
  NOTIFICATION: "notification",
  SEARCH_INDEX: "search-index",
  FILE_SCAN: "file-scan",
  FILE_PROCESS: "file-process",
  IMPORT: "import",
  EXPORT: "export",
  AI: "ai",
  SYNC: "sync",
  SNAPSHOT: "snapshot",
  PURGE: "purge",
  MAINTENANCE: "maintenance",
} as const;

export type QueueName = (typeof QueueNames)[keyof typeof QueueNames];

export const ALL_QUEUE_NAMES: readonly QueueName[] = Object.values(QueueNames);
