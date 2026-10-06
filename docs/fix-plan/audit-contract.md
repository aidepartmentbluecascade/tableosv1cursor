# Tabula frontend/backend contract audit (read-only, no files changed)

Paths below are relative to `E:\Blue Cascade\Projects\32TableOSClaudeCode`.

## Summary
- **Core grid flows match.** Signup, login, `me`, workspaces, bases, `getBase`, tables, views (list, create, favorite), automations, record create/patch and undo all line up on path, method, `bas_`/`tbl_`/`fld_`/`rec_`/`viw_` IDs and the main response fields.
- **Most of the "wave 4" features are broken against the server.** Attachments, CSV import, sharing and the whole public app, search, notifications, contacts, and the comment author field have the wrong path, body or response shape.
- **Filtering and sorting can never work.** The frontend sends `fld_` public IDs, but the query planner looks fields up by raw UUID.
- **Realtime is wired up but does nothing for the grid.** The change ops the server sends are never applied by the client, and the grid never refetches when a change arrives.

## 1. Mismatches

| # | Frontend | Server | Problem | Fix |
|---|---|---|---|---|
| 1 | `apps/web/src/lib/api.ts:289` (`queryRecords` filter/sort); `routes/table-grid.tsx:73-76`; `features/views/ViewToolbar.tsx:41` | `modules/query/routes.ts:57-67`, `query/context.ts:51-52`, `packages/filter/src/sql.ts:140-143`, `packages/query/src/planner.ts:35` | `fieldSlotById` is keyed by raw UUID, but the client sends `fld_…` IDs. Every filter condition compiles to `FALSE` (no rows), and sorts get no slot. | In the query route, rewrite `filter.fieldId` and `sort[].field` with `parsePid(...,"fld")` before planning, or key `fieldSlotById` by `pid("fld", id)`. |
| 2 | `routes/table-grid.tsx:98` (`enabled: viewKind !== "grid"`), `features/grid/DomGrid.tsx:76-79` | — | The grid view's query never sends filter or sort, so the toolbar filter/sort does nothing in grid view. | Pass `filter` and `sort` into `DomGrid`'s query. |
| 3 | `api.ts:296` `cursor?: string \| null` | `query/routes.ts:16` `cursor: z.string().optional()` | Sending `cursor: null` gets a 422. `fields` is accepted but ignored. | Use `z.string().nullish()`, or have the client omit null. |
| 4 | `api.ts:406-446` (`presignAttachment`, `completeAttachment`, `listAttachments`), used at `features/record/RecordExpandDrawer.tsx:28-62` | `modules/attachments/routes.ts:29,79,131` | **Path:** the client posts to `/v1/bases/:b/tables/:t/records/:r/attachments/{presign,complete}` and lists via GET on `…/attachments`. The server only has `/v1/bases/:b/attachments/{presign,complete}` and `GET /v1/bases/:b/attachments/:attId`, so all three client calls 404. There is no list route, and attachments are not linked to records server-side. **Body:** the client sends `{fileName, contentType, size}`; the server wants `{filename, mime, size}`. **Response:** the client expects `{uploadId, uploadUrl, method, headers}`; the server returns `{attachmentId, objectKey, upload:{url,method,headers}}`. **Complete:** the client sends `uploadId`; the server wants `attachmentId`. **Upload URL:** `uploadPresigned` (api.ts:426) prefixes `API_BASE` onto what is an absolute GCS URL. | Pick one contract. Simplest is to change the client to the base-scoped routes and field names, and add a `record_id` column plus a `GET …/records/:r/attachments` list route. Don't prefix absolute upload URLs. |
| 5 | `api.ts:448` `importCsv` → `POST /v1/bases/:b/tables/:t/import` with `{csv, hasHeader}`; `features/import/ImportWizard.tsx:59` reads `result.imported`, `result.jobId` | `modules/import-export/routes.ts:38` `POST /v1/bases/:b/import/csv` with `{tableId, filename?, rows: object[]}` | 404. Even with the right path, the body is wrong (raw CSV string vs pre-parsed rows). The response is `{importJobId, rowsImported, rowsFailed, status}`. | Parse the CSV client-side into `rows` keyed by field name or `fld_` ID, post to `/import/csv` with `tableId`, and map the response fields. |
| 6 | `api.ts:367` `createShare` → `POST /v1/bases/:b/tables/:t/shares` with `{viewId, kind}`, expects `{token, kind, publicPath}`; `features/share/ShareDialog.tsx:28-35` | `modules/share/routes.ts:34` `POST /v1/bases/:b/shares` with `{targetType:"view"\|"form", targetId}`, returns `{share:{id, token, …}}` | 404. Body and response are both mismatched: `data.token` would be undefined. | Change the client to `/v1/bases/:b/shares`, `{targetType, targetId: viewId}`, read `res.share.token`. `viewId` is optional in the client but required by the server. |
| 7 | `apps/public/src/lib/public-api.ts:38-44` `fetchShare` expects `{kind, title, baseId, tableId, fields[], records[]}` | `share/routes.ts:129-210` returns `{share:{id, workspaceId, baseId, targetType, targetId}}` | The public app gets no table ID, fields or records. The read-only table and form render empty or crash. | Extend the public GET to resolve the view's table and return fields and records (permission-filtered), plus `kind` from `targetType`. |
| 8 | `public-api.ts:50` `POST /v1/public/shares/:token/submit` | none | Form submission always 404s. | Add a public submit route that validates the token, checks `target_type='form'` and inserts via `insertOneRecord`/`withBaseTx`. |
| 9 | `public-api.ts:63-83` fallback `POST /v1/bases/:b/tables/:t/records` with an `X-Tabula-Share-Token` header | `http/auth-hook.ts:150-154`; the header is never read | The fallback always returns 401 (no cookie). | Remove the fallback once #8 exists. |
| 10 | `api.ts:459` `search` expects `{results:[{kind, id, title, href}]}`; `features/search/SearchPalette.tsx:43` | `modules/search/routes.ts:23,44-56` returns `{hits:[{documentId, baseId, docType, refId, title, rank}]}` | The search palette always shows nothing. | Map `hits` to `results` on the client, or rename on the server. Base navigation should use `baseId`. |
| 11 | `api.ts:464` `notifications` expects `{notifications:[{readAt, body:string}], unreadCount}`; `features/notifications/NotificationsBell.tsx:26,46-49` | `modules/notifications/routes.ts:36-46` returns `{notifications:[{read:boolean, body:jsonb, category, …}]}` with no `unreadCount` | The badge is always 0. Every item looks unread because `readAt` is undefined. If `body` is a JSON object, `<p>{n.body}</p>` will throw. | Return `unreadCount` and `readAt` from the server (or adapt the client), and stringify or shape `body`. |
| 12 | `api.ts:476` `workspaceContacts` expects `{contacts:[{id, workspaceId, name, email}]}`; `routes/contacts.tsx:27-30` | `modules/contacts/routes.ts:58-63` returns `{contactDirectoryBaseId, contacts:[{id, fields: <slot-keyed raw cells>}]}` | `name` and `email` are always blank. The GET also has a side effect (`ensureContactDirectory` creates a base). | Map slots to named fields on the server (`name`, `email`). |
| 13 | `api.ts:483-489` `CommentDto.authorName`, `recordId`; `RecordExpandDrawer.tsx:92` | `modules/comments/routes.ts:60-68` returns `{id, parentId, body, createdBy (usr_), createdAt, updatedAt}` | The author name renders empty. POST (`:141`) returns only `{id, body, createdAt}`. | Join `core.users` and return `authorName`, or display `createdBy`. |
| 14 | `api.ts:349-365` `createField` | `modules/schema/routes.ts:381-388` | The response has no `config`, so server-defaulted select options and formula expressions are missing from the returned DTO. Mitigated because `onSchemaChange` refetches the base. Separately, an unknown `type` throws a generic Error from `getFieldType` and becomes a 500, not a 422. | Include `config` in the 201 response. Validate `type` with zod. |
| 15 | `api.ts:329-347` `patchRecord` returns a typed `RecordDto` | `modules/records/routes.ts:440-442` returns `{record:{id, changeSeq}}` | No `version` or `fields` in the response. The UI ignores it today (it invalidates instead), but the type is wrong and rapid successive edits reuse a stale `version`, giving 409s. | Return `version: currentVersion+1` and the merged `fields` (`fld_`-keyed). |
| 16 | `api.ts:45-46` sends `X-Tabula-Client-Op-Id` | not read anywhere on the server (only `idempotency-key`, `http/idempotency.ts:61`) | Dead header. `DomGrid` never passes it anyway. | Send `Idempotency-Key`, or drop it. |
| 17 | `api.ts:222` / `ViewDto.config`; `routes/base.tsx:86` | `views/routes.ts:182-190` (create response has no config); `base/routes.ts:236-245` (`getBase` views have no config) | View config is never loaded or persisted. Filter, sort and hidden fields are local state only. The `PATCH …/views/:viewId` route exists but is unused. The "Rename view" menu item (`features/views/ViewsSidebar.tsx:100-107`) only closes the menu. | Add `patchView` to the client and persist toolbar state to `config`. |
| 18 | `api.ts:310` `undoBase` | `history/routes.ts:104-106` | "Nothing to undo" comes back as 409 `VERSION_CONFLICT`. Also, the latest-change query excludes undo/redo kinds, so a second undo re-applies the same change's inverse rather than stepping back. | Return a distinct code. Track undone seqs. |
| 19 | all routes with path params | `lib/public-ids.ts:11-16`, `http/errors.ts:105,124-133` | `parsePid` throws a plain Error. `wrapPublicId` is used once in the codebase, so a malformed or wrong-prefix ID gives a **500**, not a 404/422. | Throw `PublicIdError` from `parsePid`. |
| 20 | `api.ts:306` `wsTicket` | `auth/routes.ts:235` | The URL is hard-coded to `ws://127.0.0.1:${REALTIME_PORT}/v1/ws`. It only works because `resolveWsUrl` rewrites localhost to the Vite `/ws` proxy. Breaks in any non-local deploy. | Build it from a `REALTIME_PUBLIC_URL` env var. |
| 21 | Auth/CSRF | `http/app.ts:32-35`, `http/auth-hook.ts`, `auth/session.ts:42` | No CSRF token anywhere; the client sends none. Protection rests on `SameSite=Lax` plus CORS (`origin: APP_URL` only). With `VITE_API_URL` set, the public app (port 5174) would be CORS-blocked. In dev it works only through the Vite proxy. | Add the public origin to CORS. Optionally add a double-submit CSRF header. |
| 22 | — | `schema/routes.ts:395-505` (field PATCH/DELETE), `views/routes.ts` (create/patch), `automations/routes.ts` (all), `comments` | No `assertCan` calls. Any base reader can change the schema, views or automations. | Add `assertCan(…,"base.manage_schema")` etc. |

