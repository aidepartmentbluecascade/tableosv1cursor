# 20 — Import, Export, Sharing & Integrations

> **Status:** Proposed for architectural approval · **Owner:** Platform (Data Mobility, Sharing, Integrations) · **Date:** 2026-10-03
> Conforms to [`00-canonical-decisions.md`](./00-canonical-decisions.md) (D12, D15, D16, D19, D20, D21, §4, §5, §6, §9, §11, §12). API contracts: [`31-api-specification.md`](./31-api-specification.md) §8, §20, §24. Cross-cutting API behavior: [`17-api-architecture.md`](./17-api-architecture.md).

**Sections covered:** Section 26 (Import) · Section 27 (Export & Sharing) · Section 28 (Integrations) · Part 22 (Import pipeline) · Part 23 (Sharing & public access) · Part 24 (Integration framework & connectors)

Related: [`07-field-engine.md`](./07-field-engine.md) (import coercion), [`11-filter-sort-group.md`](./11-filter-sort-group.md), [`14-automation-engine.md`](./14-automation-engine.md), [`16-realtime.md`](./16-realtime.md), [`19-permissions-and-multitenancy.md`](./19-permissions-and-multitenancy.md), [`25-security-observability-infrastructure.md`](./25-security-observability-infrastructure.md).

---

## Table of contents

**Part A — Import**
1. Goals and scope
2. Pipeline overview
3. Upload and file handling
4. Analysis: encoding, delimiter, header, type detection
5. Mapping model (`import_jobs.mapping`)
6. Modes: create table, append, upsert
7. Duplicate detection
8. Validation and coercion
9. Execution at scale
10. Automations, events and realtime during imports
11. Progress, cancellation, rollback
12. Error reporting
13. Limits and failure modes

**Part B — Export**
14. Export model
15. Formats and encoding
16. Permission enforcement
17. Large exports and delivery

**Part C — Sharing**
18. Sharing surfaces and principals
19. Invitations
20. Share links: token architecture
21. Access modes: public, password, email-restricted, expiring
22. What a public viewer can see (projection)
23. Embeds
24. Revocation, analytics, abuse prevention
25. Token & secret architecture table

**Part D — Integrations**
26. Integration framework goals
27. ConnectorManifest and ConnectorRuntime
28. Connections and credential storage
29. Token refresh and secret rotation
30. Inbound provider webhooks
31. Polling triggers
32. Sync sources (synced tables)
33. Third-party connectors: packaging, registry, sandboxing
34. Connector examples: Slack, Gmail, Google Calendar, CRM, generic HTTP
35. Proposed additions

---

# Part A — Import

## 1. Goals and scope

| Goal | Target |
|---|---|
| Formats | CSV/TSV (any delimiter), Excel `.xlsx` (and `.xls` via conversion, V1), JSON (array of objects, JSONL), paste-from-clipboard (TSV via the same pipeline, synchronous for ≤ 5k rows) |
| Size | Up to 500 MB files / 2M rows (bounded by plan record limits, Spine §12) |
| Throughput | ≥ 20k records/min per import on a healthy shard (bounded also by the `records_written` budget, raised ×4 for import jobs — imports are the explicit bulk path) |
| UX | Type detection good enough that ≥ 90% of columns need no manual correction; errors downloadable; one-click rollback |
| Correctness | Same coercion rules as API `typecast` (`17-…` §9.4); no partially-visible half-imports without a clear status |

