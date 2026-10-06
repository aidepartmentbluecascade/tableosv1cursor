## Tabula backend audit: findings

I read every file I cite below. No files were modified. Paths are relative to `E:\Blue Cascade\Projects\32TableOSClaudeCode`.

### Top 6 (fix first)
1. **Computed fields are never computed.** Nothing writes `data.field_dependencies`, so formula, lookup, rollup and count fields are always empty.
2. **Query filter and sort ignore public field IDs.** Every filter returns zero rows and every sort falls back to manual order.
3. **Two migrations are silently skipped.** Invitations break (500) and every audit write fails silently.
4. **Permissions are missing almost everywhere.** Reads, schema and base changes, imports, shares and automations only check org membership. Invites allow privilege escalation and billing upgrades are free.
5. **Event-bus consumers compete for the same queue.** Each domain event reaches only one of the notification and search-index handlers.
6. **Link data can be silently lost.** Editing a record can delete links that were created from the other side of the relationship.

---

### Migrations / DB
- **P0: invitations are broken.** `packages/db/migrations/0005_mvp_platform.sql:189` creates `core.invitations` with `resource_type`, `resource_id` and `invited_by NOT NULL`. `0006_mfa_invites.sql:15` uses `CREATE TABLE IF NOT EXISTS`, so its version (`workspace_id`, `email_normalized`, `accepted_at`, `accepted_by`, `updated_at`) never applies. `apps/server/src/modules/invitations/routes.ts:52-58,109,165` reads and writes those missing columns, so create and accept both return 500. **Fix:** add a new migration that `ALTER`s `core.invitations` to add the columns and drops or defaults `resource_type`/`resource_id`.
- **P1: audit log never writes.** The same `IF NOT EXISTS` clash affects `audit.audit_events`. The 0005 shape (`actor_type NOT NULL`, `actor_id`, `resource_*`, `meta`) wins. `modules/audit/write.ts:23-36` inserts `workspace_id`, `actor_user_id`, `target_type`, `metadata` and `user_agent`, and its `catch {}` swallows the error, so every audit event is lost. **Fix:** an ALTER migration, and log the error instead of swallowing it.
- **P2: RLS is effectively off.** `0005:9-15` passes every row when `app.workspace_id` is unset. `withTenant` (`packages/db/src/with-tenant.ts`) is never called from `apps/server`. **Fix:** wrap data-plane transactions in `withTenant`, or fail closed.

### Kernel / errors
- **P1: realtime publishes before commit.** `kernel/mutation.ts:138-150` publishes to Redis inside the transaction. Clients see changes that may later roll back. **Fix:** return the payload and publish after `db.transaction()` resolves.
- **P2: empty batch is a 500.** `base_changes.op_count CHECK >= 1` (`0003`). A batch create with `records: []` (`records/routes.ts:263-301`) gives empty `ops`, which hits the constraint. **Fix:** require `.min(1)` in zod.
- **P1: bad IDs are 500s.** `lib/public-ids.ts:12` calls `decodePublicId`, which throws a plain `Error`. `http/errors.ts:105` only maps `PublicIdError`, which only the unused `wrapPublicId` produces. Any malformed ID in a path or body returns 500. These are also 500 for the same reason:
  - unique-name violations (23505) for table, field and link inverse names
  - FK violations (for example `view_favorites`)
  - `INVALID_CURSOR`, `INVALID_FILTER_AST`
  - `LINK_CARDINALITY`, `LINK_FIELD_NOT_FOUND`

  **Fix:** have `parsePid` throw `PublicIdError`, and map pg codes 23505 → 409 and 23503 → 404/422 in `handleRouteError`.
- **P2: wrong code on 500s.** `errors.ts:124-133` sends them with the code `VALIDATION_FAILED`.

### Access / permissions
- **P1: membership is the only check on reads and many writes.** `access/helpers.ts:5-26,29-71` grants access to every org member regardless of grants.
  - These have no `assertCan` at all:
    - table create, rename, delete and field update/delete (`schema/routes.ts:82-248,395-505`)
    - base rename/delete (`base/routes.ts:254-365`)
    - views (all of them)
    - query, comments, attachments, shares, import/export
    - automations, contacts merge, `/changes`
  - Automation DELETE (`automations/routes.ts:205-221`) and comment reactions (`comments/routes.ts:154-183`) don't even resolve base access. Any logged-in user who knows the IDs can act.

  **Fix:** call `compileForUser` + `assertCan` in every handler (`base.read`, `record.comment`, `export.data`, `base.manage_schema`).
- **P1: invite privilege escalation.** `invitations/routes.ts:16-20,40-44`: any org member (even a viewer) can invite with `role: "owner"`. **Fix:** require `base.manage_members` and cap the role at the inviter's own.
- **P2: org-level grants ignored.** `access/compile.ts:20-31` never loads `resource_type='org'` grants. `compileSnapshot` ignores org owners and admins.

