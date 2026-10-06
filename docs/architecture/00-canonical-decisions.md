# 00 — Canonical Decisions, Conventions & Inventories ("the Spine")

> **Status:** Proposed for architectural approval · **Owner:** Platform Architecture · **Date:** 2026-10-03
>
> This file is normative. Every other document in `docs/architecture/` conforms to the names, IDs, decisions and inventories defined here. If another document disagrees with this one, this one wins and the other is a bug.
>
> Working product name used throughout: **Tabula** (placeholder). Package scope: `@tabula/*`.

---

## 0. Provenance rule (applies to every document)

We distinguish three kinds of statements and label them where it matters:

| Label | Meaning |
|---|---|
| **[Observed]** | Publicly observable behavior of Airtable-style products (UI, public API docs, public limits, public marketing). Used only to define *capabilities*. |
| **[Inferred]** | A reasonable architectural inference about how such a capability is *likely* built. Never presented as knowledge of any vendor's private implementation. |
| **[Ours]** | Our recommended design. This is what we build. |

We do not reproduce any vendor's proprietary code, internal data model, internal names, UI artwork, formula function *implementations*, or API shapes verbatim. Our field type keys, endpoint shapes, IDs, event names, and UI are our own.

---

## 1. Core architectural decisions (summary — full ADRs in `33-architecture-decision-records.md`)