Non-goals (MVP): Google Sheets live link (that's a **sync source**, Part D), `.numbers`, Access databases.

## 2. Pipeline overview

```
 Client                  API (import module)                 import worker (BullMQ queue `import`)
 ──────                  ───────────────────                 ──────────────────────────────────────
 1 attachments:init  ─▶  presigned PUT → tabula-uploads-quarantine
 2 PUT file to S3
 3 POST /imports     ─▶  import_jobs(status=uploaded) + long_operations ─▶ ANALYZE job
                                                                   ├ ClamAV scan (file-scan queue)
                                                                   ├ stream first 5 MB / 10k rows
                                                                   ├ encoding, delimiter, header detect
                                                                   ├ per-column type inference
                                                                   └ import_jobs.analysis, status=analyzed
 4 GET /imports/{id} ◀─  analysis + suggested mapping (realtime push too)
 5 PUT …/mapping     ─▶  validate mapping vs schema; dry-run 1k-row validation preview (status=ready)
 6 POST …:start      ─▶  status=running ─────────────────────────▶ EXECUTE job
                                                                   ├ (create mode) create table+fields (1 tx)
                                                                   ├ stream full file → rows
                                                                   ├ coerce → validate → batch of 1000
                                                                   ├ each batch: own tx; records + base_changes + outbox
                                                                   ├ import_errors rows for failures
                                                                   ├ checkpoint (row offset, byte offset) per batch
                                                                   └ progress → long_operations + WS
 7 completed         ◀─  import.completed event; notification; error CSV available
```

State machine (`import_jobs.status`):

```
uploaded → scanning → analyzing → analyzed → (mapping set) ready → running → succeeded | completed_with_errors | failed
                       ↘ rejected (malware / unparseable)          ↘ cancelling → cancelled (→ rolled_back)
succeeded/completed_with_errors → rolling_back → rolled_back
```

## 3. Upload and file handling

* Upload via the standard attachment flow (`31-…` §17) with `purpose: "import"`: lands in `tabula-uploads-quarantine`, 7-day lifecycle (Spine §11). Import files are **not** promoted to `tabula-attachments` — they are transient inputs; the import job references `quarantine/{workspaceId}/imports/{importId}/source`.
* Malware scan is mandatory before parsing (xlsx is a zip; zip-bomb protection: max uncompressed size 2 GB, max ratio 100:1, max entries 10k).
* Parsing runs in the `import` worker pool, with per-job memory cap (`--max-old-space-size` per process; one large import per process) — never in the API process.
* Streaming parsers:
  * **CSV:** `csv-parse` (streaming, RFC 4180 + relaxed quotes) fed by `iconv-lite` decoding stream.
  * **XLSX:** `exceljs` **streaming WorkbookReader** (row events, shared strings handled incrementally). Rationale vs SheetJS: SheetJS CE loads the workbook into memory (fine ≤ 50 MB, problematic beyond), while exceljs' streaming reader has bounded memory. We use SheetJS only for `.xls` legacy conversion (V1) and for sheet listing of small files. Dates: Excel serial numbers converted with the workbook's 1900/1904 date system; cell number formats are captured as hints for type detection (e.g. `"$#,##0.00"` ⇒ currency).
  * **JSON:** `stream-json` (array streaming) or line-delimited for JSONL. Nested objects flattened with dot paths (`address.city`) for mapping; arrays of scalars → candidate multi-select/list; arrays of objects → `json` field or ignored.

## 4. Analysis

Analysis reads at most **10,000 rows / 5 MB** (configurable) — enough for robust inference, cheap for huge files. Results stored in `import_jobs.analysis jsonb`.

### 4.1 Encoding detection

1. BOM (UTF-8, UTF-16 LE/BE) wins.
2. Valid UTF-8 check over sample (strict decoder) → UTF-8.
3. Else `chardet`-style statistical detection (`jschardet`) constrained to a candidate set: `windows-1252`, `ISO-8859-1/15`, `Shift_JIS`, `GB18030`, `EUC-KR`, `windows-1251`. Confidence stored; < 0.6 ⇒ UI asks the user (preview of the first lines in top-3 encodings).

### 4.2 Delimiter sniffing

Candidates `,`, `;`, `\t`, `|`. For each: parse first 50 lines with quote awareness; score = consistency of field count (mode frequency) × mean field count > 1. Ties: prefer `,`, then `;` for locales with decimal comma (`de`, `fr`, …). `.tsv` extension → `\t` preferred.

### 4.3 Header detection

Row 1 is a header if: all non-empty, mostly unique, mostly non-numeric/non-date strings, **and** its type profile differs from rows 2..n (e.g. row 1 all text while column 3 is numeric below). Score threshold 0.7; otherwise headers synthesised `Column 1…n` and user can toggle. XLSX: also skips leading empty/title rows (first row whose non-empty count ≥ 50% of max width).

### 4.4 Type detection with confidence

For each column, each sampled non-empty value is tested by ordered **recognizers** (from the field engine's `importDetect` hooks, `07-field-engine.md`); the column type is the most specific type whose match ratio ≥ threshold.

| Candidate type | Recognizer | Threshold | Extra inferred config |
|---|---|---|---|
| `checkbox` | `true/false/yes/no/1/0/x/✓/""` with ≤ 3 distinct tokens | 0.98 | |
| `number` / `percent` / `currency` | locale-aware numeric parse; `%` suffix; currency symbols/ISO codes; XLSX number format hint | 0.95 | `precision` (max decimals seen), `currencyCode` |
| `date` / `datetime` | try format set (ISO, `MM/DD/YYYY`, `DD/MM/YYYY`, `D MMM YYYY`, …) — choose the **single format** with highest match; disambiguate M/D vs D/M by values > 12 | 0.95 | `dateFormat` for parsing, `includesTime`, tz assumption (job `timeZone`) |
| `email`, `url`, `phone` | RFC-ish regex; URL parser; libphonenumber with default region from job locale | 0.9 | |
| `single_select` | distinct count ≤ max(20, 5% of rows) and avg length ≤ 40 and repeats | 0.9 | options from distinct values (ordered by frequency) |
| `multi_select` | values containing separators (`,`/`;`) with small distinct token universe | 0.9 | delimiter |
| `collaborator` | ≥ 0.9 of values are emails of workspace members | 0.9 | |
| `link` (append/upsert into existing link field only) | values match primary field of the target table | n/a (user-chosen) | |
| `long_text` | any value > 255 chars or contains newline | — | |
| `text` | fallback | — | |

Output per column:

```json
{ "index": 3, "header": "Close date", "sampleValues": ["03/04/2026", "11/22/2026", "…"],
  "nonEmptyRatio": 0.97, "distinctCount": 812,
  "detected": { "type": "date", "confidence": 0.993, "config": { "parseFormat": "MM/DD/YYYY" } },
  "alternatives": [ { "type": "text", "confidence": 1.0 } ],
  "anomalies": [ { "row": 418, "value": "TBD", "reason": "not a date" } ] }
```

Confidence = match ratio over non-empty sample, penalized when the sample is small (< 50 values: × n/50). The UI highlights columns with confidence < 0.9 or anomalies.

## 5. Mapping model (`import_jobs.mapping`)

```json
{
  "mode": "upsert",
  "target": { "tableId": "tbl_Deals…" },
  "newTable": null,
  "sheet": "Q3 pipeline",
  "headerRow": 1,
  "encoding": "utf-8",
  "delimiter": ",",
  "locale": "en-US",
  "timeZone": "America/New_York",
  "columns": [
    { "sourceIndex": 0, "action": "map", "fieldId": "fld_Name…" },
    { "sourceIndex": 1, "action": "map", "fieldId": "fld_Email…", "transform": { "trim": true, "lowercase": true } },
    { "sourceIndex": 2, "action": "create_field", "newField": { "name": "Region", "type": "single_select", "config": { } } },
    { "sourceIndex": 3, "action": "map", "fieldId": "fld_Close…", "parse": { "dateFormat": "MM/DD/YYYY" } },
    { "sourceIndex": 4, "action": "map", "fieldId": "fld_Company…", "link": { "matchOn": "primary", "createMissing": true } },
    { "sourceIndex": 5, "action": "skip" }
  ],
  "upsert": { "matchOn": ["fld_Email…"], "onMultipleMatches": "error", "updateEmptyCells": false },
  "dedupe": { "withinFile": "keep_last" },
  "selectOptions": { "createMissing": true },
  "errorPolicy": { "onRowError": "skip_row", "maxErrors": 10000 },
  "automations": { "triggerAutomations": "respect_setting" }
}
```

* `action`: `map` (existing field), `create_field` (append/upsert into existing table — requires `field.create`), `skip`.
* `updateEmptyCells: false` — empty source cells do **not** clear target values in upsert (the common expectation); `true` clears.
* `errorPolicy.onRowError`: `skip_row` (default), `import_raw_as_text_fallback` (create-table mode only: value preserved in a sibling text column), `abort`.
* Mapping is validated against schema at `PUT …/mapping` and again at start (schema may change in between; `schemaVersion` stored). A field deleted/retyped after mapping → job returns to `analyzed` with a problem explaining the conflict.

## 6. Modes

| Mode | Behavior | Permissions | Notes |
|---|---|---|---|
| **create_table** | Create table + fields from mapping (types from detection), then insert all rows. Primary field = first mapped text-like column (user can change) | `table.create`, `field.create`, `record.create` | Table creation + fields in one tx before data; the table is flagged `importing` (UI shows banner, realtime still works) |
| **append** | Insert all rows as new records | `record.create` (+ field `create_field` actions need `field.create`) | Respects `tables.restrictions.recordCreate` |
| **upsert** | Match on 1–3 key fields (normalized), update matched, insert unmatched | `record.create` + `record.update` | Same semantics as API batch upsert (`17-…` §12) incl. advisory lock per key; `onMultipleMatches: error\|update_all\|skip` |

Upsert key lookup at scale: per batch, collect key tuples → one `SELECT id, key… FROM records/record_index_text WHERE table_id = $1 AND key IN (…)` using typed sidecar indexes (auto-created for the match fields of a job if the table exceeds `INDEX_SIDECAR_THRESHOLD`; index build happens before execution as part of the job).

## 7. Duplicate detection

Two levels:

1. **Within the file** (`dedupe.withinFile`: `keep_first` | `keep_last` | `keep_all` | `error`): during analysis we can't see the whole file, so execution maintains a key → row map. Memory bound: keys are hashed (16-byte xxhash128) — 2M rows ≈ 64 MB; beyond that spill to a Redis set with job TTL. `keep_last` requires a first pass over the file (two-pass streaming: pass 1 builds hash → last row index; pass 2 imports) — acceptable since S3 re-reads are cheap.
2. **Against existing records** (append mode, optional `dedupe.againstExisting: { fieldIds, action: "skip" | "flag" }`): same lookup as upsert matching; `flag` imports but writes a row in `import_errors` with severity `warning` code `DUPLICATE_EXISTING` so users can review.

Contacts directory imports additionally use `contact_identifiers` normalization (email lowercasing, E.164) and can route to the contacts merge flow (`onDuplicate: merge`, `31-…` §16).

## 8. Validation and coercion

* Each cell passes `FieldTypeDefinition.coerceImport(raw: string | number | boolean | Date, ctx)` → `{ ok: value } | { error: { code, message } }`, where `ctx` contains locale, tz, parse hints, select-option resolver (with create-missing callback buffered per batch), collaborator resolver (email → user), link resolver.
* `coerceImport` is the same function as API `typecast` (single implementation), with the import-specific parse hints (explicit date format) taking precedence over heuristics.
* **Select option creation** is batched: new option names collected per batch, created via one schema mutation (bumps `schemaVersion` once per batch at most, not per row) — critical to avoid thousands of schema events.
* **Link resolution**: by primary field display value (exact, case-insensitive optional); unresolved with `createMissing: true` → targets created in the linked table in the same batch tx (counted toward record limits); ambiguity → row error `LINK_AMBIGUOUS`.
* **Attachments** from URL columns: deferred — the row is inserted with an empty attachment cell and a follow-up `attachments:from-url` job per URL (bounded concurrency 10/import, SSRF-safe egress); failures logged as warnings.
* Record limit pre-check: `currentCount + estimatedNewRows ≤ plan limit` at start (estimate from file size / analyzed avg row bytes); hard enforcement per batch (`PLAN_LIMIT_EXCEEDED` → job stops with `completed_with_errors`, remaining rows reported).

## 9. Execution at scale

* **Batch size 1,000 rows, one transaction per batch** (not one giant tx): bounded lock time, bounded WAL bursts, progress visible, resumable. Tradeoff: an import is not atomic — mitigated by the deletion-batch rollback (§11) and the `importing` banner.
* Per batch transaction:
  1. `SET LOCAL app.workspace_id`, `statement_timeout = 60s`.
  2. Allocate row numbers (`UPDATE tables SET next_row_number = next_row_number + n RETURNING …`).
  3. Multi-row `INSERT INTO records … ` via `COPY`-like `unnest` arrays (Kysely raw SQL); `record_links` bulk insert; sidecar index rows.
  4. Same-record computed fields evaluated in-process (D7); cross-record fan-out **deferred** wholesale (records marked in `computed_stale`), not synchronous — imports would otherwise exceed `COMPUTE_SYNC_FANOUT_LIMIT` constantly.
  5. One `base_changes` row per batch with op `records.bulk_insert` (compact: record IDs + cells) — realtime clients apply or refetch.
  6. One outbox event `records.bulk_changed` `{ importId, tableId, created: [ids], updated: [ids], batchNo, via: "import" }`.
  7. `import_jobs.checkpoint = { batchNo, rowOffset, byteOffset, sheetRow }`; `long_operations.progress`.
* **Throughput control:** the worker acquires the base's `records_written` budget with an import multiplier (×4) and backs off when compute queue lag for the base exceeds 30 s (back-pressure signal from `compute` queue metrics) — imports must not starve interactive users.
* **Concurrency:** one running import per table; up to 3 per workspace; global import pool autoscaled on queue depth.
* **Resume:** worker crash → reconciler re-enqueues; job reopens the S3 stream and seeks to `byteOffset` (CSV) or skips to `sheetRow` (xlsx streaming re-read); idempotent because batch N's insertion is recorded with `import_jobs.checkpoint` in the same tx.
* **Search indexing & AI fields:** `search-index` consumes `records.bulk_changed` in bulk mode; AI fields on imported rows are **not** auto-run unless the field's `autoRun` includes `on_import` (cost protection).

## 10. Automations, events and realtime during imports

**Decision [Ours]:** record-level automations are triggered for imported rows **only if** the automation's setting `runOnImports` is `true` (default **false**). Events carry `actor.via = "import"`; the trigger matcher (`14-automation-engine.md`) reads `records.bulk_changed` and fans out per record only for automations that opted in, subject to automation run quotas and `ratebudget`.

Rationale: users importing 50k rows rarely want 50k "send email" runs; the opposite surprise (silent no-op) is cheaper and is surfaced in the import UI: "3 automations watch this table; 1 is set to run on imports (estimated 48,213 runs; you have 12,000 runs left this month)". Webhooks **do** receive import changes (they are data-sync consumers; `sources` filter lets them exclude `import`).

Realtime: open grids receive `records.bulk_insert` ops per batch; clients with the table open beyond 5 batches switch to "refetch window" mode (`16-realtime.md`) to avoid processing huge ops.

## 11. Progress, cancellation, rollback

* **Progress:** `long_operations.progress = { completed: rowsProcessed, total: estimatedRows, unit: "rows", errors: n }`; `long_operation.progressed` events throttled to 1/s per job → WebSocket; API pollers via `GET …/long-operations/{id}`.
* **Cancellation:** `:cancel` sets `cancel_requested`; the worker checks between batches (≤ 1 batch latency). Default on cancel: **keep** already-imported rows (status `cancelled`), UI offers rollback; `{ rollback: true }` performs rollback immediately.
* **Rollback:** every record created by the import is tagged with the import's **deletion batch** reservation: `import_jobs.deletion_batch_id` is pre-allocated; rollback soft-deletes all records with `created_by_import = importId` (tracked via `import_jobs.created_record_ranges` — UUIDv7 IDs created by a job are recorded as a list of ID ranges per batch, compact) into that `deletion_batches` row → visible in trash, restorable for 30 days. Upserted **updates** are rolled back by applying the inverse ops stored in `base_changes.inverse_ops` for the job's change rows (within `BASE_CHANGES_RETENTION`); if records were modified after the import by others, the rollback of those cells is skipped and reported (`409` unless `force`). Created tables (create mode) are rolled back by soft-deleting the table.

## 12. Error reporting

* `import_errors` rows: `(import_id, row_number, column_index, field_id, severity: error|warning, code, message, raw_value (truncated 1 KB))`.
* Codes: `INVALID_NUMBER`, `INVALID_DATE`, `VALUE_TOO_LONG`, `INVALID_EMAIL`, `UNKNOWN_OPTION` (create disabled), `LINK_NOT_FOUND`, `LINK_AMBIGUOUS`, `UPSERT_AMBIGUOUS_MATCH`, `DUPLICATE_IN_FILE`, `DUPLICATE_EXISTING`, `ROW_TOO_WIDE`, `ENCODING_REPLACEMENT` (warning: invalid byte sequence replaced), `PLAN_LIMIT_EXCEEDED`, `ATTACHMENT_FETCH_FAILED`.
* **Error CSV:** `GET …/imports/{id}/errors?format=csv` streams the **original rows** that failed plus `_error_column`, `_error_code`, `_error_message` columns — the user fixes and re-imports just that file (same mapping reusable: "Import again with this mapping").
* Summary in `import_jobs.result`: `{ rowsRead, created, updated, skipped, errorRows, warnings, durationMs, optionsCreated: { fld_…: 12 }, linkedCreated }`.
* Events: `import.completed` / `import.failed` (Spine §6) → notification to initiator + audit event (`import.completed` with counts, no data).

## 13. Limits and failure modes

| Limit | Default |
|---|---|
| File size | Free 5 MB, Team 100 MB, Business/Enterprise 500 MB |
| Columns | 500 (field limit) |
| Cell size | 100k chars (long text limit); larger truncated with warning |
| Concurrent imports | 1/table, 3/workspace |
| Analysis sample | 10k rows / 5 MB |
| Job retention | `import_jobs` 90 days; source file 7 days; `import_errors` 30 days |

| Failure | Handling |
|---|---|
| Malformed CSV line (unbalanced quotes) | Relaxed parser recovers to next newline; row error `MALFORMED_ROW` |
| Worker OOM / crash | Resume from checkpoint (§9) |
| Shard write freeze (`BASE_UNAVAILABLE`) | Job pauses, retries with backoff, status `running` with `paused_reason` |
| Schema changed mid-import (field deleted) | Batch fails validation for that column → column skipped with warnings; job continues (`completed_with_errors`) |
| Source file deleted by lifecycle before resume | Job `failed` with `SOURCE_EXPIRED` |

---

# Part B — Export

## 14. Export model

* Exports are defined by a **source** (`viewId`, or `tableId` + optional `filter`/`fields`) and produce a file in `tabula-exports` (7-day lifecycle). State in `export_jobs`; progress via `long_operations` (`export.run`).
* Small view CSV (≤ 10k rows): synchronous streaming endpoint (`GET …/views/{viewId}/export.csv`) — what the UI's "Download CSV" uses for typical views.
* Base-level "full export" (all tables, schema JSON, attachments manifest) is a V1 feature using the snapshot machinery (`base_snapshots`) and produces a zip.

## 15. Formats and encoding

| Format | Writer | Cell rendering | Notes |
|---|---|---|---|
| CSV | streaming `csv-stringify` | `cellFormat: string` (display values per field, `timeZone`, `locale`) | UTF-8 **with BOM** by default (Excel compatibility; option off); RFC 4180 quoting; **CSV-injection protection**: values starting with `=`, `+`, `-`, `@`, tab, CR are prefixed with `'` (OWASP) unless `rawFormulasSafe: false` explicitly chosen by the user |
| XLSX | `exceljs` streaming `WorkbookWriter` | typed cells: numbers as numbers, dates as Excel dates with number formats, currency with format, checkboxes as TRUE/FALSE, multi-values joined | Max 1,048,576 rows per sheet (Excel limit) → split sheets; header row frozen, column widths from view |
| JSON / JSONL | streaming | `cellFormat: json` (API representation, `17-…` §9) | JSONL recommended for > 100k rows |

Field order and visibility = view's visible fields in order (hidden fields excluded); sort = view sort; filter = view filter. Grouping is ignored except in XLSX where `groupHeaders: true` emits group separator rows (V1).

## 16. Permission enforcement

* Requires `export.data` on the base (org policy `exports.allowedRoles` may restrict: e.g. viewers and guests cannot export; CSV download disabled on share links unless `allowDownloadCsv`).
* Data is read through the **same query planner and PermissionSnapshot** as the API: field masking (hidden fields), row policies, interface-only restrictions. An interface-only user can only export from an element that has "download" enabled, and only that element's projection.
* The PermissionSnapshot is captured at export start (`export_jobs.permission_epoch`); if `perm_epoch` changes during a long export (user's access revoked), the export worker re-validates at each 10k-row chunk and aborts with `PERMISSION_DENIED` if access was lost.
* Audit: `export.completed` audit event with source, row count, format, requester, IP (exports are a key exfiltration vector; Enterprise DLP alerts on large exports).
* Signed download URL: CloudFront signed URL, 1 h TTL, bound to the object key; re-issued on `GET …/exports/{id}` for the requester only.

## 17. Large exports and delivery

* Worker streams: DB cursor (keyset pages of 2,000 records via the planner, `Tabula-Consistency: eventual` to replicas allowed) → row renderer → format writer → **S3 multipart upload stream** (`@aws-sdk/lib-storage` `Upload`, 16 MB parts). Memory bounded; no temp disk needed.
* Consistency: exports record `snapshotSeq` at start; rows changed mid-export may reflect newer values (documented; same semantics as pagination §16.3 of `17-…`). Enterprise option `consistent: true` runs the export inside a `REPEATABLE READ` read-only transaction on a replica (bounded to 30 min; larger tables fall back with a warning).
* Completion: `export.completed` event → notification (in-app + email with link to the app, **never** the signed URL itself in email) → `GET …/exports/{id}` returns `downloadUrl`.
* Export via API: `POST /v1/bases/{baseId}/exports` → `202` → poll → download (`31-…` §24). Rate cost 10 units; concurrency 2 per token.

---

# Part C — Sharing

## 18. Sharing surfaces and principals

| Surface | Mechanism | Principal at request time | Permission model |
|---|---|---|---|
| Invite user to org/workspace/base/interface | `invitations` → on accept, `access_grants` row | user | RBAC roles (Spine §9) |
| Share with team | `access_grants(principal_type='team')` | user via team membership | Same; max-role wins across grants |
| Base share link (read-only base) | `share_links(target_type='base')` | anonymous `share` principal | Viewer projection of whole base (only fields/tables not restricted) |
| View share link | `share_links(target_type='view')` | `share` | Projection of the **view config** (§22) |
| Interface share link (public interface) | `share_links(target_type='interface')` | `share` | Published interface version; elements' read-only behaviors |
| Form share link | `share_links(target_type='form')` | `share` (write: create record only) | Form projection; submissions as `public_form` actor |
| Embed | share link + embed token (§23) | `share` | Same as underlying share + frame-ancestors |

All sharing is subject to `organization_policies.sharing` (`publicLinks: allowed|password_required|disabled`, `externalInvites`, `allowedEmailDomains`) — evaluated at **creation and at every access** (policy tightening instantly disables existing non-compliant links; they show "disabled by organization policy").

## 19. Invitations

Flow:

1. `POST …/invitations { email, role }` (workspace/base/interface) — checks: inviter can grant ≤ own role (`base.manage_members` / `workspace.manage`), org policy `externalInvites` (`verified_domains_only` ⇒ email domain ∈ `organization_domains(verified)` or `allowedEmailDomains`), seat availability (`PLAN_LIMIT_EXCEEDED` if a paid seat would be needed and auto-add is off).
2. `invitations` row: `token_hash` (SHA-256 of 256-bit token), `email_normalized`, `resource_type/id`, `role`, `invited_by`, `expires_at` (14 days), `status`.
3. Email via `email` queue with link `https://app.tabula.example/invite/{token}`.
4. Accept (`POST /v1/invitations/{token}:accept`) requires a session whose **verified email matches** the invited email (case-insensitive; plus-addressing not normalized). If the user signs up through the link, the email is verified by the invitation itself (possession of the token proves mailbox control) — except when the org enforces SSO for that domain: then SSO login is required first.
5. Existing users: invitations to known emails also appear in-app (notification) — accept without email round-trip.
6. On accept: `access_grants` upsert (never downgrades an existing higher role), `invitation.accepted` + `grant.changed` events, `perm_epoch` bump for the base(s) → PermissionSnapshot invalidation.

Abuse controls: invites per inviter 100/day (Free 20/day), per base 500/day; invitation email content is templated (inviter's free-text message ≤ 500 chars, links stripped) to limit spam/phishing via our domain; bounces add to `email_suppressions`.

## 20. Share links: token architecture

```
https://share.tabula.example/v/shr_4Lp9…/Xk7Q2mN8vR1sT5wY3zA6bC9dE0fG4hJ7k   (view)
                                └ share id ┘ └────────── 128-bit secret, base62 (22 chars) ──┘
```

* **Two-part URL:** public `shr_…` ID (lookup key, safe in logs/analytics) + **128-bit random secret** (`crypto.randomBytes(16)`, base62). DB stores only `token_hash = SHA-256(secret)` and `token_prefix` (first 6 chars) for identification in admin UIs ("link ending/starting `Xk7Q2m…`"). Possession of the full URL = capability.
* Lookup: `share_links` by ID (the shard is found via `share_id → base_id` routing entry; see Proposed additions `core.public_link_directory`), constant-time compare of hash. 128 bits of entropy makes online guessing infeasible; per-IP rate limiting adds a margin.
* Served from a **separate origin** `share.tabula.example` (cookie isolation from the app origin; a hostile share-page XSS cannot read app cookies; separate CSP).
* `:regenerate` replaces the secret (old URL dead immediately); revoke sets `status=revoked`. Both bump a `share_epoch` that invalidates unlock cookies (§21).
* Cache: `share:{shareId}` Redis entry (config projection, status, epoch; TTL 60 s; invalidated via pub/sub on change) → share requests do not hit Postgres for metadata.

## 21. Access modes

| Mode | Mechanism | Notes |
|---|---|---|
| `public` | Secret URL only | Default where org policy allows |
| `password` | `password_hash` = **Argon2id** (m=64 MB, t=3, p=1); `POST /share/{shareId}/unlock { password }` | Rate limit: 5 attempts / 15 min per (share, IP) and 50 / hour per share globally (GCRA); exceed → `429` + soft lockout 15 min. Success → **unlock cookie** `tshr_{shareId}` = HMAC-signed `{shareId, shareEpoch, exp: 24h}`, `HttpOnly; Secure; SameSite=None` (needed for embeds), `Path=/v/{shareId}` (scoped to that share only) |
| `email_domain` / `email_list` (restricted shares) | Viewer enters email → **magic link** (one-time 256-bit token, 15 min, stored hashed in Redis `share:magic:{hash}`) → click sets unlock cookie bound to `{shareId, email, shareEpoch}` | Domain check on normalized email; access log records the email (for owner analytics). Logged-in Tabula users whose verified email matches skip the magic link |
| Expiring | `expires_at` checked at every request; expired → generic 404 page | Owner notified 3 days before expiry (optional) |
| Combination | password + expiry + domain restriction may combine | Org policy `password_required` forces `password` or restricted modes |

Failure responses are deliberately uniform: unknown share ID, wrong secret, revoked, expired, policy-disabled → the same **404 page** (no oracle) — except when the secret is correct and the link is merely locked (password/email gate shown).

## 22. What a public viewer can see (projection)

A share link never grants "base read". The share principal's PermissionSnapshot is **synthesized from the share's projection**:

```ts
interface ShareProjection {
  targetType: 'base' | 'view' | 'interface' | 'form';
  tables: Array<{
    tableId: string;
    fieldIds: string[];          // visible fields (view: visible fields in view config at access time)
    rowFilter?: FilterNode;      // view filter (ANDed, non-overridable)
    sort?: SortSpec[];
  }>;
  capabilities: { copy: boolean; downloadCsv: boolean; showAttachments: boolean; search: boolean; expandRecord: boolean; showComments: false };
}
```

Rules:

* **View share:** visible fields = the view's visible fields **∩ fields not restricted** (Enterprise hidden fields, `fields.restrictions.hiddenFrom` includes "public"); rows = view filter; viewer may sort/filter/search **within** the projection client-side or server-side, never widening it (server ANDs view filter; field references outside projection → `404 FIELD_NOT_FOUND`).
* **Linked records:** link cells show `displayValue` (primary field of target) only; expanding a linked record is **not** allowed unless the target table is also part of the projection (base shares).
* **Lookups/rollups** of hidden fields are visible only if the lookup field itself is visible (owner decided to expose it) — documented warning in the share dialog: "Lookup fields can reveal data from other tables".
* **Collaborator fields:** names shown; emails never shown to share principals.
* **Attachments:** signed URLs with short TTL (15 min) and `showAttachments` must be true; otherwise filename only.
* **Comments, revision history, record IDs in URLs:** never exposed (records are addressed by opaque per-share row tokens `r_{hmac(shareId, recordId)}` in share UI URLs, so record IDs don't leak).
* **Live updates:** share viewers get realtime via a restricted WS channel filtered through the projection (V1); MVP polls every 30 s.
* Interface shares: the **published** version's element configs define the projection; draft changes never leak.
* Forms: only form-local keys; no read access except `allowViewSubmittedRecord` (shows the submitter's own submission once via a signed one-time receipt link).

## 23. Embeds

* `embed.enabled = true` exposes `https://share.tabula.example/embed/v/{shareId}/{secret}`.
* **CSP** on embed responses: `frame-ancestors <embed.frameAncestors…>` (owner-configured list of origins, e.g. `https://intranet.example.com`; default `*` only allowed when org policy permits public embeds). Non-embed share pages send `frame-ancestors 'none'` (clickjacking protection) and `X-Frame-Options: DENY`.
* **Embed-specific token:** for embeds whose host app wants to avoid exposing the share secret in page source, owners can generate **signed embed tokens** server-side: JWT-like compact token `{ shareId, aud: "embed", origin, exp ≤ 24h, viewerRef? }` signed with a per-share **embed signing secret** (shown once; `share_links.embed.secret_hash`). The host backend mints tokens per page view; we verify signature + `origin` vs `Origin`/`Sec-Fetch-Site` + expiry. This enables "secure embed" (only your logged-in users see the embed) without Tabula accounts.
* Cookies inside iframes are third-party: password-protected embeds rely on the embed token or on `SameSite=None; Partitioned` (CHIPS) unlock cookies.

## 24. Revocation, analytics, abuse prevention

**Revocation:** revoke/regenerate/expire/policy change → `share:{shareId}` cache invalidation via pub/sub (≤ 1 s propagation), unlock cookies invalid via `shareEpoch`, active realtime share sessions closed. Removing a base member who created links: links remain (owned by the base) unless org policy `revokeLinksOnCreatorRemoval`.

**Analytics:** `share_link.accessed` events **sampled** (1 per (share, visitor fingerprint, hour)) → aggregated counters in `share_links.stats` (views 30 d, unique visitors approximated with HyperLogLog in Redis `share:hll:{shareId}:{day}`), last accessed; for restricted shares, per-email access list (owner-visible). No third-party analytics scripts on share pages.

**Abuse prevention:**

| Threat | Control |
|---|---|
| Phishing pages hosted on our share domain (e.g. forms asking for passwords) | Form content scanning (keywords + ML classifier for credential-harvesting forms), reports button on every public page, Free-plan new accounts: public forms rate-limited & delayed indexing, Safe Browsing checks of URLs in form descriptions; takedown tool sets `status=revoked_abuse` |
| Scraping public views | Per-share and per-IP GCRA, pagination caps (share API page ≤ 200), bot detection (Turnstile challenge after anomaly), `noindex` by default (`X-Robots-Tag: noindex`) unless owner opts in |
| Form spam | Turnstile/hCaptcha when risk high, honeypot field, per-IP submit limits, per-form daily cap (configurable), duplicate submission detection |
| Malware distribution via attachments | All attachments scanned (D15); share-served downloads use `Content-Disposition: attachment` for non-image types and a separate download domain |
| Brute force passwords | Argon2id + rate limit + lockout (§21) |
| Data leak via over-sharing | Org policy, share dialog warnings (lookups, attachments), admin "all public links" report (`GET /v1/organizations/{orgId}/share-links` V1), DLP alert on new public link in bases tagged sensitive |

## 25. Token & secret architecture table

| Token / secret | Format & entropy | Storage | Lifetime | Verification | Revocation |
|---|---|---|---|---|---|
| Session token | 256-bit random, opaque | SHA-256 in `core.sessions`, Redis `sess:` | idle 14 d / abs 30 d | hash lookup | delete row + Redis |
| PAT / service-account token | `tpat_`/`tsvc_` + id + 256-bit secret | SHA-256 in `core.api_tokens` | user-defined / policy | id lookup + constant-time hash compare | `revoked_at`, pub/sub |
| OAuth access / refresh | `toat_` 1 h / `tort_` rotating | SHA-256 in `core.api_tokens` / `core.oauth_grants` | 1 h / 90 d sliding | same | family revoke on reuse |
| Invitation token | 256-bit | SHA-256 in `core.invitations` | 14 d | hash | status |
| Share link secret | 128-bit base62 | SHA-256 + 6-char prefix in `data.share_links` | until revoke/expiry | hash | regenerate / revoke / epoch |
| Share password | user-chosen ≥ 8 chars | Argon2id | until changed | Argon2 verify (rate-limited) | change bumps epoch |
| Share unlock cookie | HMAC-SHA256 signed `{shareId, epoch, email?, exp}` | stateless | 24 h | HMAC + epoch | epoch bump |
| Magic link (restricted share) | 256-bit | SHA-256 in Redis | 15 min, single use | hash | delete |
| Embed signing secret / embed token | 256-bit secret; token HMAC-signed, ≤ 24 h | secret: hash + envelope-encrypted copy for verification in `share_links.embed` | rotateable | HMAC verify (needs secret → stored encrypted, not hashed) | rotate |
| Webhook signing secret | `whsec_` 256-bit | envelope-encrypted (needed to sign) | until rotated (24 h overlap) | — | rotate |
| Inbound webhook URL token | 256-bit in URL + optional HMAC secret | SHA-256 (URL token), encrypted (secret) | until rotated | hash | rotate |
| Integration credentials (OAuth tokens, API keys) | provider-defined | **envelope-encrypted** in `integration_connections` | provider-defined | — | disconnect + provider revoke |
| Cursor HMAC keys | 256-bit, `kid` | KMS-backed secret store | rotated quarterly | HMAC | key retirement |
| WS ticket | 256-bit | Redis, single use | 30 s | GETDEL | — |

Principle: **hash what we only verify; encrypt what we must use** (signing secrets, third-party credentials).

---

# Part D — Integrations

## 26. Integration framework goals

1. **Add connectors without touching core.** A connector is a package with a manifest + runtime; the core discovers it via a registry.
2. **Declarative first.** Auth, actions, triggers and their I/O are JSON-Schema-described so the automation builder, the API catalogue (`GET /v1/integrations/providers`) and validation are generated, not hand-coded per connector.
3. **Credentials never leave the integration runtime boundary in plaintext** except to call the provider; never exposed to scripts, logs, or users.
4. **Uniform reliability:** rate limiting, retries, token refresh, pagination and error classification are framework services, not re-implemented per connector.
5. **Isolation tiers:** first-party connectors run in-process in the `worker` role; community connectors run in the `sandbox` role (D21) with egress restricted to their declared hosts.

The naive interface `Integration { authenticate(); refreshToken(); execute(); webhook(); disconnect(); }` mixes concerns (a single `execute` hides what actions exist; no schemas; no trigger model; no rate-limit metadata; no versioning). We replace it with a **manifest + runtime** split.

## 27. ConnectorManifest and ConnectorRuntime

```ts
// packages/connector-sdk/src/manifest.ts
export interface ConnectorManifest {
  id: string;                       // 'slack', 'google-calendar', 'acme.crm' (reverse-DNS for community)
  version: string;                  // semver; actions pinned per automation step: 'slack@2.1.0'
  name: string; description: string; iconUrl: string; categories: string[];
  publisher: { name: string; url: string; verified: boolean };
  tier: 'first_party' | 'verified' | 'community';
  auth:
    | { type: 'oauth2'; authorizationUrl: string; tokenUrl: string; revokeUrl?: string;
        scopes: { required: string[]; optional?: Record<string, string> };   // per-action extra scopes
        pkce: boolean; tokenPlacement: 'header' | 'query'; extraAuthParams?: Record<string, string>;
        refresh: { supported: boolean; rotatesRefreshToken: boolean } }
    | { type: 'api_key'; fields: JSONSchema; placement: { in: 'header' | 'query'; name: string; prefix?: string } }
    | { type: 'basic'; fields: JSONSchema }
    | { type: 'custom'; fields: JSONSchema }          // runtime.authenticate() builds request auth
    | { type: 'none' };
  egress: { allowedHosts: string[] };                // enforced by egress proxy (sandbox) and HTTP client (in-process)
  rateLimits?: Array<{ scope: 'connection' | 'app'; requests: number; perSeconds: number; costHeader?: string }>;
  actions: ActionDefinition[];
  triggers: TriggerDefinition[];
  syncResources?: SyncResourceDefinition[];          // for sync sources (§32)
  accountLabel?: { action: string; path: string };   // how to display "Connected as dana@acme.com"
  webhookVerification?: WebhookVerificationSpec;     // §30
}

export interface ActionDefinition {
  key: string;                      // 'send_message'
  name: string; description: string;
  inputSchema: JSONSchema;          // drives the automation step form; supports x-dynamic-options
  outputSchema: JSONSchema;         // drives token pickers for later steps
  requiredScopes?: string[];
  idempotent: boolean;              // framework may retry blindly when true
  sideEffect: 'read' | 'write';
  dynamicOptions?: Record<string, { action: string; labelPath: string; valuePath: string }>; // e.g. channel picker
  timeoutMs?: number;               // default 30s, max 120s
}

export interface TriggerDefinition {
  key: string;                      // 'new_email'
  name: string; description: string;
  kind: 'webhook' | 'polling';
  configSchema: JSONSchema;         // e.g. label filter
  outputSchema: JSONSchema;         // one event
  polling?: { minIntervalSec: number; defaultIntervalSec: number; dedupeKey: string /* JSON path */ };
  webhook?: { subscribe: boolean /* runtime.subscribe/unsubscribe exist */ ; eventTypeHeader?: string };
}
```

```ts
// packages/connector-sdk/src/runtime.ts
export interface ConnectorContext {
  http: ConnectorHttpClient;        // pre-authenticated, egress-restricted, rate-limited, retrying, logging-redacted
  connection: { id: string; accountLabel?: string; metadata: Record<string, unknown> };  // no raw secrets
  logger: RedactingLogger;
  state: { get(key: string): Promise<unknown>; set(key: string, v: unknown): Promise<void> }; // per connection+trigger, size-capped
  signal: AbortSignal;
}

export interface ConnectorRuntime {
  /** custom auth only: turn stored credential fields into request auth */
  authenticate?(creds: Record<string, string>, req: OutgoingRequest): Promise<OutgoingRequest>;
  /** OAuth: provider-specific token exchange quirks (default implementation is RFC 6749) */
  exchangeCode?(code: string, verifier: string | undefined, ctx: OAuthCtx): Promise<TokenSet>;
  refresh?(refreshToken: string, ctx: OAuthCtx): Promise<TokenSet>;
  /** Validate credentials, return account label & metadata (team id, user id) */
  test(ctx: ConnectorContext): Promise<{ accountLabel: string; metadata?: Record<string, unknown> }>;
  actions: Record<string, (input: unknown, ctx: ConnectorContext) => Promise<unknown>>;
  triggers?: Record<string, {
    poll?(config: unknown, cursor: unknown, ctx: ConnectorContext): Promise<{ events: unknown[]; cursor: unknown }>;
    subscribe?(config: unknown, callbackUrl: string, ctx: ConnectorContext): Promise<{ externalSubscriptionId: string; expiresAt?: string }>;
    unsubscribe?(externalSubscriptionId: string, ctx: ConnectorContext): Promise<void>;
    renew?(externalSubscriptionId: string, ctx: ConnectorContext): Promise<{ expiresAt?: string }>;
    parseWebhook?(req: InboundWebhookRequest, ctx: ConnectorContext): Promise<unknown[]>;   // → events
  }>;
  sync?: Record<string, {
    list(params: unknown, cursor: SyncCursor | null, ctx: ConnectorContext): Promise<{ rows: SyncRow[]; nextCursor: SyncCursor | null; deletedExternalIds?: string[] }>;
  }>;
  disconnect?(ctx: ConnectorContext): Promise<void>;   // provider-side revoke
}
```

Key improvements over the naive interface: typed per-action entry points with JSON Schemas; trigger model with both webhook and polling; `test` returns account identity; framework-provided `http` client handles auth injection, refresh-on-401 (once), rate limits, retries with `Retry-After`, redaction and egress policy — connector code never touches tokens directly (except `refresh`/`exchangeCode`, which run in the trusted credential service for community connectors, see §33).

**Error classification** (connector throws or framework maps HTTP): `AuthError` (→ connection `auth_failed`, `integration.auth_failed` event, user notified; no retry), `RateLimitError` (retry after), `TransientError` (retry with backoff), `PermanentError` (fail step, no retry), `ValidationError` (input invalid; shown in run detail).

## 28. Connections and credential storage

`integration_connections` (data plane, workspace-scoped; Spine §5.2):

| Column | Purpose |
|---|---|
| `id` (`con_…`), `workspace_id`, `connector_id`, `connector_version_range` | |
| `owner_user_id`, `sharing` (`private` / `workspace` / `bases: [...]`) | Who can use it in automations; private by default |
| `account_label`, `external_account_id`, `metadata jsonb` | Display + dedupe ("already connected as …") |
| `auth_type`, `scopes text[]` | Granted scopes |
| `credentials_enc bytea`, `dek_enc bytea`, `kek_id text` | Envelope encryption |
| `access_token_expires_at`, `refresh_status`, `last_refreshed_at` | Refresh scheduling |
| `status` (`active`, `auth_failed`, `revoked`, `disabled_policy`) | |
| `last_used_at`, `created_at`, `updated_at` | |

**Envelope encryption:**

* Per-connection random **DEK** (AES-256-GCM); credentials JSON (`{ accessToken, refreshToken, apiKey, … }`) encrypted with DEK, AAD = `connection_id ‖ workspace_id ‖ connector_id` (prevents swapping ciphertexts between rows).
* DEK encrypted with a **KEK** in AWS KMS: per-shard KEK by default; Enterprise dedicated shard ⇒ customer-dedicated KMS key (BYOK option, D4). `kek_id` stored for rotation.
* Decryption only inside the **credential service** module (in `worker`/`api` processes for first-party; for community connectors the sandbox never receives refresh tokens — it receives a short-lived access token or a proxied HTTP client, §33). KMS `Decrypt` calls cached per DEK for 5 min in process memory (bounded LRU) to limit KMS cost/latency.
* Same mechanism for `secrets` (automation secrets) and webhook/embed signing secrets.
* Credentials never logged: the HTTP client redacts `Authorization`, query params named in manifest `placement`, and known token patterns; run logs show request metadata only.

## 29. Token refresh and secret rotation

**Refresh-ahead job:** scheduler (every minute) enqueues `integration-refresh` jobs on the existing `maintenance` queue for connections whose `access_token_expires_at < now() + 10 min` and `status=active`. Rationale: refreshing *before* expiry keeps automation step latency flat and avoids thundering herds of refresh-on-401.

**Single-flight lock:** refresh for one connection must happen once even if a step and the refresh-ahead job race — many providers rotate refresh tokens, and two concurrent refreshes would invalidate one another (and providers with reuse detection may revoke the grant entirely).

```ts
async function getAccessToken(conn: ConnectionRef): Promise<string> {
  const creds = await credentialService.load(conn.id);
  if (creds.expiresAt > Date.now() + 60_000) return creds.accessToken;
  return withLock(`lock:integration-refresh:${conn.id}`, { ttlMs: 30_000, waitMs: 20_000 }, async () => {
    const fresh = await credentialService.load(conn.id);                 // re-read inside lock
    if (fresh.expiresAt > Date.now() + 60_000) return fresh.accessToken;   // someone else refreshed
    const tokens = await runtime.refresh!(fresh.refreshToken, oauthCtx(conn));
    await credentialService.store(conn.id, { ...fresh, ...tokens });       // tx: update row, emit integration.token_refreshed
    return tokens.accessToken;
  });
}
```

* Lock = Redis `SET NX PX` (`lock:` namespace, Spine §10) with fencing token; the DB update is conditional on `updated_at` (compare-and-set) so a stale lock holder can't overwrite newer tokens.
* Refresh failures: `invalid_grant` ⇒ `status=auth_failed`, `integration.auth_failed` event, notify owner, automations using it fail fast with a "Reconnect" CTA; transient (5xx/timeout) ⇒ retry with backoff, keep old token until expiry.
* **Secret rotation:**
  * KEK rotation: KMS automatic annual rotation (transparent); manual re-wrap job re-encrypts DEKs with the new `kek_id` in the background (no plaintext credential exposure beyond the credential service).
  * Our OAuth client secrets per provider (e.g. Google client secret): stored in AWS Secrets Manager, dual-secret support (`current`, `next`) for zero-downtime rotation.
  * API-key connections: user-initiated "update credentials" (write-only form); we prompt rotation when providers report key age (where available).
  * Webhook verification secrets per provider subscription rotate on `renew` when the provider supports it.

## 30. Inbound provider webhooks

* Callback URL per subscription: `https://hooks.tabula.example/c/{connectorId}/{routeToken}` where `routeToken` (128-bit) maps to `(connection_id, trigger subscription)` — stored hashed; reuse the `inbound_webhooks` table with `kind='connector'` (see Proposed additions).
* **Verification per provider** declared in the manifest:

```ts
type WebhookVerificationSpec =
  | { type: 'hmac'; header: string; algorithm: 'sha256' | 'sha1'; encoding: 'hex' | 'base64';
      signedPayload: 'body' | '{timestamp}.{body}' | 'v0:{timestamp}:{body}'; timestampHeader?: string; toleranceSec?: number; prefix?: string }
  | { type: 'jwt'; jwksUrl: string; audience: string; issuer: string }            // e.g. Google push via OIDC token
  | { type: 'token'; header: string }                                             // static shared token (weak; legacy providers)
  | { type: 'custom' };                                                           // runtime.parseWebhook verifies
```

  Slack-style: `v0:{timestamp}:{body}` HMAC-SHA256 with 5-min tolerance; Google Calendar/Gmail push: channel token + Pub/Sub OIDC JWT; generic: HMAC.
* Handler (in `api` role, route `auth: none`): size limit 1 MB, verify → respond `200` fast (≤ 1 s; providers retry aggressively on slowness) → persist event to outbox as `inbound_webhook.received` → automation trigger matcher. **Deduplication** via provider event ID (`dedupeKey`) in Redis (24 h) + `automation_runs` idempotency (`automation_id + trigger_event_id`, D21).
* URL-verification challenges (e.g. Slack `url_verification`) handled by `parseWebhook` returning a challenge response.
* Subscriptions with provider expiry (Google watch channels ≤ 7 days, Microsoft Graph ≤ 3 days) renewed by a scheduler job at 80% of lifetime via `renew` (or re-`subscribe`).

## 31. Polling triggers

* For providers without webhooks (or as fallback). `automation_schedules` holds next poll time per (automation version, trigger); the scheduler enqueues `automation-trigger` jobs; interval = max(manifest `minIntervalSec`, plan floor: Free 15 min, Team 5 min, Business 2 min, Enterprise 1 min).
* Poll state (cursor) per (automation, trigger) is stored in `integration_trigger_states` (Proposed addition) — a JSON cursor (`historyId`, `updatedMin`, ETag, last seen IDs) plus a bounded **seen-ID ring** (last 1,000 dedupe keys) for providers that only offer timestamp filters (overlap window of 2 min to tolerate clock skew, deduped by key).
* **First poll** establishes the cursor without emitting historic events ("only new items from now on").
* Back-off: consecutive failures double the interval up to 1 h; `AuthError` pauses polling and marks the connection.
* Fairness: polls for many automations sharing one connection are coalesced when the trigger config is identical (one API call, fan-out events) — important for provider rate limits.

## 32. Sync sources (synced tables)

Synced tables bring external data into a **read-only** table (fields from the connector's `SyncResourceDefinition` schema; users may add their own non-synced fields alongside, which are editable).

```ts
interface SyncResourceDefinition {
  key: string;                    // 'calendar_events', 'crm_deals'
  name: string;
  paramsSchema: JSONSchema;       // e.g. calendarId, date window
  externalIdPath: string;         // stable key → record mapping
  fields: Array<{ key: string; name: string; type: FieldType; config?: object; path: string }>;
  incremental: 'cursor' | 'updated_since' | 'full';
  supportsDeletes: boolean;
}
```

* `sync_sources`: `(id, base_id, table_id, connection_id, connector_id, resource_key, params, schedule, field_map jsonb {externalKey → fieldId}, cursor jsonb, status, last_success_at)`; `sync_runs`: per execution `(status, started_at, finished_at, created, updated, deleted, error)`.
* Execution (`sync` queue): `list()` pages → upsert by external ID (mapping stored as a hidden system field `__external_id` with a unique index sidecar) → records not seen in a **full** sync are soft-deleted (or flagged, per `deletionMode`); incremental modes rely on `deletedExternalIds`. Writes use `actor.type = integration`, `via = sync`, chunks of 1,000 like imports; `sync.completed` / `sync.failed` events.
* Synced fields are locked (`fields.restrictions.edit = system`); API writes to them → `403 FIELD_NOT_EDITABLE`.
* Consistency: cursor advanced only after the page's records committed (same tx stores `sync_sources.cursor`), so crashes re-process at most one page (idempotent upserts).
* Limits: sync row count counts toward records-per-base; Free plan: no sync; schedules ≥ 5 min.
* **Base-to-base sync** (internal source connector `tabula-base`) uses the same mechanism reading another base's view through the API with a service principal — no cross-shard SQL.

## 33. Third-party connectors: packaging, registry, sandboxing

```
packages/connectors/
  slack/            manifest.json · src/index.ts (ConnectorRuntime) · icon.svg · tests/ (recorded fixtures)
  google-calendar/  …
  gmail/            …
  generic-http/     …
  hubspot-like-crm/ …
```

* **First-party** connectors: workspace packages compiled into the server image; `ConnectorRegistry` loads all `packages/connectors/*/manifest.json` at boot, validates manifests (JSON Schema + lint: every action has schemas, egress hosts declared, scopes minimal), and registers runtimes. Multiple versions can coexist (`slack@1`, `slack@2`); automation steps pin a major version; minor/patch upgrades apply automatically.
* **Verified/community** connectors (V1+): published through the developer portal as a bundle (`manifest.json` + single ESM bundle built with our CLI `tabula connector build`, no native deps), stored in S3 with content hash; catalogue rows in `core.connectors` / `core.connector_versions` (Proposed). Review pipeline: static analysis (no dynamic `eval`/`Function`, dependency audit), manifest review (scopes, egress), automated tests against recorded fixtures, manual review for `verified`.
* **Sandboxed execution** for non-first-party code: runs in the `sandbox` role (D21) — V8 isolate (`isolated-vm`) with memory 128 MB, CPU time limit per invocation (action `timeoutMs`), no `fs`, no `process`, network only through a host-provided `fetch` that routes via the **egress proxy** enforcing `egress.allowedHosts` and blocking private IP ranges. The isolate receives **only a short-lived access token** (or uses a proxied `http` client that injects auth host-side, preferred) — never refresh tokens, KEKs or DEKs. `refresh`/`exchangeCode` for community connectors are restricted to declarative OAuth (standard RFC 6749 flows executed by the host); custom refresh code is allowed only for verified connectors.
* **Versioning & compatibility:** `connector-sdk` is semver'd; manifests declare `sdkVersion`; the host supports the current and previous major.
* **Kill switch:** `feature_flags`-driven per connector/version disable (security incident) → steps fail with a clear message; connections marked `disabled_policy`.
* **Org control:** `organization_policies.integrations` allow-list/deny-list by connector ID and tier (e.g., Enterprise: first-party only).

## 34. Connector examples

### 34.1 Slack (first-party)

```json
{
  "id": "slack", "version": "2.1.0", "tier": "first_party",
  "auth": { "type": "oauth2", "authorizationUrl": "https://slack.com/oauth/v2/authorize",
            "tokenUrl": "https://slack.com/api/oauth.v2.access", "pkce": false, "tokenPlacement": "header",
            "scopes": { "required": ["chat:write", "channels:read"], "optional": { "users:read.email": "Look up users by email" } },
            "refresh": { "supported": true, "rotatesRefreshToken": true } },
  "egress": { "allowedHosts": ["slack.com", "*.slack.com"] },
  "rateLimits": [ { "scope": "connection", "requests": 1, "perSeconds": 1 } ],
  "actions": [
    { "key": "send_message", "name": "Send message", "sideEffect": "write", "idempotent": false,
      "inputSchema": { "type": "object", "required": ["channel", "text"], "properties": {
        "channel": { "type": "string", "x-dynamic-options": "list_channels" },
        "text": { "type": "string", "maxLength": 40000 }, "threadTs": { "type": "string" } } },
      "outputSchema": { "type": "object", "properties": { "ts": { "type": "string" }, "permalink": { "type": "string" } } } },
    { "key": "list_channels", "name": "List channels", "sideEffect": "read", "idempotent": true,
      "inputSchema": { "type": "object" }, "outputSchema": { "type": "array" } }
  ],
  "triggers": [ { "key": "new_message_in_channel", "kind": "webhook", "configSchema": { "type": "object", "properties": { "channel": { "type": "string" } } },
                  "outputSchema": { "type": "object" }, "webhook": { "subscribe": false } } ],
  "webhookVerification": { "type": "hmac", "header": "X-Slack-Signature", "algorithm": "sha256", "encoding": "hex",
                           "signedPayload": "v0:{timestamp}:{body}", "timestampHeader": "X-Slack-Request-Timestamp", "toleranceSec": 300, "prefix": "v0=" }
}
```

Notes: app-level event subscriptions (one Events API endpoint for our Slack app) — `parseWebhook` routes by `team_id` → connections; non-idempotent `send_message` is retried only on errors proven pre-send (connect errors), using `client_msg_id` for dedupe where supported.

### 34.2 Gmail

* OAuth2 (Google), scopes `gmail.send` (action) and `gmail.readonly` or `gmail.metadata` (trigger) — minimal-scope selection per used actions, incremental authorization when a user adds a trigger later (`:reauthorize` with extra scopes). Google restricted-scope verification is a compliance prerequisite (security assessment) — tracked in `25-security-observability-infrastructure.md`.
* Trigger `new_email` (label/query filter): **push** via Gmail `watch` → Google Pub/Sub push → our endpoint (verification `jwt` with Google-signed OIDC token); event contains `historyId` only → runtime calls `history.list(startHistoryId)` with the cursor from `integration_trigger_states` → emits messages. Watch renewal daily (expires ≤ 7 days). Fallback polling every 2–5 min when push setup fails.
* Action `send_email` (MIME built by framework helper; attachments from Tabula attachments streamed via signed URL fetch, size ≤ 25 MB). Contact timeline integration: sent/received emails matched to `contact_identifiers` → `contact.activity_logged` (`contact_activities`, source externalId = Gmail message ID for dedupe).

### 34.3 Google Calendar

* Actions: `create_event`, `update_event`, `find_events`; trigger `event_created_or_updated` via `events.watch` channels (token-verified, renewal) with `syncToken` incremental listing; sync resource `calendar_events` (`incremental: "cursor"` using `syncToken`; `410 Gone` from provider ⇒ full resync automatically).
* Time zones: event times mapped to `datetime` fields (UTC) with the calendar's tz stored in the field display option.

### 34.4 HubSpot/Salesforce-like CRM (`crm-generic` pattern + specific connectors)

* OAuth2 with per-org instance URL (Salesforce-like: `instance_url` returned from token endpoint stored in `metadata`, egress allowlist pattern `*.my.provider.example`).
* Actions: `upsert_contact` (by email), `create_deal`, `update_deal_stage`, `search_records` (provider query passthrough with schema); dynamic options for pipelines/stages/owners.
* Triggers: provider webhooks where available (HMAC v3-style signatures with timestamp), else polling `updated_since` with overlap + seen-ID ring.
* Sync resources: `contacts`, `companies`, `deals` → synced tables; **two-way** (V2) is explicitly out of scope for sync tables; write-back happens via automation actions (`record.updated` in Tabula → `update_deal_stage`), with loop prevention through `excludeOwnChanges`-like origin tagging: writes made by the connector carry `actor.type=integration` and the trigger matcher skips automations whose trigger is "record updated" when `via=sync` unless explicitly enabled.
* Provider rate limits (e.g. 100 req/10 s per app): manifest `rateLimits` with `scope: 'app'` enforced by a shared GCRA bucket keyed `rl:connector:{id}:{externalAccountId}`.

### 34.5 Generic HTTP

* Auth: `none`, `api_key` (header/query), `basic`, `oauth2` (user supplies client ID/secret + URLs — "custom OAuth app"), or `custom` header set from `secrets`.
* Action `request`: method, URL template (tokens from previous steps), headers, query, JSON/form body, response parsing (JSON path extraction → output schema inferred from a test call), `expectedStatus`, timeout ≤ 60 s, response size ≤ 5 MB.
* Security: egress proxy blocks private/link-local/metadata IPs and non-HTTP(S) schemes; DNS rebinding protection (resolve-then-connect pinned IP); no redirects to disallowed hosts; secrets referenced as `{{secret.NAME}}` are injected host-side and redacted from logs.
* Trigger side is covered by **inbound webhooks** (`inbound_webhooks`, automation trigger "When webhook received") with optional HMAC verification config.

---

## 35. Proposed additions

| Item | Kind | Reason |
|---|---|---|
| `core.connectors`, `core.connector_versions` | Tables (control plane) | Connector catalogue: id, tier, publisher, status, manifest JSON, bundle S3 key + hash, review state, kill-switch flag (§33) |
| `data.integration_trigger_states` | Table | Polling/webhook trigger cursor + seen-ID ring + external subscription ID/expiry per (automation version or sync source, trigger) (§30–31) |
| `core.public_link_directory` | Table (control plane) | `share_id → workspace/shard` routing for anonymous share requests (same table as 04 §6.29 / 05; also routes inbound webhook tokens) (no base ID in public URLs); alternative: encode shard hint in share ID (rejected: leaks topology, complicates moves) |
| `data.share_links` columns: `access`, `token_hash`, `token_prefix`, `password_hash`, `allowed_emails`, `allowed_email_domains`, `capabilities jsonb`, `embed jsonb (enabled, frame_ancestors, secret_enc)`, `share_epoch`, `expires_at`, `status`, `stats jsonb`, `last_accessed_at` | Columns | §20–24 |
| `data.inbound_webhooks.kind` (`automation`/`connector`), `connection_id`, `route_token_hash` | Columns | Provider webhook routing (§30) |
| `data.import_jobs` columns: `mapping jsonb`, `analysis jsonb`, `checkpoint jsonb`, `deletion_batch_id`, `created_record_ranges jsonb`, `schema_version_at_mapping`, `cancel_requested bool`, `result jsonb`, `long_operation_id` | Columns | §5, §9, §11 |
| `data.import_errors` columns: `severity`, `code`, `raw_value` | Columns | §12 |
| `data.export_jobs` columns: `source jsonb`, `format`, `options jsonb`, `permission_epoch`, `object_key`, `row_count`, `size_bytes`, `snapshot_seq`, `long_operation_id` | Columns | §14–17 |
| `data.sync_sources` columns: `field_map jsonb`, `cursor jsonb`, `deletion_mode`; hidden system field `__external_id` per synced table | Columns / convention | §32 |
| `data.automations.settings.runOnImports` (default false) | Setting key | §10 |
| `data.fields` AI config `autoRun` including `on_import` | Config key | §9 |
| Redis namespaces `share:{shareId}`, `share:magic:{hash}`, `share:hll:{shareId}:{day}`, `lock:integration-refresh:{conId}`, `rl:connector:{id}:{acct}` | Redis | Not listed in Spine §10 (`lock:` and `rl:` prefixes exist; `share:` is new) |
| Queue `integration-refresh` **or** reuse `maintenance` | Queue | We reuse `maintenance` (no new queue) — listed for reconciliation only |
| Org policy keys: `sharing.revokeLinksOnCreatorRemoval`, `integrations.allowList/denyList/allowedTiers`, `exports.allowedRoles` | Policy keys | `organization_policies` |
| Hostnames `share.tabula.example`, `hooks.tabula.example` | Infra | Origin isolation for public content and inbound hooks |