### Records
- **P1: plan-limit counter drifts up.** Create increments `base_runtime.record_count` (`records/routes.ts:102-106`). Delete (`:508-510`), undo of create and contact merge never decrement it. `LimitsService.assertCanCreateRecord` (`billing/limits-service.ts:175`) reads that counter, so users hit the limit after deleting records. **Fix:** decrement on delete and increment on restore, inside the same transaction.
- **P1: no input validation.** `schema/field-map.ts:25-52` accepts any value for any field, including computed, autonumber and `created_*` fields. `@tabula/fields` `validate`/`normalize` is never called by the server. Unknown keys are silently dropped. **Fix:** run the registry's `validate`+`normalize`, reject writes to computed/read-only types, and return 422 on unknown fields.
- **P2: delete of a missing record still succeeds.** `records/routes.ts:493-510` doesn't check the row exists. It returns 204 and still decrements `tables.record_count`. Linked records' lookups and rollups are not recomputed.
- **P2: `atomic` is ignored.** It is accepted by `batchBody` (`:42`) but unused. A duplicate client `id` in a batch → PK violation 500.

### Compute (formula / lookup / rollup / count)
- **P0: nothing is ever computed.** Nothing writes `data.field_dependencies`; the only reference is the SELECT in `compute/schema.ts:83-91`. With no dependency edges, `planPropagation` returns nothing, so `recomputeInTx` returns at `recompute-in-tx.ts:201-203`. Field create (`schema/routes.ts:357-366`) does no backfill. **Fix:**
  - On computed-field create or config update, parse the formula and the link/lookup config, insert dependency rows (including `via_link_field_id`), and backfill existing records.
  - Run cycle detection (`packages/compute/src/cycles.ts`).
- **P1: cross-table dependents never update.** `recompute-in-tx.ts:237-238` skips fields on other tables, and targets are only the edited record. Editing table B never refreshes lookups/rollups on the A records linked to it. **Fix:** for dependents reached via a link field, expand the targets through `record_links` to the peer records.
- **P1: formulas only see raw cells.** `recompute-in-tx.ts:102-106` passes `row.cells` only, so formulas referencing other computed fields get `undefined`. Names are resolved at eval time, so renaming a field breaks formulas silently. **Fix:** pass merged cells plus computed values, and store field IDs in the formula AST.
- **P1: deferred recompute loses work.**
  - `compute/jobs.ts:38-51` passes the stale field IDs as seeds. `planPropagation` (`packages/compute/src/propagation.ts:18-31`) excludes seeds, so the stale fields themselves are never recomputed.
  - If fan-out is still over 500, it re-defers with `redis=null` (no job enqueued) and then deletes the stale rows.

  **Fix:** in the worker, compute the stale field set directly. Never re-defer from the worker, or delete only the rows you actually recomputed.
- **P1: job enqueued before commit.** `recompute-in-tx.ts:218-225` adds the job inside the transaction, so the worker can run before the `computed_stale` rows are visible. **Fix:** enqueue after commit.

### Links
- **P1 (data loss): inverse links get clobbered.** `post-write.ts:92-99` syncs every link slot present in the merged cells (`record-links.ts:180-195`). The link routes (`links/routes.ts:206-225`) update only the calling side's cell; the peer record's inverse cell is never updated. Later, editing any field on the peer re-syncs from its stale inverse array and deletes links created from the other side. **Fix:**
  - Only sync link slots in `changedSlots`, not all cells.
  - Maintain both sides' cells, or derive link cells from `record_links` at read time.
- **P2: link targets are not validated.** `record-links.ts:138-160` doesn't check targets exist in the peer table or base, and stores pids or uuids inconsistently in `cells`.
- **P2: plain `link` fields have no relation.** A `link` (or `contact`) field created through generic `POST /fields` gets no `link_relations` row, so its writes are silently ignored.
- **P2: deletes leave links behind.**
  - Deleting a link field doesn't remove the relation or the inverse field.
  - Deleting a table leaves link fields and relations pointing at it; compute still reads that table's records.

### Query / filter / sort
- **P0: filter and sort never resolve fields.**
  - `query/context.ts:309-310` keys `fieldSlotById` by uuid.
  - The web client sends public IDs (`apps/web/src/routes/table-grid.tsx:73-76`, fields come from `pid("fld",…)`), and the server never decodes them.
  - Result: `compileCondition` returns `FALSE` (`packages/filter/src/sql.ts:200-204`), so every filtered query returns zero rows. Unresolved sorts fall back to `manual_order` (`build-record-query.ts:19-21`). Same in `group-query.ts:39`.

  **Fix:** in `buildPlanContext`, map both pid and uuid (or decode the IDs in the route).