| # | Decision | Choice |
|---|---|---|
| D1 | Architecture style | **Modular monolith** in TypeScript, one codebase, deployed as multiple **process roles**: `api`, `realtime`, `worker`, `scheduler`, `relay`. Enforced module boundaries (lint rules + package boundaries). Extraction candidates later: realtime gateway, file processing, search indexer, AI gateway, automation runner. |
| D2 | Primary database | **PostgreSQL 16+**. Split into a **control plane** (one cluster **per regional cell**, e.g. US and EU: identity, orgs, workspace directory, billing, grants, notifications), a tiny **global login directory** (`global` schema, routes login/domain → home region), and **data plane shards** ("cells": many Postgres clusters per region, each hosting many workspaces' base content). *(Amended in reconciliation — §14.)* |
| D3 | Shard unit | **Workspace affinity**: all bases + the contact directory of a workspace live on the same shard. Routing via `core.workspace_directory` / `core.base_directory`. Large enterprises get dedicated shards. A workspace can be moved between shards by an online migration tool. |
| D4 | Tenant isolation | Shared-schema multi-tenancy. Every tenant row carries `org_id` (control plane) or `workspace_id` (data plane). **Postgres RLS** as defense in depth keyed on `SET LOCAL app.workspace_id`. Enterprise option: dedicated shard (+ dedicated KMS key). |
| D5 | IDs | **UUIDv7** (`uuid` type) for every primary key. Public IDs are type-prefixed base62 encodings of the UUID (`rec_5Xk…`). Prefix table in §3. Encoding/decoding only at API/realtime boundary. |
| D6 | Record storage | **Hybrid**: canonical user cell values in `records.cells JSONB` keyed by **field slot** (small int per table, never reused); computed values materialized in `records.computed JSONB`; links normalized in `record_links`; **typed index sidecars** (`record_index_num`, `record_index_text`, `record_index_time`) for fields that need index-backed filter/sort on large tables. No dynamic DDL per user table. |
| D7 | Computed fields | Materialized, maintained by the **Compute Engine** using a field-level dependency graph + record-level propagation through links. Same-record formulas recalculated **synchronously** in the write transaction. Cross-record propagation synchronous when fan-out ≤ `COMPUTE_SYNC_FANOUT_LIMIT` (default 500 records), otherwise deferred to the `compute` queue with records marked stale. Volatile formulas (`NOW()`, `TODAY()`) recomputed by scheduled buckets. |
| D8 | Formula engine | Own grammar; hand-written lexer + **Pratt parser** → typed AST → type checker → compiled JS closures. **Isomorphic** package (`@tabula/formula`) used by server (authoritative) and client (preview/validation). No `eval`, no user JS in formula engine. |
| D9 | Realtime | **Server-authoritative operations**, no CRDT/OT for structured cells. Per-base total order via `base_runtime.change_seq`. **Cell-level last-writer-wins**; set-semantics ops for links/multi-select/collaborators (add/remove commute). Optional `If-Match` record version for strict API clients. Yjs CRDT only for rich long-text documents (V1+). WebSocket gateway, Redis for presence. |
| D10 | Change log | `base_changes` table: per-base ordered, retained 30 days — feeds realtime catch-up, public webhook cursors, undo/redo, and sync. |
| D11 | Event delivery | **Transactional outbox** (`outbox_events` + `base_changes`) read by the `relay` via **Postgres logical replication** (commit-ordered, gap-free) → **Kafka-API event log** (Amazon MSK or Redpanda). MVP profile: relay dispatches directly to BullMQ queues (same `EventBus` interface). |
| D12 | Jobs | **BullMQ on Redis** (dedicated cluster, AOF) for task execution; **durable state always in Postgres** (`automation_runs`, `long_operations`, `webhook_deliveries`…). A **reconciler** re-enqueues Postgres rows stuck in `queued`/`running` past their lease. Temporal evaluated and deferred (ADR). |
| D13 | Cache | Redis (ElastiCache/Valkey): schema snapshots, permission snapshots, presence, rate-limit buckets, idempotency fast-path, session lookup. Never the source of truth. |
| D14 | Search | MVP: Postgres FTS (`search_documents` with `tsvector` + `pg_trgm`). V1: **OpenSearch** fed from the event log, per-shard indices, permission-filtered by accessible base IDs. |
| D15 | Files | S3-compatible object storage, presigned direct upload (multipart), quarantine → ClamAV scan → promote, libvips thumbnails, ffmpeg video posters, CloudFront signed URLs. |
| D16 | API | Public **REST/JSON**, `/v1`, resource-oriented, cursor pagination, JSON filter AST (same AST as views) via `POST …/records:query`. RFC 9457 problem+json errors. `Idempotency-Key` on mutating requests. Outbound webhooks with cursors. **No public GraphQL** (ADR). Internal frontend uses the same REST API + WebSocket. |
| D17 | Backend stack | Node.js 22 LTS, TypeScript (strict), **Fastify**, **Kysely** (typed SQL builder; dynamic SQL is core to the product, so no heavy ORM), Zod for internal validation, TypeBox/JSON Schema for OpenAPI generation, pino, OpenTelemetry. |
| D18 | Frontend stack | React 19 + TypeScript + **Vite SPA** (app is auth-gated & highly interactive; SSR adds little). TanStack Router, TanStack Query (metadata/server state), custom normalized **RecordStore** (`useSyncExternalStore`) for record data + realtime ops, Zustand for UI state, **custom canvas grid** (prior art: Glide Data Grid, MIT), Radix UI primitives + own design system. Marketing site separate (Next.js or Astro). |
| D19 | Auth | In-house identity core: opaque session tokens (HttpOnly cookie) stored hashed in Postgres + cached in Redis; Argon2id passwords; TOTP + WebAuthn MFA; OAuth social login; **SAML/OIDC SSO via BoxyHQ SAML Jackson (self-hosted, OSS)** behind our `SsoProvider` interface (WorkOS as buy-alternative); SCIM 2.0 server in-house. Public API: PATs, service-account tokens, OAuth 2.1 (PKCE) for third-party apps. |
| D20 | Permissions | Hierarchical **RBAC with additive grants** (org → workspace → base, max-role wins) + **deny-style restrictions** at table/field/view (and record-scoped visibility via interfaces and Enterprise row policies). Compiled into a **PermissionSnapshot** per (principal, base), cached in Redis, invalidated by `perm_epoch`. |
| D21 | Automations | Own durable step runner on Postgres state + BullMQ execution. Trigger matcher consumes events; runs are idempotent (`automation_id + trigger_event_id`). Loop protection via causation chain depth and per-automation budgets. Scripts run in isolated **sandbox workers** (V8 isolates via `isolated-vm`, or Firecracker/Deno subprocess for heavier workloads) with no ambient credentials. |
| D22 | AI | `@tabula/ai` provider abstraction + AI gateway module: prompt templates (versioned), model routing, token/cost metering, response caching, per-workspace data-access policy, execution logs. Default provider: Anthropic Claude (`claude-sonnet-5` default; `claude-haiku-4-5-20251001` for high-volume classification/extraction; `claude-opus-5-5` for agents/complex reasoning). Other providers pluggable. |
| D23 | Infra | AWS reference deployment: CloudFront → ALB → **EKS** (justified from V1: ≥5 process roles, per-queue autoscaling, isolated sandbox pools); MVP may run on ECS Fargate with identical containers. RDS PostgreSQL (Aurora acceptable), ElastiCache, MSK/Redpanda, S3, OpenSearch Service. Terraform + Argo CD/GitHub Actions. |
| D24 | Observability | OpenTelemetry everywhere → Grafana stack (Tempo traces, Mimir/Prometheus metrics, Loki logs) or Datadog as buy-alternative; Sentry for errors; pganalyze/pg_stat_statements for DB. |
| D25 | Undo/redo | **Server-side command log with inverse operations** (stored on `base_changes.inverse_ops`), client keeps a per-session stack of change IDs. Not event sourcing. |
| D26 | Event sourcing | **Not** used as the system of record. Current-state tables are authoritative; the change log is an audit/replication aid with bounded retention. |

---

## 2. Planes, schemas, process roles

```
Global directory        (schema: global)    — tiny, global; login/domain → home region only
Control plane Postgres  (schema: core)      — one cluster per region (+replicas)
Data plane Postgres     (schema: data)      — N shards ("cells"), each hosts many workspaces
Audit store             (schema: audit)     — hot partitions in a dedicated Postgres; cold Parquet in S3
Jobs                    Redis (BullMQ)      — execution only; durable state in Postgres
Event log               Kafka API           — topics in §7
Cache/presence          Redis               — key namespaces in §10
Search                  OpenSearch (V1)     — Postgres FTS in MVP
Objects                 S3                  — buckets in §11
```

Process roles (same container image, different entrypoint):

| Role | Entry | Responsibility |
|---|---|---|
| `api` | `apps/server/src/entrypoints/api.ts` | HTTP REST API (public + first-party), auth, validation, transactions |
| `realtime` | `…/realtime.ts` | WebSocket gateway: subscriptions, presence, fan-out of `base_changes` |
| `worker` | `…/worker.ts --queues=…` | BullMQ consumers, horizontally scaled per queue group |
| `scheduler` | `…/scheduler.ts` | Leader-elected cron: scheduled automations, volatile formula buckets, purge, reconciler, partition maintenance |
| `relay` | `…/relay.ts` | Logical-replication reader per shard → Kafka (or BullMQ in MVP profile) |
| `sandbox` | separate image | Executes user scripts (automation scripts, extensions) with no network except allowlisted egress proxy |

---

## 3. Identifier conventions

* Primary keys: `id uuid` generated **in the application** as UUIDv7 (so IDs exist before insert for outbox/idempotency). Postgres default `uuidv7()` (PG18) or extension fallback is allowed but app generation is canonical.
* Public IDs: `<prefix>_<base62(uuid bytes)>` (22 base62 chars). Decoding validates prefix ↔ resource type.

| Prefix | Entity | Prefix | Entity |
|---|---|---|---|
| `org` | organization | `ctc` | contact (record in contact directory) |
| `wsp` | workspace | `itf` | interface |
| `usr` | user | `pag` | interface page |
| `tem` | team | `elm` | interface element (component) |
| `bas` | base | `aut` | automation |
| `tbl` | table | `atv` | automation version |
| `fld` | field | `run` | automation run |
| `rec` | record | `stp` | automation step run |
| `opt` | select option (choice) | `att` | attachment |
| `viw` | view | `cmt` | comment |
| `vsc` | view section (sidebar folder) | `ntf` | notification |
| `shr` | share link | `whk` | outbound webhook subscription |
| `ihk` | inbound webhook endpoint | `con` | integration connection |
| `sct` | secret | `tok` | API token (display id only; secret part separate) |
| `svc` | service account | `app` | OAuth client app |
| `evt` | event | `chg` | base change (`base_changes`) |
| `imp` | import job | `exp` | export job |
| `lop` | long operation | `snp` | base snapshot |
| `rev` | record revision | `inv` | invitation |
| `aij` | AI invocation | `tpl` | template |


* **Field slots:** `fields.slot smallint`, unique per table, assigned monotonically from `tables.next_field_slot`, **never reused** (even after hard delete). JSONB keys in `records.cells` / `records.computed` are the slot as a decimal string: `{"1": "Acme", "4": 1200}`.
* **Select options** have stable IDs (`opt_…`); cells store option IDs, never labels → rename is O(1).
* **Autonumber:** `records.row_number bigint` allocated from `tables.next_row_number` (per-table counter row, `UPDATE … RETURNING`); never reused.
* **Ordering keys** (manual record order, link order, option order, field order): **fractional index strings** (`lexorank`-style base62 keys) to allow inserts between neighbors without renumbering.

---

## 4. Field types (canonical keys — ours)

Each type is a plugin implementing `FieldTypeDefinition` (see `07-field-engine.md`).

| Key | Storage location | Canonical stored JSON value | Notes |
|---|---|---|---|
| `text` | cells | `string` (≤ 10k chars) | single line |
| `long_text` | cells | `string` (≤ 100k chars) or `{ "doc": <rich-text JSON>, "plain": string }` when `richText: true` | Yjs doc for collaborative rich text in V1+ stored in `record_rich_docs` |
| `number` | cells | JSON number | `precision` 0–8 |
| `currency` | cells | decimal **string** `"1234.56"` | avoids float error; `currencyCode`, `precision` |
| `percent` | cells | JSON number (0.25 = 25%) | |
| `date` | cells | `"YYYY-MM-DD"` | |
| `datetime` | cells | ISO-8601 UTC `"2026-10-03T14:05:00.000Z"` | `timeZone` display option |
| `duration` | cells | JSON number (seconds) | `format` h:mm, h:mm:ss… |
| `checkbox` | cells | `true` (absent ⇒ false) | |
| `single_select` | cells | `"opt_…"` | options in `fields.config.options[]` |
| `multi_select` | cells | `["opt_…", …]` | set semantics in realtime ops |
| `email` / `phone` / `url` | cells | `string` (normalized + raw preserved for phone) | |
| `rating` | cells | int 1..max | |
| `collaborator` | cells | `"<user uuid>"` or `[...]` when `allowMultiple` | references `core.users` |
| `attachment` | cells | `["<attachment uuid>", …]` | metadata in `attachments` |
| `barcode` | cells | `{ "text": string, "symbology"?: string }` | |
| `link` | **record_links** | (none in cells) | `allowMultiple`, `inverseFieldId`, `linkRelationId` |
| `contact` | **record_links** (relation to workspace contact directory table) | (none in cells) | specialised link to system contacts table |
| `formula` | computed | typed by result type | |
| `lookup` | computed | array of target values | |
| `rollup` | computed | scalar (aggregate over formula on linked values) | |
| `count` | computed | int | |
| `autonumber` | `records.row_number` | — | |
| `created_time` / `modified_time` | record columns / computed | ISO string | `modified_time` may watch specific fields → computed |
| `created_by` / `modified_by` | record columns / computed | user uuid | |
| `button` | none (config only) | — | action config: open URL / run automation / run script |
| `ai_generated` | computed (async) | `{ "value": any, "status": "ok|pending|error", "inv": "<ai invocation uuid>" }` | |
| `json` (internal/advanced) | cells | any JSON ≤ 64KB | for integrations & sync |

Rules: **empty value ⇒ key absent** (never store `null`). Values validated & normalized by the field type before write.

---

## 5. Canonical table inventory

Full DDL lives in `05-sql-schema.md`; the inventory with columns/indexes in `32-table-and-object-inventory.md`. Only these tables **plus the ratified additions in §14.2** exist (117 tables in total). Any document needing another table must list it under a "Proposed additions" heading for reconciliation.

### 5.1 Control plane — schema `core`

| Table | Purpose |
|---|---|
| `organizations` | Tenant root (billing, SSO, policies) |
| `organization_domains` | Verified email domains (SSO enforcement, auto-join) |
| `organization_members` | user ↔ org with org role (`owner`, `admin`, `billing_admin`, `member`, `guest`) |
| `organization_policies` | Enterprise policy settings (sharing restrictions, AI policy, retention, IP allowlist) |
| `users` | Global user identity (email, name, avatar, locale, tz, status) |
| `user_identities` | Login methods: password hash, OAuth provider subject, SAML/OIDC subject |
| `user_mfa_factors` | TOTP secrets (encrypted), WebAuthn credentials, recovery codes (hashed) |
| `user_preferences` | UI and notification-agnostic user prefs |
| `sessions` | Opaque session tokens (hashed), device, IP, expiry, MFA level |
| `teams` | Groups of users within an org (manually or SCIM-managed) |
| `team_members` | user ↔ team |
| `workspaces` | Container of bases; belongs to org |
| `workspace_directory` | workspace → shard routing |
| `base_directory` | base → workspace/shard routing (+ lightweight name for global listing) |
| `shards` | Data plane shard registry (DSN refs, region, status, capacity, dedicated_org_id) |
| `access_grants` | Generic role grants: (resource_type ∈ org/workspace/base/interface, resource_id, principal_type ∈ user/team/service_account, principal_id, role) |
| `invitations` | Pending invites to org/workspace/base/interface |
| `service_accounts` | Non-human principals owned by an org |
| `api_tokens` | PATs + service account tokens (hashed secret, scopes, resource restrictions, expiry) |
| `oauth_clients` | Third-party apps registered for OAuth |
| `oauth_grants` | User consent + refresh token family per client |
| `oauth_authorization_codes` | Short-lived PKCE codes |
| `sso_connections` | SAML/OIDC config per org (Jackson tenant ref) |
| `scim_directories` | SCIM endpoint tokens per org |
| `scim_group_mappings` | SCIM group ↔ team mapping |
| `plans` | Plan catalog + limits JSON |
| `subscriptions` | Org ↔ plan, billing provider refs (Stripe), seats, status |
| `usage_counters` | Current-period aggregated usage per org/metric |
| `usage_events` | Raw metering events (partitioned monthly) |
| `notifications` | In-app notifications (partitioned monthly) |
| `notification_preferences` | Per user × scope × category × channel |
| `notification_deliveries` | Email/push delivery attempts and status |
| `email_suppressions` | Bounces/complaints suppression list |
| `templates` | Template gallery metadata (+ snapshot ref in S3) |
| `feature_flags` | Flag definitions + targeting |
| `support_access_grants` | Time-boxed customer-approved staff access |
| `rate_limit_overrides` | Per org/token custom limits |

### 5.2 Data plane — schema `data` (on each shard)

| Table | Purpose |
|---|---|
| `bases` | Base metadata, settings, `schema_version`, soft delete |
| `base_runtime` | Hot counters: `change_seq`, `perm_epoch`, `schema_version` (separate row to keep `bases` rows cold) |
| `tables` | Table metadata, `primary_field_id`, `next_field_slot`, `next_row_number`, `record_count` (approx) |
| `fields` | Field metadata: `slot`, `type`, `config jsonb`, `restrictions jsonb`, order key, soft delete |
| `field_dependencies` | Edges of the field-level dependency graph (dependent_field → depends_on_field, via link field?) |
| `link_relations` | One row per bidirectional link: side A (table, field) ↔ side B (table, field), cardinality |
| `records` | Record rows: `cells jsonb`, `computed jsonb`, `cell_meta jsonb` (per-slot `{seq, by, at}`), `version`, timestamps, soft delete. **Hash-partitioned by `table_id`** |
| `record_links` | (relation_id, a_record_id, b_record_id, a_order, b_order). Hash-partitioned by `relation_id` |
| `record_index_num` | Typed index sidecar for numeric/date-as-number values |
| `record_index_text` | Typed index sidecar for text (collated, truncated sort key) |
| `record_index_time` | Typed index sidecar for timestamps |
| `record_rich_docs` | Yjs state for rich long-text cells (V1+) |
| `record_revisions` | Cell-level change history (partitioned monthly) |
| `computed_stale` | Queue/marker of (table, record, field) awaiting deferred recompute |
| `views` | View metadata + `config jsonb` (typed by view type), `visibility` (collaborative/personal/locked), order key |
| `view_sections` | Sidebar folders for views |
| `view_user_state` | Per-user overrides (personal column widths, last scroll, collapsed groups) |
| `interfaces` | Interface app metadata (draft/published version pointers) |
| `interface_pages` | Pages within an interface; `layout jsonb` (element tree) for **draft** |
| `interface_versions` | Immutable published snapshots of an interface (all pages) |
| `automations` | Automation metadata, status, current draft config, published version pointer |
| `automation_versions` | Immutable published automation definitions |
| `automation_runs` | One row per triggered run (partitioned monthly) |
| `automation_step_runs` | Per-step execution records (partitioned monthly) |
| `automation_schedules` | Next-fire times for scheduled triggers |
| `inbound_webhooks` | Endpoints that trigger automations (secret, url token) |
| `webhook_subscriptions` | Outbound API webhooks (spec, cursor, secret, status) |
| `webhook_deliveries` | Outbound delivery attempts (partitioned monthly) |
| `integration_connections` | Connected external accounts (credentials envelope-encrypted) |
| `secrets` | Workspace/base secrets for automations & scripts (envelope-encrypted) |
| `attachments` | File metadata (object key, mime, size, scan status, dims, checksum) |
| `attachment_variants` | Thumbnails/previews/posters per attachment |
| `comments` | Record (and optionally field/cell) comments, threaded via `parent_id` |
| `comment_reactions` | Emoji reactions |
| `mentions` | Parsed mentions (user/team/record/contact) from comments & long text |
| `record_subscriptions` | Users watching a record (auto on comment/mention/assign) |
| `contact_identifiers` | Normalized emails/phones/social handles for contacts (dedup + lookup) |
| `contact_merge_events` | Merge history (survivor, merged ids, field resolution) for unmerge/audit |
| `contact_activities` | Timeline items (email sent, call, meeting, note, automation action, external sync) |
| `share_links` | Public/restricted share tokens for views/interfaces/forms/bases |
| `base_changes` | Per-base ordered change log (`base_id`, `seq`) with forward ops + inverse ops (partitioned daily, 30-day retention) |
| `outbox_events` | Transactional outbox for domain events (consumed via logical replication) |
| `idempotency_keys` | API idempotency records (key, request hash, response, expiry) |
| `deletion_batches` | Groups soft-deleted objects into one restorable unit (trash entry) |
| `base_snapshots` | Point-in-time snapshot metadata (data in S3) |
| `long_operations` | User-visible async tasks: field type conversion, duplication, bulk ops, imports/exports (progress, status) |
| `import_jobs` | Import configuration, mapping, result summary |
| `import_errors` | Row-level import errors |
| `export_jobs` | Export configuration & result object key |
| `sync_sources` | External data source sync configs (Sync tables) |
| `sync_runs` | Sync executions |
| `ai_prompt_templates` | Versioned prompt templates (system + workspace-defined) |
| `ai_invocations` | Every AI call: model, tokens, cost, latency, status, input hash (partitioned monthly) |
| `search_documents` | MVP Postgres FTS documents (records, tables, fields, bases, contacts) |

### 5.3 Audit store — schema `audit`

| Table | Purpose |
|---|---|
| `audit_events` | Security & admin audit trail (partitioned monthly; hot 90 days; archived to S3 Parquet; Enterprise retention up to 7 years) |
| `audit_exports` | SIEM streaming/export configurations & checkpoints |

---

## 6. Domain event catalogue (canonical names)

Naming: `<aggregate>.<past_tense_verb>`; schema version in envelope. Envelope (CloudEvents-compatible):

```json
{
  "id": "evt_…",                 "type": "record.updated",   "schemaVersion": 1,
  "occurredAt": "2026-10-03T14:05:00.123Z",
  "tenant": { "orgId": "org_…", "workspaceId": "wsp_…", "baseId": "bas_…" },
  "actor": { "type": "user|api_token|service_account|automation|integration|ai|system|public_form", "id": "…", "via": "ui|api|automation|import|sync|form|script|undo|restore" },
  "baseSeq": 18233,              "correlationId": "…", "causationId": "evt_…", "causationDepth": 0,
  "traceparent": "00-…",
  "data": { }
}
```

| Group | Events |
|---|---|
| Identity | `user.created`, `user.updated`, `user.deactivated`, `session.created`, `session.revoked`, `mfa.enrolled`, `api_token.created`, `api_token.revoked` |
| Tenancy | `organization.created`, `organization.updated`, `workspace.created`, `workspace.updated`, `workspace.deleted`, `workspace.restored`, `member.added`, `member.role_changed`, `member.removed`, `team.updated`, `invitation.created`, `invitation.accepted`, `grant.changed` |
| Schema | `base.created`, `base.updated`, `base.deleted`, `base.restored`, `base.duplicated`, `table.created`, `table.updated`, `table.deleted`, `table.restored`, `field.created`, `field.updated`, `field.type_changed`, `field.deleted`, `field.restored`, `link_relation.created`, `link_relation.deleted` |
| Records | `record.created`, `record.updated`, `record.deleted`, `record.restored`, `records.bulk_changed` (batch envelope for imports/bulk ops), `record.links_changed`, `record.computed_updated` |
| Views/UI | `view.created`, `view.updated`, `view.deleted`, `view.restored`, `form.submitted`, `interface.created`, `interface.updated`, `interface.published`, `interface.deleted`, `button.clicked` |
| Collaboration | `comment.created`, `comment.updated`, `comment.deleted`, `mention.created`, `reaction.added`, `record.assigned` (collaborator field set to a user) |
| Contacts | `contact.created`, `contact.updated`, `contact.merged`, `contact.unmerged`, `contact.activity_logged` |
| Files | `attachment.uploaded`, `attachment.scanned`, `attachment.processed`, `attachment.rejected` |
| Automations | `automation.created`, `automation.published`, `automation.paused`, `automation.triggered`, `automation.completed`, `automation.failed`, `automation.step_failed`, `automation.disabled_by_system` |
| Integrations | `integration.connected`, `integration.token_refreshed`, `integration.auth_failed`, `integration.disconnected`, `inbound_webhook.received`, `sync.completed`, `sync.failed` |
| Sharing | `share_link.created`, `share_link.revoked`, `share_link.accessed` (sampled) |
| AI | `ai.invocation_completed`, `ai.invocation_failed`, `ai_field.value_generated` |
| History | `snapshot.created`, `snapshot.restored`, `trash.purged`, `change.undone`, `change.redone` |
| Jobs | `import.completed`, `import.failed`, `export.completed`, `long_operation.progressed`, `long_operation.completed` |
| Billing | `subscription.changed`, `usage.threshold_reached`, `limit.exceeded` |

---

## 7. Kafka topics (V1) and BullMQ queues

| Topic | Key | Content | Main consumers |
|---|---|---|---|
| `tabula.base-changes.v1` | `base_id` | `base_changes` rows (ordered per base) | realtime fan-out, webhook dispatcher, sync exporters |
| `tabula.domain-events.v1` | `workspace_id` (or `base_id` for base-scoped) | outbox domain events | automation trigger matcher, notification router, search indexer, audit writer, usage meter, AI field runner, contact timeline |
| `tabula.audit.v1` | `org_id` | audit events | audit writer, SIEM exporter |
| `tabula.usage.v1` | `org_id` | metering events | usage aggregator, billing |
| `*.dlq` | same | poison messages | ops tooling, replay |

BullMQ queues (each a separate worker pool with own concurrency/autoscaling): `compute`, `automation-trigger`, `automation-step`, `automation-schedule`, `webhook-out`, `email`, `notification`, `search-index`, `file-scan`, `file-process`, `import`, `export`, `ai`, `sync`, `snapshot`, `purge`, `maintenance`.

---

## 8. Public API conventions (detail in `17-api-architecture.md`, `31-api-specification.md`)

* Base URL: `https://api.tabula.example/v1`
* Hierarchical resources, public IDs only, e.g. `GET /v1/bases/{baseId}/tables/{tableId}/records`.
* Mutations accept `Idempotency-Key`. Optimistic concurrency via `If-Match: "<version>"` (records, views, interfaces, automations).
* Query: `POST /v1/bases/{baseId}/tables/{tableId}/records:query` with `{ filter, sort, fields, search, pageSize, cursor, viewId, cellFormat }`.
* Pagination: opaque cursor (`next_cursor`), `pageSize` ≤ 1000 (default 100).
* Batch writes: ≤ 1000 records per request (`POST …/records:batch`), all-or-nothing by default, `"atomic": false` for partial-success mode with per-item results.
* Errors: `application/problem+json` with `type`, `title`, `status`, `code` (stable machine code e.g. `FIELD_VALIDATION_FAILED`), `detail`, `errors[]`, `requestId`.
* Field references in API accept field ID (canonical) or name (convenience, `fieldKey=name` param).
* Rate limits (default, plan-adjustable): 20 req/s per token, 50 req/s per base, 5,000 records written/min per base; headers `RateLimit-Policy`, `RateLimit` (IETF draft), 429 with `Retry-After`.

---

## 9. Permission vocabulary

Roles (ordered, higher includes lower within a scope):

* Org: `owner` > `admin` > `billing_admin` (billing only) ; `member` ; `guest` (no org-level visibility, only explicit grants)
* Workspace: `owner` > `creator` > `editor` > `commenter` > `viewer`
* Base: `creator` > `editor` > `commenter` > `viewer` ; plus `interface_only` (access only to granted interfaces)
* Interface: `interface_editor` (can edit interface layout) > `interface_user` (use, subject to element-level edit permissions)

Actions (permission checks use these strings): `org.manage`, `org.billing`, `workspace.manage`, `workspace.create_base`, `base.read`, `base.manage_schema`, `base.manage_members`, `base.share`, `table.create`, `table.update`, `table.delete`, `field.create`, `field.update`, `field.delete`, `record.read`, `record.create`, `record.update`, `record.delete`, `record.comment`, `view.read`, `view.create_collaborative`, `view.create_personal`, `view.update`, `view.lock`, `interface.read`, `interface.edit`, `interface.publish`, `automation.read`, `automation.edit`, `automation.run`, `integration.manage`, `export.data`, `api.access`, `audit.read`, `ai.use`.

Restriction overlays (deny-style, stored with the resource): `tables.restrictions` (who may create/delete records), `fields.restrictions` (who may edit; Enterprise: hide), `views.visibility = locked` (who may change config), interface element permissions, Enterprise `row_policies` inside `tables.restrictions`.

---

## 10. Redis key namespaces

`sess:{tokenHash}` · `perm:{principalId}:{baseId}:{permEpoch}` · `schema:{baseId}:{schemaVersion}` · `rl:{scope}:{id}:{window}` · `idem:{scope}:{key}` · `presence:{baseId}` (hash, TTL) · `ws:route:{connId}` · `lock:{name}` · `ratebudget:automation:{automationId}:{hour}` · `ai:cache:{hash}` · `feature:{flag}`.

---

## 11. Object storage buckets

`tabula-uploads-quarantine` (presigned upload target, private, 7-day lifecycle) · `tabula-attachments` (clean originals, SSE-KMS) · `tabula-attachment-variants` (thumbnails/previews) · `tabula-exports` (7-day lifecycle) · `tabula-snapshots` (base snapshots, versioned) · `tabula-audit-archive` (Parquet, object lock in Enterprise) · `tabula-backups` (cross-region replicated).

Object key convention: `{workspaceId}/{baseId}/{attachmentId}/{variant}`.

---

## 12. Plan limits (initial, configurable in `core.plans.limits`)

| Limit | Free | Team | Business | Enterprise |
|---|---|---|---|---|
| Records per base | 2,000 | 100,000 | 500,000 | 2,000,000 (10M on dedicated shard) |
| Fields per table (engine hard limit 500) | 500 | 500 | 500 | 500 |
| Tables per base (hard limit 500) | 50 | 200 | 500 | 500 |
| Attachment storage per base | 1 GB | 50 GB | 250 GB | 1 TB+ |
| Max file size | 50 MB | 1 GB | 1 GB | 5 GB |
| Automation runs / month | 200 | 50,000 | 250,000 | 1M+ (contract) |
| Revision history retention | 14 days | 1 year | 3 years | configurable |
| API rate (per token) | 5 rps | 20 rps | 20 rps | 50 rps |
| AI credits / month | small trial | metered | metered | contract |

---

## 13. Shared engineering constants

| Constant | Value |
|---|---|
| `COMPUTE_SYNC_FANOUT_LIMIT` | 500 records |
| `MAX_CAUSATION_DEPTH` (automation loop guard) | 8 |
| `MAX_FORMULA_DEPTH` (AST nesting) | 64 |
| `MAX_DEPENDENCY_CHAIN` (field graph depth) | 32 |
| `INDEX_SIDECAR_THRESHOLD` (rows before sidecar indexes auto-enabled for a table's sorted/filtered fields) | 20,000 records |
| `BASE_CHANGES_RETENTION` | 30 days |
| `TRASH_RETENTION` | records/views 30 days; tables/bases/workspaces 30 days (Enterprise configurable up to 180) |
| `WS_HEARTBEAT` | 25 s |
| Grid page window | 200 rows per fetch, prefetch ±2 windows |


---

## 14. Reconciliation amendments (ratified)

The other 34 documents were drafted in parallel against this spine, and each one ended with "Proposed additions". This section records what was ratified. These amendments are as normative as §1–13.

### 14.1 Decision amendments

| # | Amendment | Reason | Affected docs |
|---|---|---|---|
| A1 | **D2 regionalized:** one control plane per regional cell (US, EU) plus a tiny `global` schema (`login_directory`, `domain_directory`) that only routes a login email or verified domain to its home region. All tenant data, including org metadata, stays in-region. | US/EU data residency ([19 §25](19-permissions-and-multitenancy.md)) contradicted a single global control plane. | 03, 04, 05, 19, 25 |
| A2 | **Contact directory naming:** `bases.kind = 'contact_directory'` with two system tables, **Contacts** and **Companies**. `contact.kind ∈ {person, company}` is exposed in the API. The draft name `system_contacts` is retired. | 02, 05 and 12 already modelled companies as a separate table, which gives person→company links for free. | 01, 02, 05, 12 |
| A3 | **Field type change = new slot + dual-write + atomic switch.** Converted values are written into a fresh slot while edits write both slots; a single metadata flip activates it. The old slot is kept 30 days so the change can be undone. | Online, cancellable, and no in-place rewrite of live cells. | 06, 07, 27 |
| A4 | **Formula errors** are stored as an absent value plus `cell_meta[slot].err`. Filters treat an errored cell as empty. | One empty-value semantics across filter, sort and API. | 06, 08, 11 |
| A5 | **Sort tiebreaker** is `records.id` (UUIDv7), not `row_number`. With no sort, a view falls back to `records.manual_order`, overridden per view by `view_record_orders`. | Matches sidecar index and cursor layout. | 06, 10, 11 |
| A6 | **Index sidecars** are keyed by `(table_id, field_slot, ord)` with `value_eq` and `sort_key` columns, not by `field_id`. One shared JS fold function is the only producer of `value_eq`. | Defined in 06; 05 and 11 follow. | 05, 06, 11 |
| A7 | **Realtime ticket:** `POST /v1/auth/ws-ticket` returns a single-use EdDSA JWT (prefix `wst_`) with a 30 s TTL. Interactive edits travel as WS `op` frames; REST plus `X-Tabula-Client-Op-Id` is the fallback and the bulk path. | 16, 17, 24, 25 and 31 used different paths and TTLs. | 16, 17, 24, 25, 31 |
| A8 | **User-content domain:** `tabulausercontent.example` (attachments, previews, sandboxed embeds under `*.ext.`). Public shares are served on `share.tabula.example`; inbound hooks on `hooks.tabula.example`. | Naming drift between 18 and 25. | 18, 20, 25 |
| A9 | **Partition management:** `pg_partman` 5.x, driven by the `scheduler` role's `partition-maintenance` task. Per-plan retention inside partitions is done by batched deletes. | 04/05 used pg_partman and 27 an in-house manager; aligned on pg_partman. | 04, 05, 27 |
| A10 | **Control-plane outbox:** `core.outbox_events` plus a control-plane relay (`tabula_core_relay_pub`). Control-plane modules emit events in their own transaction, exactly like data-plane modules. | 02, 19 and 27 depend on events from identity, tenancy and grant changes. | 15, 19, 27 |
| A11 | **Org admins have no implicit content access.** Reading workspace content requires a time-boxed, audited `admin_elevation` grant (`access_grants.source`). | Enterprise trust model. | 19, 22 |
| A12 | **Shared views/interfaces/automations fail closed on dangling references:** a filter condition on a deleted field matches **no** records there. Ordinary collaborative views ignore that condition and flag the view instead. | Deleting a field must never widen what a share or interface exposes. | 10, 13, 14 |
| A13 | **Imports do not trigger automations by default.** `automations.settings.runOnImports` is off by default; outbound webhooks always see import changes. | Prevents run storms on bulk loads. | 14, 20 |
| A14 | **Error catalogue** is the single list in [17 §14.2–14.3](17-api-architecture.md) (118 codes). Synonyms were normalized: `FILTER_TOO_COMPLEX` → `QUERY_TOO_COMPLEX`, `RECORD_VERSION_MISMATCH` → `VERSION_CONFLICT`, `LIMIT_EXCEEDED` → `PLAN_LIMIT_EXCEEDED`, `EGRESS_BLOCKED` → `EGRESS_DESTINATION_BLOCKED`, and others. | Engine docs had coined parallel names. | all |
| A15 | **API versioning:** `/v1` path major plus a dated `Tabula-Version` header; every token is pinned to a version. Simple GET list filters use `filter=fld:op:value,…` (AND only, ≤ 10 conditions), compiled to the same filter AST; everything else uses `POST …/records:query`. | Decided in 17. | 17, 31 |

### 14.2 Ratified table additions (DDL in [05 §7.13 and §7.18](05-sql-schema.md))

| Schema | Table | Purpose |
|---|---|---|
| `global` | `login_directory`, `domain_directory` | Region routing at login (A1) |
| `core` | `public_link_directory` | Route share-link and inbound-webhook tokens (no IDs in public URLs) to workspace/shard |
| `core` | `workspace_migrations` | Online workspace-move state machine |
| `core` | `outbox_events`, `relay_checkpoints` | Control-plane outbox and relay checkpoint (A10) |
| `core` | `idempotency_keys` | Idempotency for control-plane mutations |
| `core` | `org_encryption_keys` | BYOK CMK references |
| `core` | `connectors`, `connector_versions` | Connector registry |
| `core` | `migration_runs` | Shard migration orchestrator |
| `core` | `privacy_erasure_ledger` | GDPR erasures re-applied after restores |
| `data` | `workspace_keys` | Per-workspace DEKs (envelope encryption) |
| `data` | `attachment_blobs` | Content-addressed blobs with refcounts |
| `data` | `view_record_orders` | Per-view manual record order |
| `data` | `view_watches`, `view_match_state` | "Record enters/leaves view" trigger state |
| `data` | `relay_checkpoints` | Data-plane relay checkpoint per shard |
| `data` | `schema_revisions` | Schema/config history |
| `data` | `contact_duplicate_candidates` | Dedup review queue |
| `data` | `integration_trigger_states` | Polling cursors and provider webhook registrations |
| `data` | `interface_user_state` | Per-user interface state (V1) |
| `data` | `ai_agent_sessions`, `ai_feedback` | AI agents and output feedback |

Deferred: `push_devices` (V2), `record_large_values` (only if profiling demands), `record_index_geo` (needs a `location` type). Rejected: `users.perm_epoch` (Redis counter suffices), `share_link_directory` (merged into `public_link_directory`).

### 14.3 Ratified column additions (highlights)

| Table | Columns |
|---|---|
| `records` | `external_ref` (upsert key for sync/keyed imports), `last_change_seq`, `created_via` |
| `bases` | `storage_bytes`, `write_fenced` (workspace move freeze) |
| `base_runtime` | `record_count`, `automation_index_version` |
| `tables` | `tombstoned_slots`, `purged_slots` |
| `fields` | `index_state`, `index_progress`, `conversion` (A3), `config_version` |
| `views` / `interface_pages` | `config_version` / `layout_version` (for ETags and realtime patches); `refs` arrays with GIN index (dependency lookup for A12) |
| `base_changes` | `client_mutation_id`, `operation_id` (groups e.g. an import for undo), `undo_of_change_id`, `undone_by_change_id`, `via`, `correlation_id`, `causation_depth`, `vis_ctx` |
| `outbox_events` | `topic`, `partition_key`; daily partitions kept 3 days |
| `automation_runs` / `automation_step_runs` | partitioned by `trigger_at`; `run_key`; lease, admission and idempotency columns |
| `long_operations`, durable job tables | `lease_until`, checkpoint columns |
| `notifications`, `notification_deliveries`, `usage_events`, `audit_events`, `ai_invocations`, `contact_activities` | unique source-event / dedupe keys (idempotent consumers, [15](15-events.md)) |
| `audit_events` | hash-chain columns (`prev_hash`, `row_hash`) |
| `api_tokens` | `kind` (`pat`/`service_account`/`oauth_access`), `oauth_grant_id`, `pinned_api_version`, `last_used_*` |
| `sessions` | `last_auth_at`, `mfa_level`, `rotated_from`, idle/absolute expiry, `device_label`, `ip_country` |
| `share_links` | `access_mode`, token hash/prefix, `password_hash`, allowed emails/domains, embed settings, `share_epoch`, `prefill_secret_ciphertext` |
| `contact_identifiers` | `status`, `value_canonical`, `contact_table_id` |
| `access_grants` | `source` gains `admin_elevation` and `support` (A11) |
| `workspace_directory` | `status`, `routing_epoch` |

All `data.*` tables carry `workspace_id`, and it is in the primary key or a replica-identity index, so that a row-filtered logical replication can move one workspace to another shard. Migrations run as the RLS-bypassing roles `tabula_migrator` / `tabula_maint` only.

### 14.4 Ratified constants

| Constant | Value | Owner |
|---|---|---|
| `MAX_SIDECAR_FIELDS_PER_TABLE` | 32 | 06 |
| `SYNC_CONVERT_LIMIT` (field type change done synchronously below this) | 5,000 records | 06 |
| `MAX_SELECT_OPTIONS` / `MAX_MULTI_ITEMS` / `MAX_ATTACHMENTS_PER_CELL` | 1,000 / 100 / 100 | 07 |
| `MAX_FORMULA_LENGTH` | 16,000 chars | 08 |
| Formula step budget / per-record eval budget | 100,000 steps / 10 ms | 08 |
| Volatile formula bucket (`NOW()`) | 15 min | 08 |
| `MAX_LINKS_PER_RECORD_SIDE` | 100,000 | 09 |
| `ROLLUP_SYNC_FANIN_LIMIT` | 10,000 | 09 |
| `MAX_RELATIONS_PER_BASE` | 2,000 | 09 |
| Filter limits | depth ≤ 8, conditions ≤ 200 | 11 |
| Group levels | ≤ 3 | 11 |
| `VIEW_ORDER_LIST_MAX` | 250,000 | 10 |
| Record size | ≤ 1 MB compressed | 06 |
| Mentions per comment | ≤ 50 | 18 |
| Search index lag SLO | p95 ≤ 5 s, p99 ≤ 30 s | 18 |
| Webhook payload retention guarantee | 7 days (sourced from 30-day `base_changes`) | 17 |
| Idempotency key retention | 24 h | 17 |
| Kafka retention | 7 days | 15 |
| Workspace move write-freeze | < 10 s | 19 |
| Step-up re-auth window | 10 min | 25 |

### 14.5 Ratified events and Redis namespaces

* **Events added to §6:** `workspace.moved`, `long_operation.started`, `long_operation.failed`, `attachment.detached` (optional), `view.record_entered` / `view.record_left` (internal, not public). `automation.disabled_by_system.data.reason` ∈ `hourly_budget_exceeded | loop_detected | consecutive_failures | schema_broken | integration_auth_failed`.
* **DLQ topics:** `tabula.base-changes.v1.dlq`, `tabula.domain-events.v1.dlq`, `tabula.audit.v1.dlq`, `tabula.usage.v1.dlq`.
* **Redis namespaces added to §10:** `tok:` (token lookup), `basedir:` (routing cache), `sem:` (semaphores), `share:` (share unlock / rate), `mfa:` / `webauthn:chal:` / `pwreset:` / `emailverify:` / `hibp:` / `saml:replay:` (auth flows), `ws:ticket:` (ticket single-use), `loopguard:`, `evt:` / `dlqdone:` (consumer dedupe), `aidebounce:` / `ai:budget:` / `ai:health:`, `sidx:` (search indexing), `vorder:` / `vagg:` / `itfv:` / `iagg:` (view/interface caches), `perm:epoch:{baseId}`. Pub/sub channels: `rt:base:{baseId}` (MVP fan-out), `perm-epoch`, `routing`, `sess-revoke`, `feature-flags`, `admission`.
* **Buckets added to §11:** `tabula-web-assets`.