Verified consistent: signup, login and `me` (`{user:{id usr_, email, name}}`); workspaces; workspace bases; createBase (`{id, name}`, 201); `getBase` (tables, fields, views with `fld_`/`viw_`, `primaryFieldId`); createTable (`{table}`); list views; favorite/unfavorite; automations list, create and patch (trigger enums match `features/automations/AutomationsPanel.tsx`); createRecord (`{record:{id rec_, version, fields fld_…}}`, handled by the unwrapping in `api.ts:326`); `PATCH` record with `If-Match`; `markNotificationRead`; comments paths and POST body `{body}`; filter AST shape and op names.

## 2. Server routes never called by the frontend
- **Auth:** `POST /v1/auth/logout` (there is no sign-out UI), `/v1/auth/mfa/setup`, `/v1/auth/mfa/enable`, `GET /v1/auth/google`, `/v1/auth/google/callback`.
- **Workspaces:** `POST /v1/workspaces`.
- **Invitations:** `POST /v1/invitations`, `/v1/invitations/accept`.
- **Bases:** `PATCH` and `DELETE /v1/bases/:b`, `GET /v1/bases/:b/changes` (useful for realtime catch-up).
- **Tables:** `GET /v1/bases/:b/tables`, `PATCH` and `DELETE /v1/bases/:b/tables/:t`.
- **Fields:** `GET`, `PATCH` and `DELETE …/fields[/:f]`. There is no rename or delete field UI.
- **Records:** `POST …/records/batch`, `DELETE …/records/:r` (no delete-record UI), `POST …/records/group` (grouping is not server-backed).
- **Views:** `PATCH …/views/:v`.
- **History:** `POST /v1/bases/:b/redo`, `/trash/restore`.
- **Automations:** `DELETE …/automations/:id`.
- **Links:** `POST …/link-fields`, `POST` and `DELETE …/records/:r/links`. There is no link-field UI path.
- **Attachments, comments, contacts, export:** `GET /v1/bases/:b/attachments/:id`, `POST /v1/bases/:b/comments/:c/reactions`, `POST /v1/workspaces/:w/contacts/merge`, `POST /v1/bases/:b/export/csv`.
- **Billing and flags:** `GET /v1/billing/plan`, `POST /v1/billing/upgrade`, `/checkout`, `GET /v1/feature-flags`.
- **Matching the right route at the wrong path:** `/attachments/presign` and `/complete`, `/import/csv` and `/shares` (see #4–6).

## 3. Frontend calls with no server route (404)
- `POST /v1/bases/:b/tables/:t/records/:r/attachments/presign` (`api.ts:413`)
- `POST /v1/bases/:b/tables/:t/records/:r/attachments/complete` (`api.ts:443`)
- `GET /v1/bases/:b/tables/:t/records/:r/attachments` (`api.ts:402`)
- `POST /v1/bases/:b/tables/:t/import` (`api.ts:454`)
- `POST /v1/bases/:b/tables/:t/shares` (`api.ts:376`)
- `POST /v1/public/shares/:token/submit` (`public-api.ts:50`)
- `auth-hook.ts:37` whitelists `PUT /v1/uploads/*`, but no such route exists.

## 4. Realtime issues

**Ticket flow works.** `POST /v1/auth/ws-ticket` → client opens `ws?ticket=…` with subprotocol `tabula.v1` → gateway consumes the ticket from the query string and sends `hello` (`entrypoints/realtime.ts:519-545`) → client emits `connected` and sends `subscribe` with a `bas_` ID → server replies `subscribed` and catch-up.

**Problems:**
1. **Change ops never reach the grid.** The server forwards internal mutation ops such as `{op:"record.updated", recordId:<raw uuid>, cells:{<slot>:value}}` (`records/routes.ts:423`, `records/apply-field-update.ts:189`, `kernel/mutation.ts:139-149`). The client keeps only `op === "setCell" | "setComputed"` with `rec_`/`fld_` IDs (`features/base/BaseSessionProvider.tsx:60-67`), so every op is dropped. Even when ops are applied, `RecordStore` feeds only `CanvasTableGrid`, which is never mounted; the live grid is `DomGrid`, which reads react-query. Remote edits appear only after a manual refetch.
   - Fix: translate ops in the gateway to `setCell` with `pid` IDs and add `tableId`. On `change`, also invalidate `["records", baseId, tableId]`.
2. **Ack versions are lost.** `op_ack` is sent as `{clientMutationId, seq, version}` (`realtime.ts:384-389`). The client reads `ack.recordVersions` (`BaseSessionProvider.tsx:75-83`), so the version is never applied.
3. **Presence shape doesn't match.** The server sends `{type:"presence", peers:[{userId, state}]}` (`realtime.ts:190`). The client expects `upsert` and `remove` with `connId` and `user` (`packages/realtime-client/src/types.ts:273-279`), so `applyPresence(undefined, undefined)` runs. The client also never sends `presence` messages.
4. **Resync never happens.** The server never sends `resync_required`, so `onResync` (`routes/base.tsx:119`) is dead. Catch-up is capped at 500 rows (`realtime.ts:155`) with no signal when truncated.
5. **Double subscribe.** On `hello`, both the client (`client.ts:197-199`) and the provider's `connected` listener (`BaseSessionProvider.tsx:52-55`) send `subscribe`. The server increments the Redis channel refcount twice (`realtime.ts:247-252`) but releases once on close, so the channel is never unsubscribed, and catch-up frames are sent twice.
6. **Published before commit.** `publishBaseChange` fires inside the transaction (`kernel/mutation.ts:138-150`). Clients can see a change that later rolls back, or refetch before the commit lands. Publish after commit instead.
7. **Change frames have no `tableId` or `kind`.** The protocol omits them (`packages/realtime-protocol/src/messages.ts:78-84`), but the client type has them (`types.ts:246-258`). `actor.id` is a raw UUID, not `usr_`.
8. **Websocket edits are unused.** `RealtimeClient.sendOp` and the gateway `op` handler work, but nothing in `apps/web` calls `sendOp`; all edits go through REST `PATCH`.

## 5. Route registration
`http/app.ts:69-82` registers auth, invitations, workspace, base, schema, records, links, history, query, views, wave4, billing, feature-flags and automations. `modules/wave4/routes.ts:16-22` registers attachments, comments, notifications, search, share, import-export and contacts. **Every `modules/*/routes.ts` file is registered.** Modules with no routes file (access, audit, collab, compute, organization, recordstore) are helpers.

`http/openapi.ts` documents `/v1/bases` and `/v1/bases/{baseId}/query`, neither of which exists. The real routes are `/v1/workspaces/:w/bases` and `…/tables/:t/records/query`.

**Highest-priority fixes:** #1 (filters), the realtime op translation plus grid invalidation, then #4–#8 (attachments, import, share and the public app).