- **P1: numbers sort as text.** `build-record-query.ts:37` sorts by `cells->>'slot'`, so 10 sorts before 9.
- **P1: field-sort pagination skips rows.**
  - ORDER BY always uses `id ASC`, but the DESC cursor uses `<` on `id` too.
  - Null sort keys compare as NULL in the row comparison (`:72-79`).
  - Rows are skipped or duplicated, and rows with nulls vanish after page 1.

  **Fix:** use a typed sort expression, match the id direction to the sort direction, and handle NULLS LAST explicitly in the cursor predicate.
- **P1 (live once the pid bug is fixed): eq filters on date/checkbox crash.** `sql.ts:22-34,256-259` treats `date` and `checkbox` as numeric for `eq`. `(cells->>'k')::double precision` then throws on `'2024-01-01'` or `'true'`, giving a 500. Any non-numeric text in a number cell also crashes gt/lt, because writes are unvalidated. **Fix:** use type-specific expressions plus a safe cast.
- **P1: computed fields can't be filtered or sorted.** Filters and sorts only read `cells`, never `computed`. Computed values are returned as `{value,status}` objects (`execute-record-query.ts:149-152`).
- **P2: field projection is ignored.** `fields` is accepted (`query/routes.ts:17`) but unused.
- **P2: sidecar indexes are dead code.** `recordstore/sidecars.ts:166-189`, `planner.ts:43-50` and `filter/sql.ts:31-33` use camelCase type names (`dateTime`, `singleLineText`, `singleSelect`, `longText`). The DB stores snake_case types (`datetime`, `text`, `single_select`, `long_text`), so text and time sidecars are never written and `date`→num gives NaN. Nothing ever sets `index_state='ready'`, so sidecars are never read.

### Schema (tables / fields)
- **P1: some field types 500 on create.** `schema/routes.ts:321`: `getFieldType` throws a plain Error for DB-allowed types missing from the registry (`duration`, `barcode`, `attachment`, `collaborator`, `button`, `ai_generated`, `json`).
- **P1: field updates are unsafe.** There is no field type change, and config PATCH (`:430-434`) is neither validated nor rebuilt into dependencies or a recompute.
- **P2: field delete has gaps.**
  - The primary field can be deleted.
  - Updating or deleting a nonexistent field returns 200/204.
- **P2: auto-value fields are always empty.** `autonumber`, `created_time`, `modified_time`, `created_by` and `modified_by` are never materialized in cells or query output.
- **P2: no table limit.** `tablesPerBase` is never enforced.

### Views
- **P1: no view delete or reorder endpoint** (`views/routes.ts`).
- **P2: visibility changes are dropped.** PATCH `visibility` (`:42`) is accepted but never written.
- **P2: anyone can edit any view.** Locked and other users' personal views can be edited by anyone.
- **P2: other view gaps.**
  - PATCH on a nonexistent view returns 200.
  - Favoriting an invalid view → FK 500.

### History / undo / trash
- **P1: undo never advances.** `history/routes.ts:54-70` always selects the latest non-undo change. A second undo re-applies the same inverse, and earlier changes are unreachable. **Fix:** track undone seqs (e.g., an `undone_by_seq` column, or exclude seqs referenced by undo ops).
- **P1: redo deletes the record.** `routes.ts:197-203` runs the original forward ops through `applyInverseOpsInTx`, where `record.created` soft-deletes (`apply-inverse.ts:41-50`). Redo of an undone create leaves the record deleted. **Fix:** add a separate forward-op applier.
- **P1: schema changes block undo forever.** Inverses for schema, view and link changes (`table.renamed`, `field.deleted`, `link_fields.deleted`, `base.renamed`) fall to `default` and do nothing (`apply-inverse.ts:84`). Undo returns success, and that change stays "latest". **Fix:** implement these inverses, or store `inverse_ops: null` for unsupported kinds.
- **P2: undo/restore skip side effects.** Neither touches sidecars, `record_links`, compute or record counts. Undo of create soft-deletes without a deletion batch, so it can't be restored. `changeId` can target other users' changes, and a non-numeric value gives a NaN → 500 (`:38`). There is no trash listing endpoint.

### Auth / session
- **P1: MFA is never enforced.** It can be enabled, but login (`auth/routes.ts:148-205`) never checks it.
- **P1: Google login can take over accounts.** `auth/routes.ts:361-370` links a Google identity to an existing account by email without checking `email_verified`.
- **P2: dev-only and missing protections.**
  - The ws-ticket URL is hardcoded to `ws://127.0.0.1` (`:235`).
  - OAuth state and pending MFA secrets are kept in process memory.
  - Login has no rate limit.
  - OAuth sessions are recorded as `auth_method='password'`.

### Billing
- **P1: free upgrades.** `billing/routes.ts:74-98` lets any org member upgrade to Team for free, despite the comment saying owner/admin only. **Fix:** require the owner/billing_admin role and gate behind a payment flag.

