import type { TabulaDb } from "@tabula/db";
import { sql } from "kysely";

export interface AuditEventInput {
  orgId?: string | null;
  workspaceId?: string | null;
  actorUserId?: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  metadata?: Record<string, unknown>;
  ip?: string | null;
  userAgent?: string | null;
}

/** Best-effort audit row insert (no-op if audit schema not migrated). */
export async function writeAuditEvent(
  db: TabulaDb,
  event: AuditEventInput,
): Promise<void> {
  try {
    await sql`
      INSERT INTO audit.audit_events (
        org_id, workspace_id, actor_user_id, action, target_type, target_id,
        metadata, ip, user_agent
      ) VALUES (
        ${event.orgId ?? null},
        ${event.workspaceId ?? null},
        ${event.actorUserId ?? null},
        ${event.action},
        ${event.targetType ?? null},
        ${event.targetId ?? null},
        ${JSON.stringify(event.metadata ?? {})}::jsonb,
        ${event.ip ?? null},
        ${event.userAgent ?? null}
      )
    `.execute(db);
  } catch {
    // MVP: tolerate missing migration in dev
  }
}
