import type { TabulaDb } from "@tabula/db";
import { sql } from "kysely";

export interface AuditEventInput {
  orgId?: string | null;
  workspaceId?: string | null;
  actorUserId?: string | null;
  actorType?: "user" | "system" | "automation";
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  metadata?: Record<string, unknown>;
  ip?: string | null;
  userAgent?: string | null;
}

interface AuditLogger {
  error: (obj: unknown, msg?: string) => void;
}

let auditLogger: AuditLogger = {
  error: (obj, msg) => {
    console.error(msg ?? "audit write failed", obj);
  },
};

/** Route audit failures to the app logger (called once at startup). */
export function setAuditLogger(logger: AuditLogger): void {
  auditLogger = logger;
}

/**
 * Insert an audit row. Audit failures never fail the calling request, but
 * they are logged (they used to be silently swallowed).
 */
export async function writeAuditEvent(
  db: TabulaDb,
  event: AuditEventInput,
): Promise<void> {
  try {
    await sql`
      INSERT INTO audit.audit_events (
        org_id, workspace_id, actor_type, actor_id, actor_user_id, action,
        target_type, target_id, resource_type, resource_id,
        metadata, meta, ip, user_agent
      ) VALUES (
        ${event.orgId ?? null},
        ${event.workspaceId ?? null},
        ${event.actorType ?? (event.actorUserId ? "user" : "system")},
        ${event.actorUserId ?? null},
        ${event.actorUserId ?? null},
        ${event.action},
        ${event.targetType ?? null},
        ${event.targetId ?? null},
        ${event.targetType ?? null},
        ${event.targetId ?? null},
        ${JSON.stringify(event.metadata ?? {})}::jsonb,
        ${JSON.stringify(event.metadata ?? {})}::jsonb,
        ${event.ip ?? null},
        ${event.userAgent ?? null}
      )
    `.execute(db);
  } catch (err) {
    auditLogger.error({ err, action: event.action }, "audit write failed");
  }
}