### Import / export
- **P1: import bypasses most checks.** `import-export/routes.ts:37-171`:
  - It takes JSON rows, not CSV or XLSX.
  - There is no `record.create` check and no plan-limit check.
  - It skips sidecars, link sync and compute.
  - It opens one base transaction per row (5000 change_seqs and outbox events).

  **Fix:** add a real parser, run inside the worker, and reuse `insertOneRecord` + `afterRecordCellWrite`.
- **P2: export is incomplete.** Export (`:198-236`) omits computed values, silently truncates at 10,000 rows, and doesn't guard against CSV formula injection (`=`, `+`, `-`, `@`). There is no XLSX.

### Share links / forms
- **P1: share links are a stub.** `/v1/public/shares/:token` (`share/routes.ts:128-215`) returns only metadata. There is no public records endpoint and no form-submission endpoint. `form` targets aren't checked to be form views (`:51-54`), and there is no revoke or list endpoint.
- **P2: password and token handling.** The share password is sent in the query string. A malformed token makes `decodeURIComponent` throw, giving a 500.

### Comments / notifications
- **P2: comment create gaps.** `comments/routes.ts:76-139` doesn't check the record exists and has no `record.comment` permission check.
- **P2: mention notifications can reach anyone.** Mentions notify arbitrary user IDs, including users outside the org.
- **P2: malformed mention UUIDs crash.** The regex `[0-9a-f-]{36}` (`mentions.ts:1`) admits invalid UUIDs, causing a 500.
- **P2: missing comment features.** There is no edit or delete endpoint, and reactions are not returned by GET.

### Worker / relay / events
- **P1: event consumers compete.** `packages/events/src/bullmq-bus.ts:38-51` gives each `subscribe` a BullMQ Worker on the same queue. Workers on one queue compete for jobs, so `collab-notifications` and `search-indexer` (`entrypoints/worker.ts:42-56`) each see only some events. **Fix:** one queue per consumer group (fan out on publish), or use Redis Streams consumer groups.
- **P1: search index goes stale.**
  - The `record.updated` payload (`records/routes.ts:435`, `apply-field-update.ts:206`) has no `tableId`, so the indexer (`collab/worker-handlers.ts:91`) skips updates.
  - The `record.deleted` payload is `{}`, so deleted records are never removed.
  - `records.batch_created` and imports-from-batch are never indexed.

  **Fix:** always include `tableId` and `recordId` in the payload.
- **P2: relay problems.**
  - `entrypoints/relay.ts:85-88` uses `setInterval` with no overlap guard or `FOR UPDATE SKIP LOCKED`, so slow ticks can double-publish.
  - The actor is overwritten to `system` (`:57`), so the comment author's ID is lost. Comment events don't go through the outbox at all; they are published after commit, so they are lost if publishing fails.
- **P1: Redis connection leak.** `packages/jobs` `createQueue` duplicates a Redis connection on every call and never closes it. It is called per request in `attachments/routes.ts:115`, `recompute-in-tx.ts:219` and `import-export/routes.ts:156`. **Fix:** cache queues as singletons.
- **P2: several queues have no real handler.**
  - `AUTOMATION_*`, `IMPORT`, `EMAIL` and `NOTIFICATION` jobs are log-only.
  - Nothing produces automation triggers, so automations never run.
  - The file scan marks files `clean` without scanning.
  - The declared upload size is never checked against the actual object.

### Idempotency
- **P2: duplicate requests can both run.** `http/idempotency.ts:113-122`: when `INSERT … ON CONFLICT DO NOTHING` affects 0 rows, the request still runs. Check `numInsertedRows`.
- **P2: bad cached replays.** Replaying a stored 204 does `JSON.parse("")` (`:102-105`), giving a 500. 5xx responses are cached as completed, so retries replay the error.

### Contacts
- **P2: contact merge is incomplete.** `contacts/routes.ts:96-108`:
  - It soft-deletes any record in the workspace by ID, not just contacts.
  - It doesn't repoint links to the survivor.
  - It writes no base_changes, record counts or permission checks.

### Field types not supported end-to-end
| Type | Gap |
|---|---|
| formula, lookup, rollup, count | Never computed (no dependency rows). Can't be filtered or sorted. Lookup config needs raw UUIDs while clients use pids. |
| autonumber, created/modified time/by | Never populated. |
| date, checkbox | eq filter → SQL cast error, once the pid bug is fixed. |
| number, currency, percent | Lexicographic sort. No write validation. |
| datetime, text-like | Sidecar type-name mismatch. |
| attachment, collaborator, duration, barcode, button, ai_generated, json | Allowed by the DB, missing from the registry. Create returns 500. |
| link, contact | Inverse cells not maintained; the clobbering bug above. The generic field endpoint creates a link with no relation. |
