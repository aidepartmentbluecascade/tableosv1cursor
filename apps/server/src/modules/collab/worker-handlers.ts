import type { TabulaDb } from "@tabula/db";
import type { DomainEvent } from "@tabula/events";
import { CommentEvents, RecordEvents } from "@tabula/events";
import type { SearchBackend } from "@tabula/search";
import { generateUuidV7 } from "@tabula/types";
import { sql } from "kysely";
import { indexRecordDocument } from "./record-index.js";

export async function handleCommentCreatedNotification(
  db: TabulaDb,
  event: DomainEvent,
): Promise<void> {
  if (event.type !== CommentEvents.CREATED) return;
  const baseId = event.tenant.baseId;
  if (!baseId) return;

  const data = event.data as {
    commentId?: string;
    recordId?: string;
    tableId?: string;
  };
  const commentId = data.commentId;
  const recordId = data.recordId;
  const tableId = data.tableId;
  const authorId = event.actor.id;
  if (!commentId || !recordId || !tableId) return;

  const subs = await sql<{ user_id: string }>`
    SELECT user_id FROM data.record_subscriptions
    WHERE workspace_id = ${event.tenant.workspaceId}
      AND base_id = ${baseId}
      AND table_id = ${tableId}
      AND record_id = ${recordId}
  `.execute(db);

  const mentions = await sql<{ principal_id: string }>`
    SELECT principal_id FROM data.mentions
    WHERE comment_id = ${commentId} AND principal_type = 'user'
  `.execute(db);

  const recipientIds = new Set<string>();
  for (const s of subs.rows) {
    if (s.user_id !== authorId) recipientIds.add(s.user_id);
  }
  for (const m of mentions.rows) {
    if (m.principal_id !== authorId) recipientIds.add(m.principal_id);
  }

  for (const userId of recipientIds) {
    await sql`
      INSERT INTO core.notifications (
        id, user_id, workspace_id, base_id, category, title, body
      ) VALUES (
        ${generateUuidV7()},
        ${userId},
        ${event.tenant.workspaceId},
        ${baseId},
        'comment',
        'New comment on a record you follow',
        ${JSON.stringify({ commentId, recordId, tableId })}::jsonb
      )
    `.execute(db);
  }
}

export async function handleSearchIndexEvent(
  db: TabulaDb,
  search: SearchBackend,
  event: DomainEvent,
): Promise<void> {
  const baseId = event.tenant.baseId;
  if (!baseId) return;

  if (
    event.type !== RecordEvents.CREATED &&
    event.type !== RecordEvents.UPDATED &&
    event.type !== RecordEvents.DELETED
  ) {
    return;
  }

  const data = event.data as {
    tableId?: string;
    aggregateId?: string;
    recordId?: string;
  };
  const tableId = data.tableId;
  const recordId =
    data.aggregateId ??
    (typeof data.recordId === "string" ? data.recordId : undefined);
  if (!tableId || !recordId) return;

  if (event.type === RecordEvents.DELETED) {
    await search.remove(baseId, "record", recordId);
    return;
  }

  await indexRecordDocument(db, search, {
    workspaceId: event.tenant.workspaceId,
    baseId,
    tableId,
    recordId,
  });
}

export async function handleFileScanJob(
  db: TabulaDb,
  payload: { attachmentId: string },
): Promise<void> {
  await sql`
    UPDATE data.attachments
    SET scan_status = 'clean'
    WHERE id = ${payload.attachmentId}
      AND scan_status IN ('pending', 'scanning')
  `.execute(db);
}
