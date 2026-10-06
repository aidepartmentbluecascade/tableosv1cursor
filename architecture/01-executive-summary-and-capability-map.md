# 01 — Executive Summary & Product Capability Map

> **Sections covered:** §1 Executive Summary · §2 Product Capability Map (16 conceptual questions per feature) · Part 57 "What we should NOT copy".
>
> **Status:** Proposed · **Owner:** Platform Architecture · **Date:** 2026-10-03 · Conforms to [`00-canonical-decisions.md`](./00-canonical-decisions.md) (the "spine"). Where this document and the spine disagree, the spine wins.

---

## Table of contents

1. [Executive summary](#1-executive-summary)
   1. [What we are building](#11-what-we-are-building)
   2. [Design principles](#12-design-principles)
   3. [Key architectural bets](#13-key-architectural-bets)
   4. [Why a modular monolith](#14-why-a-modular-monolith)
   5. [Planes, shards and cells](#15-planes-shards-and-cells)
   6. [Hybrid record storage](#16-hybrid-record-storage)
   7. [Server-authoritative realtime](#17-server-authoritative-realtime)
   8. [Outbox + event log](#18-outbox--event-log)
   9. [Scope by release: MVP / V1 / Enterprise](#19-scope-by-release-mvp--v1--enterprise)
   10. [Top risks and how the architecture contains them](#110-top-risks-and-how-the-architecture-contains-them)
   11. [Document map](#111-document-map)
2. [Product capability map](#2-product-capability-map)
   - [2.0 How to read the capability tables](#20-how-to-read-the-capability-tables)
   - [2.1 Tenancy & identity](#21-tenancy--identity): Organization, Workspace, Team
   - [2.2 Schema](#22-schema): Base, Table, Field
   - [2.3 Data](#23-data): Record, Link, Lookup, Rollup & Count, Formula, Attachments
   - [2.4 Collaboration](#24-collaboration): Comments, Mentions, Contacts
   - [2.5 Views](#25-views): common view model + per-type matrix (Grid, Kanban, Calendar, Gallery, Timeline, List, Form)
   - [2.6 Apps & forms](#26-apps--forms): Forms, Interfaces
   - [2.7 Automation & integration](#27-automation--integration): Automations, Outbound webhooks, Inbound webhooks, Public API, Sync, Import, Export
   - [2.8 Platform services](#28-platform-services): Search, Record history, Undo/redo, Trash, Notifications, Sharing, Templates, AI
   - [2.9 Enterprise & commercial](#29-enterprise--commercial): Enterprise admin, SSO, SCIM, Billing
   - [2.10 Cross-feature matrices](#210-cross-feature-matrices)
3. [What we should NOT copy](#3-what-we-should-not-copy-part-57)

---

## 1. Executive summary

### 1.1 What we are building

**Tabula** is a multi-tenant SaaS product that lets non-engineers model their own relational data and build workflows on top of it. A user creates a **base** (a small relational database), adds **tables**, defines typed **fields** (text, number, select, date, attachment, link-to-another-record, formula, lookup, rollup…), enters **records** in a spreadsheet-like grid, and then:

* looks at the same records through **views** (grid, kanban, calendar, gallery, timeline, list, form) with per-view filters, sorts, grouping and hidden fields;
* builds **interfaces** — purpose-built app pages (dashboards, record review screens, portals) composed of elements bound to tables;
* automates work with **automations** (trigger → conditions → actions, including scripts and AI steps);
* integrates through a **public REST API**, **outbound webhooks**, **inbound webhooks**, **sync sources**, **import/export**;
* collaborates in realtime: concurrent editing, presence, **comments**, **@mentions**, **notifications**, record **history**, **undo/redo**, **trash**;
* manages relationships with people and organizations through a workspace-level **contact directory** that any base can link to;
* uses **AI** to generate field values, write formulas, summarize records, build bases from a prompt, and run agent-style automation steps;
* is administered by enterprises with **SSO**, **SCIM**, audit logs, data residency, policies and **billing**.

[Observed] Products in this category expose exactly this capability surface publicly (UI, public API docs, published plan limits). [Ours] Everything below is our own architecture for delivering that surface: our names, our IDs, our storage model, our API shapes.

**Scale targets** (design point for V1, see [`23`](./23-notifications-jobs-caching-performance.md) and [`25`](./25-security-observability-infrastructure.md)):

| Dimension | Target |
|---|---|
| Organizations | 500k (mostly free/team) |
| Monthly active users | 2M |
| Bases | 20M total, ~2M active per month |
| Records per base | 2M (Enterprise; 10M on dedicated shard) |
| Cell edit → other clients visible | p50 < 150 ms, p99 < 600 ms within region |
| Grid first paint for 100k-row view | p50 < 800 ms (first 200-row window) |
| Public API | p99 < 300 ms single-record read, < 1 s for 100-record batch write |
| Automation trigger latency | p50 < 2 s from commit to run start |
| Availability | 99.9% (Team/Business), 99.95% contractual (Enterprise) |
| RPO / RTO | RPO ≤ 5 min (PITR), RTO ≤ 1 h per shard |

### 1.2 Design principles

1. **Current state is truth; the log is a derivative.** Postgres current-state tables are authoritative. The change log (`base_changes`) and domain events (`outbox_events`) are produced in the *same transaction* and are therefore never ahead of or behind the truth — but they are not the system of record (D26).
2. **One write path.** UI, public API, automations, imports, sync, forms, AI and undo all go through the same `RecordCommandService` → validation → compute → change-log pipeline. No side doors; every write is attributable (`actor.type`, `actor.via`).
3. **Metadata-driven, not DDL-driven.** A user's table is rows in `data.tables`/`data.fields`, never a physical Postgres table. Schema changes are metadata transactions, never `ALTER TABLE` on user data (D6).
4. **Bounded blast radius.** Workspace affinity to a shard (D3) means a hot or broken tenant degrades one shard, not the fleet. Per-queue worker pools mean one runaway automation does not delay webhooks.
5. **Isomorphic logic where correctness must match.** Formula evaluation, filter evaluation, and field value validation live in shared packages used by both server (authoritative) and client (optimistic preview).
6. **Budgets everywhere.** Every user-programmable surface (formulas, automations, scripts, AI, API, webhooks) has explicit depth, fan-out, time, and cost budgets defined as constants (spine §13) or plan limits (spine §12).
7. **Boring infrastructure, interesting product.** Postgres, Redis, S3, Kafka-API, Kubernetes. The innovation is in the compute engine, query compiler, realtime protocol and editors — not in bespoke storage.

### 1.3 Key architectural bets

| # | Bet | Choice (spine ref) | Why | What it costs | Reversal / escape hatch |
|---|---|---|---|---|---|
| B1 | Architecture style | Modular monolith, 5 process roles + sandbox (D1) | Small team velocity, transactional consistency across schema/records/compute, one deploy | Discipline needed to keep module boundaries; a bad deploy affects all roles | Boundaries enforced from day 1 → extract realtime, file processing, search indexer, AI gateway, automation runner as services when load/teams demand |
| B2 | Data partitioning | Control plane + N data-plane shards, workspace affinity (D2, D3) | Linked records, lookups and rollups stay shard-local and transactional; tenant isolation; linear scale-out | Cross-workspace features (global search, org-wide admin) need fan-out or a derived index | Online workspace move tool; dedicated shards for big tenants |
| B3 | Record storage | Hybrid JSONB cells by slot + normalized links + typed index sidecars (D6) | No DDL per user table; O(1) schema changes; fast single-record reads; index-backed sort/filter where it matters | JSONB expression queries are slower than typed columns; sidecars add write amplification | Sidecars are per field, enabled automatically above `INDEX_SIDECAR_THRESHOLD`; columnar analytics replica is a V2 option |
| B4 | Computed fields | Materialized, dependency-graph driven, sync up to `COMPUTE_SYNC_FANOUT_LIMIT` (D7) | Reads are cheap and consistent; filters/sorts on formulas use the same machinery | Write amplification on hub records; staleness window for large fan-out | `computed_stale` markers + UI "calculating" state; per-table compute budgets |
| B5 | Formula language | Own grammar, Pratt parser, compiled closures, isomorphic (D8) | Determinism, sandbox safety, shared client/server semantics | We own a language forever (compat, docs, edge cases) | Versioned function catalog; formula `engineVersion` stored per field |
| B6 | Realtime | Server-authoritative ops, cell-level LWW, set ops for multi-valued (D9) | Structured data does not need OT/CRDT; ordering is simple and auditable | Concurrent edits of the *same* cell lose one write (visible in history) | Yjs only for rich long text (V1+); `If-Match` for strict clients |
| B7 | Event delivery | Transactional outbox → logical replication relay → Kafka API (D11) | No dual-write; commit-ordered, gap-free; replayable | Operating Kafka/Redpanda and replication slots | MVP profile dispatches to BullMQ via the same `EventBus` interface |
| B8 | Jobs | BullMQ for execution, Postgres for durable state + reconciler (D12) | Familiar, fast, per-queue pools; no loss when Redis fails over | Two sources to reconcile | Temporal evaluated; can replace runner for automations later (ADR) |
| B9 | Permissions | RBAC with additive grants + deny-style restrictions, compiled snapshot (D20) | Fast checks on hot paths (every cell write, every realtime fan-out) | Snapshot invalidation correctness is critical | `perm_epoch` bump on any grant/restriction change; snapshot is reproducible from Postgres |
| B10 | Frontend | Vite SPA + canvas grid + normalized RecordStore (D18) | 100k-row grids at 60 fps; precise control of realtime merges | Canvas accessibility work; custom text editing overlays | DOM fallback renderer for accessibility mode |

### 1.4 Why a modular monolith

**Option A — microservices from day 1.** Separate services for schema, records, compute, views, automations, etc.
*Pros:* independent deploys and scaling, team autonomy at scale. *Cons:* a single cell edit touches schema (validation), records (write), compute (formula/lookup propagation), links (inverse), history (revision), change log (realtime) and permissions — making that a distributed transaction or a saga is a large, permanent complexity tax; local dev and testing cost; network hops on the hottest path.

**Option B — modular monolith with process roles (chosen, D1).**
*Pros:* one Postgres transaction covers the entire write path (cells + computed + links + `base_changes` + `outbox_events`), which is what makes "every write is atomic, ordered, and observable" cheap. One language/runtime, one build, shared isomorphic packages. Process roles (`api`, `realtime`, `worker`, `scheduler`, `relay`, plus the separate `sandbox` image) give us most of the operational isolation and independent scaling of microservices.
*Cons:* boundary erosion risk; one deploy carries everything; noisy-neighbor modules within a process.

**Mitigations:** module boundaries enforced by package boundaries + lint (`no-restricted-imports`, dependency-cruiser rules: modules talk via their public `index.ts` service interfaces and domain events only, never each other's tables); per-role deployments with independent HPA; per-queue worker pools; feature flags for risky changes; canary deploys per role. See [`26`](./26-architecture-style-stack-repo-services.md).

**Extraction order (when, not if):** (1) realtime gateway (connection count scaling, different deploy cadence), (2) file processing (native deps: libvips/ffmpeg/ClamAV), (3) search indexer, (4) AI gateway (provider credentials, cost controls), (5) automation runner. Each is already a separate process role or queue group, so extraction is a packaging change plus replacing in-process calls with the existing event/queue interfaces.

### 1.5 Planes, shards and cells

```
               ┌──────────────── Control plane (global, schema core) ───────────────┐
               │ users, sessions, orgs, workspaces, grants, billing, notifications, │
               │ workspace_directory / base_directory (routing), shards registry     │
               └──────────────────────────────┬──────────────────────────────────────┘
                                              │ route by workspace → shard
        ┌─────────────────────┬───────────────┴──────┬──────────────────────┐
  ┌─────▼──────┐        ┌─────▼──────┐         ┌──────▼─────┐          ┌──────▼─────┐
  │ Shard 01   │        │ Shard 02   │   …     │ Shard N    │          │ Dedicated  │
  │ schema data│        │ schema data│         │ schema data│          │ shard (Ent)│
  │ many wsps  │        │ many wsps  │         │ many wsps  │          │ one org    │
  └────────────┘        └────────────┘         └────────────┘          └────────────┘
```

* **Control plane** (`core` schema, one Postgres cluster + read replicas): who you are, what you belong to, what you may access, what you pay, and *where your data lives*.
* **Data plane shards** (`data` schema, many Postgres clusters): base content — schema metadata, records, links, views, interfaces, automations, comments, attachments metadata, change log, outbox. Every row carries `workspace_id`; RLS keyed on `SET LOCAL app.workspace_id` is defense-in-depth (D4).
* **Shard unit = workspace** (D3). All bases of a workspace, plus its contact directory, share a shard, so cross-base contact links and base duplication within a workspace stay local. Workspaces can be moved online (`workspace_directory.status = 'migrating'`).
* **Cell** = a shard plus its co-located `relay`, PgBouncer pool and (for dedicated/Enterprise cells) pinned worker and realtime pools. Detail in [`03`](./03-system-architecture.md#9-cell-architecture) and [`04`](./04-database-architecture.md).
* **Audit store** is a separate Postgres (`audit` schema) with S3 Parquet archive, so audit volume never competes with product writes.

### 1.6 Hybrid record storage

One physical `data.records` table (hash-partitioned by `table_id`) holds every user record of every table on the shard:

```jsonc
// data.records row (illustrative)
{
  "id": "0192f1c4-…",             // UUIDv7; public id rec_5Xk…
  "table_id": "0192f0aa-…",
  "workspace_id": "0192ef01-…",
  "row_number": 1042,              // autonumber
  "cells":    { "1": "Acme Corp", "3": "opt_7hQ…", "4": "1200.00", "9": ["att_…"] },
  "computed": { "6": 1452.0, "7": ["Jane Doe", "Raj Patel"], "11": 3 },
  "cell_meta":{ "1": { "seq": 18230, "by": "usr_…", "at": "2026-10-03T14:05:00Z" } },
  "version": 57,
  "created_at": "…", "created_by": "…", "updated_at": "…", "updated_by": "…",
  "deleted_at": null, "deletion_batch_id": null
}
```

* **Canonical user values** in `cells` keyed by **field slot** (never reused), so renaming a field is free and deleting a field is a metadata flag (values remain until purge → instant restore).
* **Computed values** (formula, lookup, rollup, count, AI) in `computed`, maintained by the Compute Engine (D7).
* **Links** normalized in `record_links` (one row per pair, both directions served by one row) so that inverse links, counts and lookups are index-backed, and link integrity is relational.
* **Typed index sidecars** (`record_index_num|text|time`) materialize *selected* field values into narrow typed tables with B-tree indexes once a table exceeds `INDEX_SIDECAR_THRESHOLD` (20,000 rows) and a field is used in a sort/filter of a saved view.

Alternatives considered (full analysis in [`06`](./06-record-storage.md) and ADRs in [`33`](./33-architecture-decision-records.md)): EAV (one row per cell — write/read amplification, painful queries), dynamic DDL per user table (fast queries but migrations, catalog bloat, lock storms, type changes = table rewrites), document store (weak relational integrity for links). Hybrid wins on the combination of O(1) schema evolution, single-row record reads, and relational links.

### 1.7 Server-authoritative realtime

* Clients send **operations** (`setCell`, `addLinks`, `removeLinks`, `addToSet`, `removeFromSet`, `createRecords`, `deleteRecords`, `moveRecord`, schema ops). The server validates, applies in a transaction, assigns the next `base_runtime.change_seq`, writes a `base_changes` row (forward ops + inverse ops) and commits.
* All clients subscribed to the base receive the committed change in **seq order**. The originating client reconciles its optimistic state by `clientOpId`.
* Conflict policy: **cell-level last-writer-wins** (by commit order), **set semantics** for links/multi-select/multi-collaborator (concurrent add + add both survive; add + remove of the same element resolves by commit order). `If-Match` on record version for API clients that want strict compare-and-set.
* **Gap-free catch-up:** a client that reconnects asks for `seq > lastSeen`; if within `BASE_CHANGES_RETENTION` and below a size threshold it receives the delta, otherwise it reloads the affected views.
* No CRDT/OT for structured cells; Yjs only for collaborative rich long text (V1+). Rationale and protocol in [`16`](./16-realtime.md).

### 1.8 Outbox + event log

```
API tx ──► data.records / record_links / … (current state)
       ├─► data.base_changes   (per-base ordered ops: realtime, undo, webhooks cursors, sync)
       └─► data.outbox_events  (domain events: record.updated, field.created, …)
                  │  same commit
                  ▼
     relay (logical replication slot per shard; commit-ordered; gap-free)
                  ▼
     Kafka API: tabula.base-changes.v1 · tabula.domain-events.v1 · tabula.audit.v1 · tabula.usage.v1
                  ▼
     consumers: realtime fan-out · automation trigger matcher · webhook dispatcher · search indexer ·
                notification router · audit writer · usage meter · AI field runner · contact timeline
```

Why: no dual writes (an event exists iff the transaction committed), per-base ordering for free, replay from Kafka retention for new consumers or bug-fix reprocessing, and a clean seam for extracting services later. MVP profile replaces Kafka with direct BullMQ dispatch behind the same `EventBus` interface (D11). Detail in [`15`](./15-events.md).

### 1.9 Scope by release: MVP / V1 / Enterprise

Full roadmap in [`29`](./29-roadmap-and-scope.md). Summary:

| Area | MVP (first paying customers) | V1 (competitive parity) | Enterprise / V2 |
|---|---|---|---|
| Tenancy | Orgs, workspaces, bases, invites, roles | Teams, guests, base-level grants, interface-only access | Multiple workspaces policies, dedicated shards, data residency (EU) |
| Fields | All cell types except `ai_generated`, `barcode`; link, lookup, rollup, count, formula, autonumber, system fields | `ai_generated`, `barcode`, `button`, rich text with Yjs, `contact` | Field-level hide (row/field security) |
| Views | Grid, form, kanban, gallery, calendar | Timeline, list, locked & personal views, view sections | Row policies |
| Interfaces | — (V1) | Interface builder: pages, elements, publish versions, interface-only users | Custom branding, external portals |
| Automations | Record triggers, schedule, send email, create/update record, webhook out | Scripts (sandbox), inbound webhooks, conditional branches, repeating groups, AI steps | Org-wide automation governance, higher run quotas |
| API | REST v1, PATs, outbound webhooks | OAuth 2.1 apps, service accounts | Admin API, audit API |
| Data movement | CSV import, CSV export | XLSX import, sync sources (other bases, external), snapshots | Scheduled exports to customer S3 |
| Search | Postgres FTS | OpenSearch | Org-wide admin search |
| History | Record revisions, undo/redo, trash | Base snapshots + restore | Extended retention (configurable) |
| AI | — | AI field, formula assist, summarize, base-from-prompt | Per-org AI policy, BYO model key, agent steps |
| Security | Password + TOTP, Google/Microsoft OAuth login | WebAuthn, audit log (admin) | SAML/OIDC SSO, SCIM, IP allowlist, SIEM export, KMS per tenant |
| Billing | Stripe subscriptions, seat counting, plan limits | Usage metering (automation runs, AI credits) | Contracted plans, invoicing |

### 1.10 Top risks and how the architecture contains them

| Risk | Containment |
|---|---|
| Hub records (one record linked to 100k others) cause compute write storms | Fan-out > `COMPUTE_SYNC_FANOUT_LIMIT` deferred to `compute` queue; per-table compute budget; coalescing of stale markers |
| Large tables with JSONB-expression sort/filter are slow | Sidecar indexes above threshold; query planner chooses sidecar joins; per-view row cap warnings |
| Automation loops (A updates → triggers B → updates A) | `causationDepth` ≤ `MAX_CAUSATION_DEPTH` (8); per-automation hourly budgets (`ratebudget:automation:*`); `automation.disabled_by_system` |
| Permission leaks via derived data (lookups, search, webhooks, realtime) | All fan-outs filter through the same compiled `PermissionSnapshot`; field restrictions applied at serialization |
| Noisy tenant on shared shard | Workspace move tooling; dedicated shards; per-base rate limits (spine §8) |
| Logical replication slot lag fills WAL | Slot lag alarms, relay HA with lease, max WAL size guard + forced re-snapshot runbook |

Full risk register: [`34`](./34-self-review-risk-register-build-order.md).

### 1.11 Document map

| # | Document | Owns |
|---|---|---|
| 00 | [Canonical decisions](./00-canonical-decisions.md) | Names, IDs, tables, events, constants |
| 02 | [Domain model & ERD](./02-domain-model-and-erd.md) | Entities, aggregates, ERDs |
| 03 | [System architecture](./03-system-architecture.md) | Planes, roles, paths, routing, cells |
| 04–06 | [DB architecture](./04-database-architecture.md), [SQL schema](./05-sql-schema.md), [Record storage](./06-record-storage.md) | Physical data design |
| 07–11 | Field, formula, link, view, filter/sort/group engines | Core engines |
| 12–14 | Contacts, interface builder, automations | Product subsystems |
| 15–16 | Events, realtime | Async + live |
| 17, 31 | API architecture & specification | Public surface |
| 18–23 | Search/files/collab, permissions, import/export/sharing, AI, history, notifications/jobs/caching | Platform services |
| 24–28 | Frontend, security/infra, stack/repo, data flows, testing | Delivery |
| 29–34 | Roadmap, diagrams, inventory, ADRs, self-review | Governance |

---

## 2. Product capability map

### 2.0 How to read the capability tables

Every major feature gets a subsection with a short **[Observed]** capability statement (what the category of product does publicly), an **[Ours]** one-line design stance, and a 16-row table answering the same conceptual questions:

| # | Question | Meaning |
|---|---|---|
| Q1 | **User sees** | Visible UI/behavior |
| Q2 | **Object** | Domain object(s) / aggregate (names from [`02`](./02-domain-model-and-erd.md)) |
| Q3 | **DB entity** | Spine tables (`core.*`, `data.*`, `audit.*`) |
| Q4 | **Relationships** | Key relationships to other objects |
| Q5 | **API ops** | Public/first-party REST operations (indicative; normative in [`31`](./31-api-specification.md)) |
| Q6 | **Frontend state** | Where the client keeps it: TanStack Query key (`TQ`), `RecordStore`, Zustand store (`UI`), local (`LS`) |
| Q7 | **Backend services** | Modules / process roles / queues involved |
| Q8 | **Events** | Domain events (spine §6) |
| Q9 | **Permissions** | Actions (spine §9) and restriction overlays |
| Q10 | **Cached** | What is cached where (spine §10 Redis keys, CDN, client) |
| Q11 | **Persisted** | What is durable and where |
| Q12 | **On delete** | Behavior when the object is deleted |
| Q13 | **On restore** | Behavior when restored from trash/snapshot |
| Q14 | **Concurrent edits** | Conflict semantics |
| Q15 | **Automation dependency** | How automations trigger on / act on it |
| Q16 | **Referenced by** | What else points at it (and must handle its deletion) |

**Backend module vocabulary** used in Q7 follows the module directories defined in [`26`](./26-architecture-style-stack-repo-services.md#472-tree): `organization`, `auth`, `billing`, `workspace`, `access`, `base`, `schema`, `records`, `recordstore`, `links`, `compute`, `formula`, `query`, `views`, `history`, `attachments`, `ai`, `contacts`, `comments`, `interfaces`, `share`, `automation`, `integration`, `webhook`, `notification`, `search`, `audit`, `import-export`, `realtime`, plus the shared `kernel` (transactions, change log, outbox, shard router, long operations). Module map and dependency direction: [`03`](./03-system-architecture.md#4-module-map). Process roles: `api`, `realtime`, `worker`, `scheduler`, `relay`, `sandbox`. Queues are named as in spine §7.

**Frontend state vocabulary:** `TQ['bases', baseId, 'schema']` etc. are TanStack Query keys; `RecordStore` is the normalized record cache fed by REST windows + realtime ops (see [`24`](./24-frontend-grid-state-design-system.md)); `UI.*` are Zustand slices.

---

### 2.1 Tenancy & identity

#### 2.1.1 Organization

[Observed] Paid tenants have an account/org layer for billing, admin, user management and policies. [Ours] `organization` is the tenant root in the control plane; every workspace belongs to exactly one org (free users get an implicit personal org).

| # | Answer |
|---|---|
| Q1 | Org admin console: members, teams, workspaces, billing, SSO/SCIM, policies, audit log. Regular members mostly see the org name/logo in the switcher. |
| Q2 | `Organization` aggregate (root) with `OrganizationMember`, `OrganizationDomain`, `OrganizationPolicy`. |
| Q3 | `core.organizations`, `core.organization_members`, `core.organization_domains`, `core.organization_policies`; billing in `core.subscriptions`. |
| Q4 | 1 org → N workspaces, teams, service accounts, SSO connections, SCIM directories, subscription; N users via membership. |
| Q5 | `GET/PATCH /v1/orgs/{orgId}`, `GET/POST/PATCH/DELETE /v1/orgs/{orgId}/members[/{userId}]`, `POST /v1/orgs/{orgId}/domains:verify`, `GET/PUT /v1/orgs/{orgId}/policies`. |
| Q6 | `TQ['orgs']`, `TQ['orgs', orgId]`, `TQ['orgs', orgId, 'members']`; `UI.session.activeOrgId`. |
| Q7 | `organization`, `workspace`, `access`, `billing`, `organization`, `audit`; role `api`; queues `email` (invites), `maintenance`. |
| Q8 | `organization.created`, `organization.updated`, `member.added`, `member.role_changed`, `member.removed`, `grant.changed`. |
| Q9 | `org.manage` (owner/admin), `org.billing` (owner/billing_admin). Guests have no org-level visibility. |
| Q10 | Org policy subset embedded in every `perm:{principalId}:{baseId}:{permEpoch}` snapshot; session record in `sess:{tokenHash}` carries org memberships. |
| Q11 | Control-plane Postgres; audit trail in `audit.audit_events`. |
| Q12 | Org deletion is an admin-only, **scheduled** operation: org → `pending_deletion` (30 days, all access disabled, billing cancelled), then workspaces purged shard by shard via `long_operations`, then identity rows anonymized. |
| Q13 | Within the 30-day window an org owner (or support with `support_access_grants`) can cancel deletion; status returns to `active`; nothing was physically removed yet. |
| Q14 | Settings: row-level `version` with `If-Match`; member role changes are idempotent upserts; last commit wins with audit. |
| Q15 | Automations cannot modify orgs. Org policies constrain automations (e.g., disallow external webhooks, AI policy). |
| Q16 | Workspaces, teams, service accounts, API tokens, SSO/SCIM, subscriptions, usage, audit events, `shards.dedicated_org_id`. |

#### 2.1.2 Workspace

[Observed] A workspace groups bases and collaborators; plan and limits often apply at this level. [Ours] Workspace is the **shard affinity unit** and the owner of the contact directory.

| # | Answer |
|---|---|
| Q1 | Home screen section listing bases (and interfaces); workspace settings (members, sharing policy, trash, contact directory). |
| Q2 | `Workspace` aggregate (control-plane root for routing and membership; data-plane content lives in bases). |
| Q3 | `core.workspaces`, `core.workspace_directory` (routing), `core.access_grants` (resource_type=`workspace`). |
| Q4 | Belongs to org; contains bases (`core.base_directory` / `data.bases`), one contact directory base; grants to users/teams. |
| Q5 | `GET/POST /v1/orgs/{orgId}/workspaces`, `GET/PATCH/DELETE /v1/workspaces/{workspaceId}`, `POST /v1/workspaces/{workspaceId}:restore`, `GET/PUT /v1/workspaces/{workspaceId}/collaborators`. |
| Q6 | `TQ['workspaces']` (sidebar/home), `TQ['workspaces', wsId, 'collaborators']`. |
| Q7 | `organization`, `workspace`, `kernel` (shard placement on create), `access`, `history` (trash), `contacts` (directory bootstrap). |
| Q8 | `workspace.created`, `workspace.updated`, `workspace.deleted`, `workspace.restored`, `grant.changed`. |
| Q9 | `workspace.manage` (owner), `workspace.create_base` (owner/creator). Roles: owner > creator > editor > commenter > viewer. |
| Q10 | `workspace_directory` row cached in-process (LRU 30 s) and in Redis (300 s) with pub/sub invalidation (see [`04` §6.4](./04-database-architecture.md#64-routing)); grants folded into perm snapshots. |
| Q11 | Control plane rows; base content on the shard from `workspace_directory.shard_id`. |
| Q12 | Soft delete (`deleted_at`); all its bases become inaccessible immediately; trash retention 30 days (Enterprise up to 180). Purge job deletes base data on the shard, then directory rows. |
| Q13 | Clears `deleted_at`; bases reappear with grants intact (grants were never removed, only masked). |
| Q14 | Metadata LWW with `version`; grant edits are row upserts keyed by (resource, principal). |
| Q15 | None directly; workspace-scoped secrets/connections are used by automations of its bases. |
| Q16 | Bases, contact directory, integration connections, secrets, invitations, grants, shard routing. |

#### 2.1.3 Team (user groups)

[Observed] Enterprise plans support user groups for sharing. [Ours] `team` is a principal type in `access_grants`; SCIM-managed teams are read-only in UI.

| # | Answer |
|---|---|
| Q1 | Admin: team list and membership. Share dialogs: teams as share targets; `@team` mentions. |
| Q2 | `Team` (child of Organization aggregate, but its own consistency boundary for membership). |
| Q3 | `core.teams`, `core.team_members`, `core.scim_group_mappings`. |
| Q4 | Org 1→N teams; team N↔N users; team is a principal in `access_grants`. |
| Q5 | `GET/POST /v1/orgs/{orgId}/teams`, `PATCH/DELETE /v1/teams/{teamId}`, `PUT/DELETE /v1/teams/{teamId}/members/{userId}`. |
| Q6 | `TQ['orgs', orgId, 'teams']`. |
| Q7 | `organization`, `workspace`, `access`, `auth` (SCIM). |
| Q8 | `team.updated`, `grant.changed`. |
| Q9 | `org.manage`; SCIM-sourced teams editable only via SCIM. |
| Q10 | Team membership expanded into perm snapshots; membership change bumps `perm_epoch` on every base where the team has a grant (fan-out job on `maintenance`). |
| Q11 | Control plane. |
| Q12 | Hard delete after confirmation; its grants are removed (bumps `perm_epoch`), mentions render as "deleted team". |
| Q13 | Not restorable (re-create); audit log keeps history. |
| Q14 | Membership is set semantics (add/remove idempotent). |
| Q15 | Automations can notify a team (resolved to members at send time). |
| Q16 | `access_grants`, `mentions`, notification targets, SCIM mappings. |

---

### 2.2 Schema

#### 2.2.1 Base

[Observed] A base is a self-contained relational app: tables, views, interfaces, automations, collaborators. [Ours] A base lives entirely on one shard; `base_runtime` holds hot counters (`change_seq`, `perm_epoch`, `schema_version`).

| # | Answer |
|---|---|
| Q1 | Base page: table tabs, view sidebar, grid; base menu (duplicate, snapshot, trash, share, settings, API docs). |
| Q2 | `Base` aggregate root for **schema** (tables, fields, link relations, views, interfaces, automations are entities within its consistency boundary). |
| Q3 | `data.bases`, `data.base_runtime`; routing in `core.base_directory`; grants in `core.access_grants` (resource_type=`base`). |
| Q4 | Workspace 1→N bases; base 1→N tables, views, interfaces, automations, share links, snapshots, webhooks. |
| Q5 | `POST /v1/workspaces/{wsId}/bases` (empty / from template / from import / from AI prompt), `GET/PATCH/DELETE /v1/bases/{baseId}`, `GET /v1/bases/{baseId}/schema`, `POST /v1/bases/{baseId}:duplicate`, `POST /v1/bases/{baseId}:restore`. |
| Q6 | `TQ['bases', baseId, 'schema']` (tables, fields, views — one payload keyed by `schemaVersion`), `UI.base.activeTableId/activeViewId`, realtime subscription state. |
| Q7 | `schema`, `kernel`, `access`, `history`, `base`, `realtime`; long ops (duplicate) on `snapshot` queue. |
| Q8 | `base.created`, `base.updated`, `base.deleted`, `base.restored`, `base.duplicated`. |
| Q9 | `base.read`, `base.manage_schema` (creator), `base.manage_members`, `base.share`; `interface_only` role sees no base UI. |
| Q10 | Schema snapshot `schema:{baseId}:{schemaVersion}` (immutable per version); `base_directory` route cache (in-process + Redis); perm snapshot per principal. |
| Q11 | Shard Postgres (metadata + content); snapshots in `tabula-snapshots`. |
| Q12 | Soft delete: `bases.deleted_at` + `deletion_batches` entry; `base_directory.status='trashed'`; webhooks paused, automations stop matching, share links stop resolving. Purge after `TRASH_RETENTION`. |
| Q13 | Restore clears flags; automations return to their prior on/off state; webhooks resume from their cursor if within `BASE_CHANGES_RETENTION`, otherwise marked `expired` and must be re-created. |
| Q14 | Base settings LWW; schema changes serialized by the `base_runtime` row lock (`schema_version`++). |
| Q15 | Container of automations; no user-facing trigger on the base itself. |
| Q16 | Grants, invitations, share links, API token resource restrictions, OAuth grant scopes, sync sources (as source/target), templates (when published from a base), search index. |

#### 2.2.2 Table

[Observed] Tables have a primary field, many typed fields, and records. [Ours] A table is metadata only; its records live in the shared `data.records` partition set.

| # | Answer |
|---|---|
| Q1 | Table tab; create/rename/duplicate/delete; table description; record count. |
| Q2 | `Table` (entity in Base aggregate). |
| Q3 | `data.tables` (`primary_field_id`, `next_field_slot`, `next_row_number`, `record_count`, `restrictions`). |
| Q4 | Base 1→N tables; table 1→N fields, records, views; participates in `link_relations` on either side. |
| Q5 | `POST /v1/bases/{baseId}/tables`, `PATCH/DELETE /v1/bases/{baseId}/tables/{tableId}`, `POST …/tables/{tableId}:duplicate`, `POST …/tables/{tableId}:restore`. |
| Q6 | Part of `TQ['bases', baseId, 'schema']`; `UI.base.tableOrder`. |
| Q7 | `schema`, `links` (when deleting: inverse fields), `compute` (graph rebuild), `views`, `history`. |
| Q8 | `table.created`, `table.updated`, `table.deleted`, `table.restored`. |
| Q9 | `table.create`, `table.update`, `table.delete` (base creator); `tables.restrictions` limit who can create/delete records. |
| Q10 | Inside schema snapshot. |
| Q11 | `data.tables`; `record_count` approximate (delta-updated in the write tx, reconciled nightly). |
| Q12 | Soft delete with a `deletion_batch`; link fields in *other* tables that target it are soft-deleted in the same batch; records remain physically until purge. |
| Q13 | Restore batch: table + its inverse link fields + views reappear; computed fields depending on them re-validated and recomputed (`compute` queue if large). |
| Q14 | Rename/description LWW; structural changes serialized via `schema_version`. |
| Q15 | Triggers are table-scoped ("when record created in table X"); automations referencing a deleted table are marked `config_error`. |
| Q16 | Fields (link targets), views, interface elements, automations (trigger/action configs), sync targets, webhook specs, import jobs, AI templates. |

#### 2.2.3 Field

[Observed] Fields are typed columns with type-specific options; type can be changed with best-effort conversion. [Ours] Each type is a `FieldTypeDefinition` plugin (spine §4); values are stored by **slot**; type conversion is a long operation writing into a new slot ("shadow-slot conversion", see [`30`](./30-architecture-diagrams.md#13-field-type-change-flow) and [`07`](./07-field-engine.md)).

| # | Answer |
|---|---|
| Q1 | Column header, field editor dialog (type, options, description, default), hide/reorder per view, field-level permissions. |
| Q2 | `Field` (entity in Base aggregate) + its `FieldTypeDefinition`; computed fields add `FieldDependency` edges. |
| Q3 | `data.fields` (`slot`, `type`, `config`, `restrictions`, `order_key`, `deleted_at`), `data.field_dependencies`, `data.link_relations` (link/contact). |
| Q4 | Table 1→N fields; formula/lookup/rollup depend on other fields (possibly through links); views reference fields in filters/sorts/visibility. |
| Q5 | `POST /v1/bases/{baseId}/tables/{tableId}/fields`, `PATCH …/fields/{fieldId}` (name/description/options), `PATCH …/fields/{fieldId}` with a new `type` (preflight returns a lossy-conversion preview; large tables return `202` + `lop_` long operation, see [`06` §15](./06-record-storage.md)), `DELETE …/fields/{fieldId}`, `POST …/fields/{fieldId}:restore`. |
| Q6 | Schema snapshot (`TQ['bases', baseId, 'schema']`); grid column model derived per view; client-side `@tabula/formula` validates formula text as the user types. |
| Q7 | `schema`, `compute` (dependency graph, recompute), `links`, `query` (sidecar enablement), `history`; queues `compute`, `maintenance` (conversion batches). |
| Q8 | `field.created`, `field.updated`, `field.type_changed`, `field.deleted`, `field.restored`, `link_relation.created/deleted`. |
| Q9 | `field.create/update/delete` (base creator); `fields.restrictions` restrict who may edit values (Enterprise: hide). |
| Q10 | Schema snapshot; compiled formula closures cached in-process by `(fieldId, schemaVersion)`. |
| Q11 | `data.fields`; values in `records.cells`/`records.computed` under the slot. |
| Q12 | Soft delete: field hidden, values left under the slot; dependents become `config.error="REF_DELETED"` and show `#ERROR`; link field deletion soft-deletes the inverse field too. Purge job strips the slot key from cells in batches after retention. |
| Q13 | Restore flag; dependents re-validated; values were never removed so restore is O(1) for user fields; computed fields recomputed (sync if small, else `compute`). |
| Q14 | Config edits LWW at field granularity, guarded by `schema_version`; a type conversion holds a `long_operations` lock: other config edits to that field are rejected with `FIELD_CONVERSION_IN_PROGRESS`. |
| Q15 | Triggers watch fields ("when field X changes"); actions write fields; deleting a watched field marks the automation `config_error`. |
| Q16 | Views (filters, sorts, groups, visibility), formulas/lookups/rollups, interface elements, automation configs, webhook specs (`watchFields`), sync mappings, import mappings, AI prompts, sidecar indexes, search document config. |

---

### 2.3 Data

#### 2.3.1 Record

[Observed] Records are rows; users edit cells inline, expand a record, comment, and see history. [Ours] One `data.records` row per record; all writes through `RecordCommandService`.

| # | Answer |
|---|---|
| Q1 | Grid rows, expanded record modal, cards in other views, record pages in interfaces. |
| Q2 | `Record` aggregate root for **cell values** (cells + computed + cell_meta; links are owned jointly with the `LinkRelation`). |
| Q3 | `data.records` (hash-partitioned by `table_id`), `data.record_revisions`, `data.record_index_*`, `data.base_changes`, `data.outbox_events`. |
| Q4 | Belongs to table; linked to other records via `record_links`; has comments, attachments, revisions, subscriptions. |
| Q5 | `GET …/records/{recordId}`, `GET …/records` (list, optionally `viewId`), `POST …/records:query`, `POST …/records:batch` (create/update/upsert/delete ≤ 1000), `PATCH …/records/{recordId}`, `DELETE …/records/{recordId}`, `POST …/records:restore`. Realtime ops `setCell`, `createRecords`, `deleteRecords`. |
| Q6 | `RecordStore` (normalized by record id, per-view row-id windows, optimistic overlays keyed by `clientOpId`). |
| Q7 | `records`, `compute`, `links`, `access`, `history`, `realtime`, `search` (index), `automation` (triggers); role `api` (sync path), `relay` → consumers. |
| Q8 | `record.created`, `record.updated`, `record.deleted`, `record.restored`, `records.bulk_changed`, `record.links_changed`, `record.computed_updated`, `record.assigned`. |
| Q9 | `record.read/create/update/delete`; `tables.restrictions` (create/delete), `fields.restrictions` (edit/hide), Enterprise `row_policies`; interface element permissions narrow further. |
| Q10 | Not cached server-side (Postgres buffer cache is the cache); client caches windows in `RecordStore`. |
| Q11 | `records` row (current), `record_revisions` (history), `base_changes` (30-day ops log). |
| Q12 | Soft delete (`deleted_at`, `deletion_batch_id`); its `record_links` rows are removed and captured in the deletion batch so counterparts' lookups/rollups update; comments remain attached but hidden. |
| Q13 | Clear flags; re-insert captured links whose counterpart still exists; recompute affected computed fields; emit `record.restored`. |
| Q14 | Cell-level LWW by commit order; set-ops for multi-valued; optional `If-Match: "<version>"` for API compare-and-set. |
| Q15 | Primary trigger source: created / updated (field watch) / matches conditions / enters view; actions create/update/delete records. Causation depth tracked. |
| Q16 | Links, comments, mentions (`record` mentions), attachments, revisions, subscriptions, notifications, automation runs (trigger record), AI invocations, search documents. |

#### 2.3.2 Link (link-to-another-record)

[Observed] Link fields connect records across tables bidirectionally; the other table gets an inverse field. [Ours] A `link_relation` row defines both sides; pairs live once in `record_links`.

| # | Answer |
|---|---|
| Q1 | Link cell chips; record picker with search; inverse field in the target table; "allow multiple" toggle. |
| Q2 | `LinkRelation` (entity in Base aggregate) + `RecordLink` pairs (value objects). |
| Q3 | `data.link_relations` (side A table/field ↔ side B table/field, cardinality), `data.record_links` (relation_id, a_record_id, b_record_id, a_order, b_order) partitioned by `relation_id`. |
| Q4 | Two `fields` (type `link`, `config.linkRelationId`, `config.inverseFieldId`); self-links allowed (A = B table); contact fields link to the contact directory table. |
| Q5 | Field create/update/delete as 2.2.3; cell writes via record endpoints (`{"fld_…": ["rec_…", …]}` replace) or `POST …/records/{recordId}/links/{fieldId}:add` / `:remove` (set ops). Candidate search `GET …/fields/{fieldId}/link-candidates?q=`. |
| Q6 | Link chips rendered from `RecordStore` primary-field display cache; candidate picker uses `TQ['linkCandidates', fieldId, q]`. |
| Q7 | `links`, `compute` (lookups/rollups/counts via link), `records`, `access`. |
| Q8 | `link_relation.created`, `link_relation.deleted`, `record.links_changed` (both sides), plus `record.computed_updated` for computed fan-out. |
| Q9 | Editing a link requires `record.update` on the edited side; the inverse side updates implicitly (no separate check on the inverse field's restrictions — documented). Visibility of target display values follows [`19`](./19-permissions-and-multitenancy.md). |
| Q10 | Primary-field display values of linked records are joined at read time with a per-request cache; not denormalized into `cells`. |
| Q11 | `record_links`; order keys are fractional strings per side. |
| Q12 | Field delete → relation soft-deleted, pairs retained for the restore window; record delete → pairs captured in the deletion batch. Converting to single cardinality keeps the first link by order and archives the rest in the long-operation result (undoable). |
| Q13 | Relation restore reactivates pairs; record restore re-inserts captured pairs if the counterpart is live. |
| Q14 | Add/remove commute (set semantics); concurrent "replace all" vs "add" resolve by commit order; order changes LWW per pair. |
| Q15 | "Linked records changed" is a field change on both records; actions can link/unlink. Fan-out of computed updates counts toward the causation chain. |
| Q16 | Lookup, rollup, count fields; filters "has any of"; interface linked-record elements; sync mappings. |

#### 2.3.3 Lookup

[Observed] A lookup field shows a field's values from linked records. [Ours] Materialized in `records.computed` as an array, maintained through the dependency graph.

| # | Answer |
|---|---|
| Q1 | Read-only cell showing values from linked records (formatted per source type). |
| Q2 | `Field` with type `lookup`, `config {linkFieldId, targetFieldId, filter?, sort?, limit?}`. |
| Q3 | `data.fields`, `data.field_dependencies` (lookup → link field, lookup → target field via link), `records.computed[slot]`. |
| Q4 | Depends on a link field in the same table and a field in the target table (which may itself be computed — chain depth ≤ `MAX_DEPENDENCY_CHAIN`). |
| Q5 | Field CRUD; values readable via record endpoints; not writable (`FIELD_COMPUTED_READ_ONLY`). |
| Q6 | Values in `RecordStore` like any cell; stale marker renders "calculating…". |
| Q7 | `compute` (propagation), `links`, queue `compute` for deferred fan-out. |
| Q8 | `record.computed_updated` (batched); `field.*` for config. |
| Q9 | Read requires access to the lookup field; target values are visible to anyone who can read the lookup field (lookups *project* data — documented; restrict the lookup field if needed). |
| Q10 | Materialized (that is the cache); stale state in `computed_stale`. |
| Q11 | `records.computed`. |
| Q12 | Deleting the source link or target field → lookup shows `#ERROR` (`REF_DELETED`). |
| Q13 | Restoring the dependency re-validates and recomputes. |
| Q14 | Not user-editable; recompute is idempotent and tagged with the seq of the change that caused it; a recompute never overwrites a value computed for a later seq. |
| Q15 | Can be a trigger watch field ("when lookup value changes") — fires on `record.computed_updated`. |
| Q16 | Formulas, rollups, filters/sorts, interface elements. |

#### 2.3.4 Rollup & Count

[Observed] Rollups aggregate linked values (sum, min, max, concatenate, unique…); count counts links. [Ours] `rollup` = aggregation function over an optional per-item formula; `count` = link count with optional condition.

| # | Answer |
|---|---|
| Q1 | Read-only aggregated cell (number, date, text, array). |
| Q2 | `Field` types `rollup` (`config {linkFieldId, targetFieldId, aggregate, itemFormula?, filter?}`) and `count` (`config {linkFieldId, filter?}`). |
| Q3 | Same as lookup; values in `records.computed`. |
| Q4 | Depends on link + target field; can feed formulas. |
| Q5 | Field CRUD; read via record endpoints. |
| Q6 | `RecordStore`; aggregate preview in field editor computed client-side for a visible sample. |
| Q7 | `compute`; incremental strategies for `count`/`sum` (delta updates) vs full re-aggregate for `min/max/unique/concat` — see [`09`](./09-linked-record-engine.md). |
| Q8 | `record.computed_updated`. |
| Q9 | As lookup. |
| Q10 | Materialized. |
| Q11 | `records.computed`. |
| Q12 | `#ERROR` on dependency deletion. |
| Q13 | Recompute. |
| Q14 | Delta updates are applied inside the same tx as the triggering link/value change when fan-out ≤ limit, so there is no lost update; deferred recomputes re-aggregate from scratch. |
| Q15 | Watchable; common in "when total exceeds X" conditions. |
| Q16 | Formulas, filters, kanban/summary bars, interface number/chart elements. |

#### 2.3.5 Formula

[Observed] Spreadsheet-style formulas reference fields by name and produce typed values; errors show as error values. [Ours] Own grammar and function catalog (D8); fields referenced internally by field ID (`{fld_…}`), displayed by name.

| # | Answer |
|---|---|
| Q1 | Formula editor with autocomplete, inline type/errors, result preview; read-only cell. |
| Q2 | `Field` type `formula` with `config {expression, ast, resultType, engineVersion, format}`; `FormulaAst` (value object). |
| Q3 | `data.fields.config`, `data.field_dependencies`, `records.computed`, `computed_stale`. |
| Q4 | Depends on same-record fields (and, through lookups/rollups, on other records). |
| Q5 | Field CRUD; `POST /v1/bases/{baseId}/formula:validate` (server check for API clients); values via record endpoints. |
| Q6 | `@tabula/formula` in client: parse/type-check on each keystroke; optimistic recompute of same-record formulas when the user edits a cell. |
| Q7 | `compute` (sync same-record recompute in the write tx; volatile buckets via `scheduler`); `ai` (formula assistant). |
| Q8 | `field.created/updated`, `record.computed_updated`. |
| Q9 | `field.create/update`; reading as any field. |
| Q10 | Compiled closures per `(fieldId, schemaVersion)` in-process LRU; values materialized. |
| Q11 | Expression text + normalized AST (field IDs) in `fields.config`. |
| Q12 | Deleting the formula: dependents error. Deleting a referenced field: formula keeps `{fld_…}` and shows `#ERROR`. |
| Q13 | Restoring the referenced field heals the formula automatically. |
| Q14 | Config LWW; value is computed (no user conflicts). |
| Q15 | Watchable; `NOW()`/`TODAY()`-dependent formulas are recomputed per bucket and emit `record.computed_updated` (rate-limited) so time-based conditions can trigger. |
| Q16 | Other formulas, rollup item formulas, filters/sorts/groups, conditional colors, automation conditions. |

#### 2.3.6 Attachments

[Observed] Attachment cells hold multiple files with thumbnails and previews. [Ours] Presigned direct-to-S3 upload into quarantine → scan → promote; cells store attachment UUIDs (D15).

| # | Answer |
|---|---|
| Q1 | Thumbnails in cells, upload by drag-drop/paste/URL, preview carousel, download. |
| Q2 | `Attachment` aggregate (root) with `AttachmentVariant`s; referenced by record cells. |
| Q3 | `data.attachments` (object key, mime, size, checksum, scan status, dims), `data.attachment_variants`; S3 `tabula-uploads-quarantine` → `tabula-attachments`, `tabula-attachment-variants`. |
| Q4 | Belongs to base (and to the record/field where first attached); one attachment may be referenced by several cells after copy/duplicate (reachability checked by the orphan sweep). |
| Q5 | `POST /v1/bases/{baseId}/attachments:initiate` (presigned multipart URLs), `POST /v1/attachments/{attachmentId}:complete`, `GET /v1/attachments/{attachmentId}` (metadata + signed URLs), `POST /v1/bases/{baseId}/attachments:fromUrl`. Cell write `{"fld_…": ["att_…"]}`. |
| Q6 | Upload manager store (`UI.uploads`, per-file progress, resumable parts); attachment metadata embedded in record payloads. |
| Q7 | `attachments`; queues `file-scan` (ClamAV), `file-process` (libvips, ffmpeg, PDF preview); CloudFront signed URLs. |
| Q8 | `attachment.uploaded`, `attachment.scanned`, `attachment.processed`, `attachment.rejected`; record events for the cell. |
| Q9 | Upload requires `record.update` on the target field (or a form submit token); download requires `record.read` of a record referencing it — signed URL TTL 1 h, issued only after the check. |
| Q10 | CDN caches variants by signed URL; metadata not cached server-side. |
| Q11 | Metadata in shard; bytes in S3 (SSE-KMS). |
| Q12 | Removing from a cell does not delete the object (undo/history may reference it). Orphan sweep (`purge` queue) deletes attachments not referenced by any live cell, revision within retention, trashed record, or snapshot. |
| Q13 | Record/field restore re-references the same attachment IDs; objects still exist because the sweep honors retention. |
| Q14 | Attachment arrays are set-semantic (`addToSet`/`removeFromSet`) plus order; reorder is LWW. |
| Q15 | Triggers on attachment field change; actions can attach from URL or from a previous step's file. |
| Q16 | Record cells, revisions, snapshots, comments (inline images), interface elements, AI inputs (vision/OCR). |

---

### 2.4 Collaboration

#### 2.4.1 Comments

[Observed] Records carry a threaded comment feed with mentions and reactions, interleaved with activity. [Ours] `comments` threaded via `parent_id`; optionally anchored to a field (cell comment).

| # | Answer |
|---|---|
| Q1 | Comment panel in the expanded record; comment count badge; reactions; edit/delete own comments; resolve thread (V1). |
| Q2 | `Comment` aggregate (root) with `CommentReaction` and parsed `Mention`s. |
| Q3 | `data.comments` (record_id, table_id, field_id?, parent_id?, body jsonb, author, edited_at, deleted_at), `data.comment_reactions`, `data.mentions`, `data.record_subscriptions`. |
| Q4 | Belongs to record; author is a user (or automation actor); thread root via `parent_id`. |
| Q5 | `GET/POST /v1/bases/{baseId}/tables/{tableId}/records/{recordId}/comments`, `PATCH/DELETE …/comments/{commentId}`, `PUT/DELETE …/comments/{commentId}/reactions/{emoji}`. |
| Q6 | `TQ['comments', recordId]` patched by realtime `comment.*` messages on the base channel. |
| Q7 | `comments`, `notification`, `access`, `realtime`, `search` (V1: comment text indexed). |
| Q8 | `comment.created`, `comment.updated`, `comment.deleted`, `reaction.added`, `mention.created`. |
| Q9 | `record.comment` (commenter and above); edit/delete own; base creator may delete any. |
| Q10 | None server-side; counts per record joined at view-load time for visible rows only. |
| Q11 | Shard Postgres; body is a rich-text JSON with mention nodes referencing IDs. |
| Q12 | Soft delete: body replaced with tombstone in reads ("comment deleted"), thread preserved; purged with retention. Deleting the record hides its comments (they return on restore). |
| Q13 | Comment restore only via admin/undo within 30 days; record restore brings comments back automatically. |
| Q14 | Comments are append-only; edits are LWW by author only; reactions set semantics. |
| Q15 | Trigger "when comment created" (V1); action "add comment" (actor = automation). |
| Q16 | Mentions, notifications, record subscriptions, audit (Enterprise). |

#### 2.4.2 Mentions

[Observed] `@user` mentions in comments and long text notify the person; record mentions link to records. [Ours] Mentions are parsed server-side from rich-text nodes into `mentions` rows; notification fan-out is event-driven.

| # | Answer |
|---|---|
| Q1 | `@` autocomplete for collaborators, teams, records, contacts; notification to the mentioned user. |
| Q2 | `Mention` (value object owned by the source comment/long-text cell). |
| Q3 | `data.mentions` (source_type ∈ comment/cell, source_id, target_type ∈ user/team/record/contact, target_id), `data.record_subscriptions`. |
| Q4 | Source comment or record cell → target principal/record/contact. |
| Q5 | Implicit through comment/record writes; `GET /v1/bases/{baseId}/mention-candidates?q=`. |
| Q6 | `TQ['mentionCandidates', baseId, q]` (debounced). |
| Q7 | `comments` (parse + diff old/new mentions), `notification`, `access` (target must be able to read the record; otherwise the UI offers to share). |
| Q8 | `mention.created` (only for newly added mentions after diff). |
| Q9 | Writer needs `record.comment` or `record.update`; notification is suppressed if the target lacks `record.read`. |
| Q10 | Candidate list cached client-side per base session. |
| Q11 | `mentions` rows rebuilt on each edit of the source (delete+insert in the same tx). |
| Q12 | Removed with the source; target deletion renders "unknown user/record". |
| Q13 | Restored with the source; no re-notification. |
| Q14 | Derived from source; source conflict rules apply. |
| Q15 | Trigger condition "user mentioned" via `mention.created` (V1). |
| Q16 | Notifications, subscriptions, contact timeline (contact mentions → `contact_activities`). |

#### 2.4.3 Contacts

[Observed] CRM-style products keep a shared people/company directory and link it from many tables, with dedup and activity timelines. [Ours] Each workspace has one **contact directory**: a system base (`bases.kind='contact_directory'`) on the workspace's shard with system tables (`Contacts`, `Companies`); `contact` fields in any base of the workspace link to it through a cross-base `link_relation` (allowed only to the directory, same shard). Public IDs of contact records use prefix `ctc`. Detail in [`12`](./12-contacts.md).

| # | Answer |
|---|---|
| Q1 | Workspace "Contacts" directory (grid + profile page with timeline), `contact` field cells with avatar chips, duplicate suggestions, merge/unmerge. |
| Q2 | `Contact` (a record in the directory's contacts table) + `ContactIdentifier`s + `ContactActivity` timeline + `ContactMergeEvent`. |
| Q3 | Directory schema in `data.bases/tables/fields`; contacts in `data.records`; `data.contact_identifiers`, `data.contact_activities`, `data.contact_merge_events`; links via `data.link_relations`/`record_links`. |
| Q4 | Workspace 1→1 directory; contact N↔N records in any base via `contact` fields; contact ↔ company link inside the directory. |
| Q5 | `GET/POST /v1/workspaces/{wsId}/contacts`, `GET/PATCH/DELETE /v1/workspaces/{wsId}/contacts/{contactId}`, `POST …/contacts:query`, `POST …/contacts:merge`, `POST …/contacts/{contactId}:unmerge`, `GET …/contacts/{contactId}/activities`, `POST …/contacts:match` (find by email/phone). |
| Q6 | `TQ['contacts', wsId, query]`, directory grid uses `RecordStore` like any table; profile timeline `TQ['contactActivities', contactId]`. |
| Q7 | `contacts` (identity resolution, merge), `records`, `links`, `comments`, `integration` (email/calendar sync V1+), `ai` (enrichment V1+). |
| Q8 | `contact.created`, `contact.updated`, `contact.merged`, `contact.unmerged`, `contact.activity_logged` (+ underlying `record.*` events on the directory base). |
| Q9 | Workspace members with ≥ `editor` can edit contacts; base-only collaborators see contact chips/lookups but not the directory unless granted; directory itself is a base resource for `access_grants`. |
| Q10 | Identifier → contact resolution cache in-process per request batch (imports); no Redis cache. |
| Q11 | Shard Postgres; identifiers normalized (lowercased email, E.164 phone). |
| Q12 | Contact delete = record soft delete; links from other bases removed into deletion batch. |
| Q13 | Record restore re-links. Unmerge uses `contact_merge_events` to recreate the merged contacts with their original IDs, identifiers and links. |
| Q14 | As records (cell LWW). Merge takes row locks on all involved contacts in UUID order to prevent deadlocks; concurrent merge of the same contact fails with `CONTACT_MERGE_CONFLICT`. |
| Q15 | Triggers on contact create/update; actions "find or create contact", "log activity". |
| Q16 | `contact` fields in many bases, mentions, activities, sync sources, AI enrichment invocations. |

---

### 2.5 Views

#### 2.5.1 View (common model, all types)

[Observed] Views are saved presentations of a table with their own filters, sorts, groups, field visibility, and type-specific layout; can be collaborative, personal or locked. [Ours] One `views` row per view with `type` and a typed `config jsonb`; the query part (`filter`, `sort`, `group`) uses the **same filter AST** as the public API (D16).

```ts
// Common shape (normative types in 10-view-engine.md)
interface ViewConfigCommon {
  filter?: FilterNode;          // same AST as POST …/records:query
  sort?: { fieldId: string; direction: 'asc' | 'desc' }[];
  group?: { fieldId: string; direction: 'asc' | 'desc'; collapsed?: string[] }[];
  fieldOrder: string[];         // fld ids
  hiddenFieldIds: string[];
  rowColor?: { mode: 'select' | 'conditions'; fieldId?: string; rules?: ColorRule[] };
  manualOrder?: boolean;        // uses record order keys stored per view (see 10)
}
```

| # | Answer |
|---|---|
| Q1 | View sidebar (sections/folders), toolbar (filter/sort/group/hide/color), view-type specific canvas. |
| Q2 | `View` (entity in Base aggregate), `ViewSection`, `ViewUserState` (per-user overlay). |
| Q3 | `data.views` (`type`, `config`, `visibility` ∈ collaborative/personal/locked, `owner_user_id` for personal, `order_key`, `version`, `deleted_at`), `data.view_sections`, `data.view_user_state`. |
| Q4 | Table 1→N views; view references fields; share links and interface elements may reference a view. |
| Q5 | `GET/POST /v1/bases/{baseId}/tables/{tableId}/views`, `GET/PATCH/DELETE …/views/{viewId}` (`If-Match`), `POST …/views/{viewId}:duplicate`, `POST …/views/{viewId}:restore`, `GET …/views/{viewId}/rows?cursor=` (row-id window + records), `PUT …/views/{viewId}/user-state`. |
| Q6 | View config in schema snapshot; row-id windows in `RecordStore.viewWindows[viewId]`; unsaved toolbar edits in `UI.viewDraft` (locked views keep local-only overrides). |
| Q7 | `views`, `query` (compile filter/sort/group → SQL, choose sidecars), `access`, `realtime` (membership changes: row enters/leaves view). |
| Q8 | `view.created`, `view.updated`, `view.deleted`, `view.restored`. |
| Q9 | `view.read`, `view.create_collaborative` (editor+), `view.create_personal` (commenter+ — personal views require login), `view.update`, `view.lock` (creator). |
| Q10 | View config in `schema:{baseId}:{schemaVersion}`; no server-side result cache (realtime makes it stale instantly); client keeps windows. |
| Q11 | `views` row; user overlay in `view_user_state`. |
| Q12 | Soft delete with deletion batch; share links to the view stop resolving; interface elements bound to it fall back to table source with an editor warning. |
| Q13 | Restore view; share links resume (unless revoked separately). |
| Q14 | Config edits are field-path LWW with `version` (server merges disjoint top-level keys: e.g., concurrent filter edit + column width edit both survive); locked views reject edits from non-creators. |
| Q15 | Trigger "when record enters view" (V1) — evaluated by matcher using the compiled filter; view deletion → automation `config_error`. |
| Q16 | Share links, interface elements, automations, API `viewId` parameter, webhooks spec filters, sync sources (source view), exports. |

#### 2.5.2 Per-view-type matrix

All rows of 2.5.1 apply; the matrix lists what differs per type.

| Question | Grid | Kanban | Calendar | Gallery | Timeline | List | Form |
|---|---|---|---|---|---|---|---|
| Q1 User sees | Rows × columns, frozen primary column, summary bar, group headers | Columns per stacking field value, draggable cards | Month/week/day with records on dates; drag to reschedule | Card grid with cover image | Bars across time on swimlanes; drag/resize bars | Hierarchical outline (nested groups, indent) | Submission page with ordered questions |
| Q2 Object specifics | `GridConfig {columnWidths, rowHeight, frozenCount, summaries}` | `KanbanConfig {stackFieldId, stackOrder, hideEmpty, coverFieldId}` | `CalendarConfig {dateRanges:[{startFieldId,endFieldId?}], colorFieldId}` | `GalleryConfig {coverFieldId, coverFit, cardFieldIds}` | `TimelineConfig {startFieldId, endFieldId, swimlaneFieldId?, scale}` | `ListConfig {levels:[{tableId?, fieldId}]}` | `FormConfig {fields:[{fieldId, required, label, help, conditions}], afterSubmit, prefill}` |
| Q5 extra API | `…/rows` windowed, `…/summaries` | `…/rows?groupBy=stack` per column window | `…/rows?range=2026-10-01..2026-11-01` | `…/rows` | `…/rows?range=` | `…/rows` with group tree | `GET /v1/forms/{shareId}` (public schema), `POST /v1/forms/{shareId}:submit` |
| Q6 frontend state | Canvas grid viewport, selection model, edit overlay | Column windows map `{optionId → rowIds}` | Date bucket index `{YYYY-MM-DD → rowIds}` | Virtualized card list | Interval tree over visible range | Expanded-node set | Form draft in `LS` (autosave) |
| Q7 query shape | `ORDER BY` + keyset pagination | `GROUP BY stack` + per-stack keyset | Range predicate on date field(s) (sidecar `record_index_time`) | Keyset | Interval overlap predicate | Recursive group fetch | Single insert via form endpoint |
| Q9 permission nuance | Standard | Dragging changes the stack field → `record.update` on that field | Dragging edits date fields | Standard | Drag edits start/end | Standard | Submitting needs only form share link (public) or `record.create` (internal); hidden fields never exposed |
| Q12/Q13 delete-restore nuance | — | Deleting a select option used as stack moves cards to "Uncategorized" | — | Cover field deletion → no cover | — | — | Deleting form view invalidates its share link; restore re-enables |
| Q14 concurrency nuance | Cell LWW; column width per user (personal) vs shared | Card move = stack value set (LWW) + manual order key | Drag = date write LWW | — | Drag = two field writes in one op (atomic) | — | Each submission is a new record (no conflict) |
| Q15 automation nuance | — | Common "moved to stage" trigger = field change | Date-based scheduled triggers | — | — | — | Trigger `form.submitted` (event) — carries form view id |

---

### 2.6 Apps & forms

#### 2.6.1 Forms

[Observed] Forms collect records from internal or anonymous users, with conditional fields, prefill, and post-submit behavior. [Ours] A form is a view of type `form` plus an optional public `share_link`; submissions go through the same record write path with actor `public_form`.

| # | Answer |
|---|---|
| Q1 | Form builder (drag fields, labels, required, conditions, cover, branding); public form page; confirmation/redirect. |
| Q2 | `View` (type `form`) + `ShareLink` (type `form`) + resulting `Record`. |
| Q3 | `data.views`, `data.share_links`, `data.records`, `data.attachments` (uploads via form token), `data.idempotency_keys`. |
| Q4 | Form → table; share link → form view; submission → record (+ attachments, links to existing records if allowed). |
| Q5 | Builder via view endpoints; public: `GET /v1/forms/{shareId}`, `POST /v1/forms/{shareId}/attachments:initiate`, `POST /v1/forms/{shareId}:submit` (Idempotency-Key required; CAPTCHA token for public forms). |
| Q6 | Builder: view draft in `UI.viewDraft`; public page: standalone light bundle, draft in `LS`. |
| Q7 | `views`, `share`, `records`, `attachments`, `automation`; anti-abuse (rate limit per IP + per form, CAPTCHA provider verification server-side). |
| Q8 | `form.submitted`, `record.created`, `share_link.accessed` (sampled). |
| Q9 | Public submit requires a valid, non-revoked share link; internal forms require `record.create`. Org policy may disable public forms. Link-field pickers on public forms expose only primary values of a restricted candidate set configured by the builder. |
| Q10 | Public form schema cached at CDN 60 s keyed by share id + schema version (purged on change). |
| Q11 | Records; submission metadata in `record` `created_by` = `null`, actor in change log = `public_form:{shareId}`. |
| Q12 | Deleting the form view/share link → 404 "form no longer accepting responses"; existing records untouched. |
| Q13 | View restore reactivates link if not separately revoked. |
| Q14 | Each submission independent; builder edits LWW per view. |
| Q15 | Very common trigger (`form.submitted` / record created with `actor.via='form'`). |
| Q16 | Share links, interface form elements, automations. |

#### 2.6.2 Interfaces

[Observed] Builders compose app-like pages from data-bound components (lists, record details, charts, forms, buttons) and publish them to users who may not see the underlying base. [Ours] `interfaces` with draft pages (`interface_pages.layout`) and immutable published snapshots (`interface_versions`); interface-only users get `interface_only` base role + interface grants. Product-facing name to be chosen (see §3). Detail in [`13`](./13-interface-builder.md).

| # | Answer |
|---|---|
| Q1 | Builder canvas (drag elements, bind to table/view, configure filters/permissions/actions), preview-as-user, publish; end users see the published app. |
| Q2 | `Interface` aggregate (root) with `InterfacePage`s (draft) and `InterfaceVersion`s (published); `InterfaceElement` is a value object inside page layout JSON. |
| Q3 | `data.interfaces`, `data.interface_pages`, `data.interface_versions`; grants in `core.access_grants` (resource_type=`interface`). |
| Q4 | Base 1→N interfaces; elements reference tables/views/fields/automations (buttons); interface grants to users/teams. |
| Q5 | `GET/POST /v1/bases/{baseId}/interfaces`, `GET/PATCH/DELETE …/interfaces/{interfaceId}`, `GET/PUT …/interfaces/{interfaceId}/pages/{pageId}` (draft, `If-Match`), `POST …/interfaces/{interfaceId}:publish`, `GET …/interfaces/{interfaceId}/versions`, `POST …/interfaces/{interfaceId}/versions/{n}:restore`, element data `POST …/interfaces/{interfaceId}/elements/{elementId}:query`. |
| Q6 | Builder: `UI.interfaceDraft` (element tree, selection, undo stack local to builder), autosave debounced 1 s; runtime: `TQ['interfaceVersion', id, n]` + `RecordStore` for element data. |
| Q7 | `interfaces`, `query` (element-scoped queries with forced filters), `access` (element permission compilation), `records`, `automation` (button actions). |
| Q8 | `interface.created`, `interface.updated`, `interface.published`, `interface.deleted`, `button.clicked`. |
| Q9 | `interface.read`, `interface.edit` (interface_editor or base creator), `interface.publish`; element-level permissions (`canEdit`, editable field list, `canCreate`, `canDelete`, record filter `current user = {collaborator field}`) are compiled into the PermissionSnapshot as an **interface scope**. |
| Q10 | Published versions are immutable → cached in-process (LRU keyed by `interfaceId:versionNo`, no invalidation needed) and in the browser via `ETag`; compiled element permissions are part of the principal's perm snapshot. |
| Q11 | Draft layout jsonb; published versions immutable rows. |
| Q12 | Soft delete; interface-only users lose access (their grant remains masked for restore). |
| Q13 | Restore + grants unmasked. Version restore copies an old version into the draft. |
| Q14 | Draft edits: page-level `If-Match` with element-level merge (server merges non-overlapping element changes; conflicting same-element edits → 409 with server copy; builder shows "updated by X" and reloads element). Publishing is atomic. |
| Q15 | Button elements run automations (`button.clicked` event with record context); automations can't edit interfaces. |
| Q16 | Interface grants, share links (public interface), notifications deep links, templates. |

---

### 2.7 Automation & integration

#### 2.7.1 Automations

[Observed] No-code workflows: a trigger (record created/updated/matches condition, form submitted, schedule, webhook, button) followed by actions (create/update records, send email/message, call webhook, run script), with run history. [Ours] Draft config on `automations`, immutable `automation_versions` on publish, durable runs in `automation_runs`/`automation_step_runs`, execution on BullMQ (D21). Detail in [`14`](./14-automation-engine.md).

| # | Answer |
|---|---|
| Q1 | Automation list per base; editor (trigger, conditions, steps, branches, test step with sample record); on/off toggle; run history with step inputs/outputs and errors. |
| Q2 | `Automation` aggregate (root) with `AutomationVersion` (immutable), `AutomationRun` aggregate (root for a run) with `AutomationStepRun`s; `AutomationSchedule`. |
| Q3 | `data.automations`, `data.automation_versions`, `data.automation_runs`, `data.automation_step_runs`, `data.automation_schedules`, `data.inbound_webhooks`, `data.secrets`, `data.integration_connections`. |
| Q4 | Base 1→N automations; version references tables/fields/views/connections/secrets by ID; run → version, trigger event (`trigger_event_id`), trigger record. |
| Q5 | `GET/POST /v1/bases/{baseId}/automations`, `GET/PATCH/DELETE …/automations/{automationId}` (draft, `If-Match`), `POST …/automations/{automationId}:publish`, `:enable`, `:disable`, `POST …/automations/{automationId}:test` (dry-run of trigger or step), `GET …/automations/{automationId}/runs`, `GET …/runs/{runId}`, `POST …/runs/{runId}:retry`. |
| Q6 | `TQ['automations', baseId]`, `UI.automationDraft` (editor), `TQ['automationRuns', automationId, cursor]` with live status via realtime `automation.*` messages to editors. |
| Q7 | `automation` (trigger matcher consuming `tabula.domain-events.v1`; step runner), `sandbox` role for scripts, `integration` (connections, OAuth refresh), `ai` (AI steps), `notification`/`email`; queues `automation-trigger`, `automation-step`, `automation-schedule`; `scheduler` for schedules + reconciler. |
| Q8 | `automation.created`, `automation.published`, `automation.paused`, `automation.triggered`, `automation.completed`, `automation.failed`, `automation.step_failed`, `automation.disabled_by_system`; actions emit normal domain events with `actor.type='automation'` and incremented `causationDepth`. |
| Q9 | `automation.read`, `automation.edit` (creator), `automation.run` (manual/button). Runs execute with the **automation's owner-less service identity** scoped to its base: writes are permitted on the base regardless of the editor's later role changes, but field/table restrictions that target "automations" are honored; external access only via configured connections/secrets. |
| Q10 | Trigger index per base in-process: `{eventType, tableId} → [automationVersion]` rebuilt on `automation.published/paused`; hourly budget counters `ratebudget:automation:{automationId}:{hour}`. |
| Q11 | Postgres for all state; BullMQ holds only job envelopes (`{runId, stepIndex}`). Step inputs/outputs stored inline in `automation_step_runs` (jsonb, ≤ 64 KB; larger values truncated with `truncated: true`). Run history retained per plan (30 days Team, 1 year Enterprise) via monthly partition drops. |
| Q12 | Soft delete (via deletion batch); in-flight runs complete; queued runs cancelled; schedules removed. |
| Q13 | Restored as **off** (never silently re-enabled); user re-enables. |
| Q14 | Draft edits `If-Match` (whole-draft version) — single-editor UX with "being edited by X" presence; publish creates a new immutable version; running runs keep using their version. |
| Q15 | Automations can trigger automations (via record changes), bounded by `MAX_CAUSATION_DEPTH` = 8 and budgets; idempotency key `automation_id + trigger_event_id`. |
| Q16 | Button fields, interface buttons, inbound webhooks, schedules, run history references in notifications. |

#### 2.7.2 Outbound webhooks (API webhooks)

[Observed] Developers register webhook subscriptions for a base with a filter spec; payloads notify of changes and clients fetch details by cursor. [Ours] Thin notifications + **cursor fetch** from `base_changes` (D10), HMAC-signed, at-least-once.

| # | Answer |
|---|---|
| Q1 | Developer-facing only (API + small settings list with status/failures). |
| Q2 | `WebhookSubscription` aggregate (root) with `WebhookDelivery` attempts. |
| Q3 | `data.webhook_subscriptions` (spec jsonb, cursor seq, secret ref, status, expires_at, failure_count), `data.webhook_deliveries` (partitioned monthly). |
| Q4 | Base 1→N subscriptions; created by a user or OAuth app; cursor points into `base_changes.seq`. |
| Q5 | `POST/GET /v1/bases/{baseId}/webhooks`, `DELETE …/webhooks/{webhookId}`, `POST …/webhooks/{webhookId}:refresh` (extend expiry), `GET …/webhooks/{webhookId}/payloads?cursor=` (change list since cursor). |
| Q6 | N/A (developer console lists `TQ['webhooks', baseId]`). |
| Q7 | `integration` (dispatcher consumes `tabula.base-changes.v1`, matches spec, coalesces per subscription, enqueues `webhook-out`), egress proxy with SSRF protections. |
| Q8 | No new domain events for each delivery (avoid recursion); status changes audited. |
| Q9 | Creating requires `api.access` + `base.read` and the token's scopes; payload fetch re-checks the creator's **current** permissions and filters fields/tables accordingly. |
| Q10 | Per-base subscription index in-process (invalidated on create/delete). |
| Q11 | Subscriptions + delivery log; payloads are re-derived from `base_changes` (not stored per delivery). |
| Q12 | Hard delete of subscription; deliveries retained per partition retention (90 days). |
| Q13 | N/A. Base restore: subscriptions resume if cursor still within `BASE_CHANGES_RETENTION`, else `expired`. |
| Q14 | N/A. |
| Q15 | Independent from automations (automations have their own webhook action). |
| Q16 | Delivery records only. Auto-disable after 7 days of continuous failure; expiry after 7 days without refresh for user tokens (configurable for OAuth apps). |

#### 2.7.3 Inbound webhooks

[Observed] Automations can start from an incoming HTTP request to a generated URL. [Ours] `inbound_webhooks` rows hold an unguessable URL token + optional HMAC secret; payload stored on the run.

| # | Answer |
|---|---|
| Q1 | In the automation trigger config: generated URL, "send test request", sample payload viewer. |
| Q2 | `InboundWebhook` (child of Automation aggregate). |
| Q3 | `data.inbound_webhooks` (url_token hash, secret ref, automation_id, status, last_received_at). |
| Q4 | 1:1 with an automation trigger. |
| Q5 | `POST https://hooks.tabula.example/v1/in/{token}` (public; the opaque 32-byte token is the credential, stored as SHA-256; optional HMAC signature header), ≤ 1 MB JSON/form body; config via automation endpoints. |
| Q6 | Part of `UI.automationDraft`. |
| Q7 | Dedicated `api` route group on the `hooks.` host (separate rate limits, no session, no cookies), `automation`; queue `automation-trigger`. Routing: `sha256(token)` → `core.public_link_directory` (proposed in [`04` §6.29](./04-database-architecture.md#629-proposed-additions)) → workspace/base → shard. |
| Q8 | `inbound_webhook.received` → `automation.triggered`. |
| Q9 | Possession of the token (+ HMAC if configured); org policy can disable inbound webhooks. |
| Q10 | Token-hash → route entry cached like other routes (in-process LRU + Redis, see [`04` §6.4](./04-database-architecture.md#64-routing)); rate limit `rl:inbound:{inboundWebhookId}:{window}`. |
| Q11 | Payload persisted as the run's trigger output (≤ 1 MB). |
| Q12 | Deleting the automation revokes the endpoint (410). |
| Q13 | Restored with automation but stays off. |
| Q14 | N/A. |
| Q15 | It *is* a trigger. |
| Q16 | Automation runs. |

#### 2.7.4 Public API, tokens & OAuth apps

[Observed] REST API with personal tokens and OAuth apps, per-base scoping, rate limits. [Ours] D16 + D19: `/v1` REST, PATs/service-account tokens with scopes and resource restrictions, OAuth 2.1 PKCE.

| # | Answer |
|---|---|
| Q1 | Developer hub: create/revoke tokens, choose scopes and bases; OAuth consent screen; auto-generated per-base API docs. |
| Q2 | `ApiToken`, `ServiceAccount`, `OAuthClient`, `OAuthGrant`, `OAuthAuthorizationCode`. |
| Q3 | `core.api_tokens`, `core.service_accounts`, `core.oauth_clients`, `core.oauth_grants`, `core.oauth_authorization_codes`, `core.rate_limit_overrides`; `data.idempotency_keys` on shards. |
| Q4 | Token → user or service account; scopes; resource restrictions (workspace/base ids). |
| Q5 | `GET/POST /v1/me/tokens`, `DELETE /v1/me/tokens/{tokenId}`, `POST /v1/orgs/{orgId}/service-accounts`, OAuth `GET /v1/auth/oauth/authorize`, `POST /v1/auth/oauth/token`, `POST /v1/auth/oauth/revoke`, `POST /v1/auth/oauth/introspect`, `GET /.well-known/oauth-authorization-server`. |
| Q6 | `TQ['tokens']`; secret shown once. |
| Q7 | `auth` (token verification), `access`, rate limiter middleware, `audit`. |
| Q8 | `api_token.created`, `api_token.revoked`, `grant.changed` (OAuth consent). |
| Q9 | `api.access` (org policy may restrict to admins/service accounts), effective permission = token scopes ∩ resource restrictions ∩ principal's permissions. |
| Q10 | Token lookup `sess:{tokenHash}` namespace reused for API tokens (TTL 5 min, revocation deletes key); rate limit buckets `rl:token:{id}:{window}`, `rl:base:{id}:{window}`; idempotency fast-path `idem:{scope}:{key}`. |
| Q11 | Hashed secrets (SHA-256 of high-entropy token; Argon2 unnecessary for 256-bit random), last-used timestamp (batched updates). |
| Q12 | Revocation is immediate (Redis delete + DB status); deleting a user revokes their tokens; deleting a service account revokes its tokens. |
| Q13 | Not restorable (issue a new token). |
| Q14 | N/A. |
| Q15 | Automations don't use tokens (internal identity); scripts get a short-lived scoped internal token minted per run. |
| Q16 | Audit events, webhook subscriptions (creator), OAuth grants. |

#### 2.7.5 Sync (external & cross-base data sources)

[Observed] Tables can be kept in sync from another base's view or from external systems, typically read-only in the destination with optional editable local fields. [Ours] `sync_sources` define source, mapping and schedule; destination is a normal table with `tables.config.sync = {sourceId, readOnlyFieldIds}`; each execution is a `sync_runs` row. Product name to be chosen (see §3).

| # | Answer |
|---|---|
| Q1 | "Add synced table" wizard (source type, auth, field mapping, frequency), sync status badge, "sync now". |
| Q2 | `SyncSource` aggregate (root) with `SyncRun`s; destination `Table`. |
| Q3 | `data.sync_sources` (type, connection_id, source spec, mapping, schedule, cursor/watermark, status), `data.sync_runs`, `data.integration_connections`. |
| Q4 | Source → destination table; uses an integration connection for external sources; cross-base source within the same workspace reads the source base's `base_changes`; cross-workspace (cross-shard) sources read via the internal API. |
| Q5 | `POST/GET /v1/bases/{baseId}/sync-sources`, `PATCH/DELETE …/sync-sources/{id}`, `POST …/sync-sources/{id}:run`, `GET …/sync-sources/{id}/runs`. |
| Q6 | `TQ['syncSources', baseId]`, status updates through realtime `long_operation.*`-style messages. |
| Q7 | `integration`, `integration` (connectors), `records` (upsert by external key stored in a hidden `json` field slot), `schema` (auto-add fields); queue `integration`. |
| Q8 | `sync.completed`, `sync.failed`, `records.bulk_changed` with `actor.via='sync'`. |
| Q9 | `integration.manage` to configure; synced fields are read-only via `fields.restrictions` (`editableBy: 'sync'`). Source-side permission: the configuring user must have `export.data` on the source; re-validated each run. |
| Q10 | Connector rate-limit state in Redis (`rl:sync:{connectionId}:{window}`). |
| Q11 | Watermark/cursor in `sync_sources`; records in destination. |
| Q12 | Deleting the source stops sync; destination table becomes a normal table (fields unlocked). |
| Q13 | Restore: next run does a full reconcile. |
| Q14 | Synced fields: sync is the only writer. Local (non-synced) fields: normal LWW. |
| Q15 | Sync-written changes do trigger automations (actor `integration`), subject to the automation's "ignore sync changes" option. |
| Q16 | Destination table fields, automations. |

#### 2.7.6 Import

[Observed] CSV/XLSX (and other app) imports into new or existing tables with field mapping and type detection. [Ours] Upload file → `import_jobs` with mapping → `import` queue processes in batches of 1,000 through the record write path; row errors in `import_errors`. Flow in [`30`](./30-architecture-diagrams.md#14-import-flow), detail in [`20`](./20-import-export-sharing-integrations.md).

| # | Answer |
|---|---|
| Q1 | Import wizard: upload, preview first 50 rows, field mapping with type suggestions, "create new table" vs "append/merge into existing" (merge key), progress, error report download. |
| Q2 | `ImportJob` aggregate (root) with `ImportError`s; progress via `LongOperation`. |
| Q3 | `data.import_jobs`, `data.import_errors`, `data.long_operations`; source file in `tabula-uploads-quarantine` then scanned. |
| Q4 | Job → target base/table; creates fields/records; one `deletion_batch`-like grouping via `long_operations.id` for "undo import". |
| Q5 | `POST /v1/bases/{baseId}/imports` (create, returns upload URL), `POST …/imports/{importId}:analyze` (detect columns/types), `PUT …/imports/{importId}/mapping`, `POST …/imports/{importId}:start`, `GET …/imports/{importId}`, `GET …/imports/{importId}/errors`, `POST …/imports/{importId}:cancel`, `POST …/imports/{importId}:undo`. |
| Q6 | `UI.importWizard`; `TQ['imports', importId]` + realtime progress. |
| Q7 | `import-export`, `attachments` (scan), `schema`, `records`, `compute` (bulk mode: compute deferred per batch); queue `import`. |
| Q8 | `records.bulk_changed` (per batch), `import.completed`, `import.failed`, `long_operation.progressed`. |
| Q9 | New table: `table.create`; existing: `record.create`/`record.update`; plan record limits enforced before start (estimated) and per batch (exact). |
| Q10 | None. |
| Q11 | Job config, counts, error rows (capped at 10,000 stored errors per job). |
| Q12 | "Undo import" (within `BASE_CHANGES_RETENTION`): every batch's `base_changes` row is tagged with the job's `lop` id; undo applies their inverse ops in reverse seq order — created records go into one deletion batch, updated cells revert unless a later change touched the same cell (those are reported, not overwritten). |
| Q13 | N/A (undo of undo = restore deletion batch). |
| Q14 | Imports write in batches; concurrent user edits win or lose per cell by commit order; merge-mode uses `If-Match`-free upsert by key. |
| Q15 | Bulk imports don't fan out per-record automation runs unless the automation opts in (`triggerOnBulk: true`); default: one `records.bulk_changed` event is ignored by record triggers. |
| Q16 | Long operations, notifications (completion email). |

#### 2.7.7 Export

[Observed] CSV export of a view; full base download in some tiers. [Ours] `export_jobs` producing objects in `tabula-exports` (7-day lifecycle), delivered via signed URL.

| # | Answer |
|---|---|
| Q1 | "Download CSV" on a view; base export (CSV zip / JSON) for admins; progress and email when ready. |
| Q2 | `ExportJob`. |
| Q3 | `data.export_jobs`, `data.long_operations`; S3 `tabula-exports`. |
| Q4 | Job → view/table/base. |
| Q5 | `POST /v1/bases/{baseId}/exports` (`{scope: view|table|base, format: csv|xlsx|json, viewId?}`), `GET …/exports/{exportId}` (status + signed URL). |
| Q6 | `TQ['exports', exportId]`. |
| Q7 | `import-export`, `query` (streams view query with keyset pagination from a **replica** when lag < 5 s, else primary), queue `export`. |
| Q8 | `export.completed`, `long_operation.completed`; an audit record (action `export.data`) in `audit.audit_events`. |
| Q9 | `export.data` (org policy can restrict to admins); export honors field restrictions/hidden fields of the requesting user. |
| Q10 | None. |
| Q11 | Object for 7 days; job row for 90 days. |
| Q12 | Lifecycle deletion of object; cancel in-flight job. |
| Q13 | N/A. |
| Q14 | Export is a consistent snapshot: single `REPEATABLE READ` transaction per table stream (bounded by statement timeout 15 min; larger exports chunk by keyset and record the `change_seq` at start in the manifest). |
| Q15 | Automation action "export view to CSV and email" (V1). |
| Q16 | Audit log. |

---

### 2.8 Platform services

#### 2.8.1 Search

[Observed] Global search across bases/tables/records and in-view search highlighting matches. [Ours] Two distinct features: **in-view find** (client-side over loaded windows + server `search` param on the view query) and **global search** (MVP Postgres FTS `search_documents`; V1 OpenSearch per-shard indices, D14).

| # | Answer |
|---|---|
| Q1 | Cmd-K global search (bases, tables, records, contacts, interfaces); in-view search bar with match navigation. |
| Q2 | `SearchDocument` (derived projection; not an aggregate). |
| Q3 | MVP `data.search_documents` (doc_type, base_id, table_id, record_id, `tsvector`, trigram text, updated_seq); V1 OpenSearch index per shard `tabula-records-{shardId}`. |
| Q4 | Projection of records/tables/fields/bases/contacts. |
| Q5 | `GET /v1/search?q=&scope=workspace|base&baseId=&types=` ; in-view: `POST …/records:query {search: "acme"}`. |
| Q6 | `TQ['search', scope, q]` (debounced 150 ms); in-view highlight state `UI.viewSearch`. |
| Q7 | `search` (indexer consumes `tabula.domain-events.v1`; queue `search-index` in MVP), `access` (filter by accessible base IDs, then post-filter restricted fields). |
| Q8 | Consumes `record.*`, `field.*`, `table.*`, `base.*`; emits none. |
| Q9 | Results limited to bases where `base.read`; field-restricted text is not indexed into the shared doc (Enterprise field hide: indexed into a restricted sub-field and filtered at query time). |
| Q10 | None beyond OpenSearch; accessible-base-id list taken from the principal's snapshots (control-plane query, cached 60 s in-process). |
| Q11 | Derived, rebuildable from Postgres at any time (`maintenance` reindex job per base). |
| Q12 | Delete events remove docs; base trash removes all base docs (async). |
| Q13 | Restore events re-index (bulk reindex of the base/table). |
| Q14 | Indexer applies changes with `updated_seq` guard (ignore older seq). |
| Q15 | Automation action "find records" uses the view query engine, not the search index (consistency). |
| Q16 | Nothing references search docs. |

#### 2.8.2 Record history (revisions)

[Observed] Expanded records show a revision history of cell changes with author and time, retained per plan. [Ours] `record_revisions` cell-level, partitioned monthly, retention per plan limits (spine §12).

| # | Answer |
|---|---|
| Q1 | "Activity" tab in expanded record: "Jane changed Status from Open → Closed · 2h ago"; filter by field; restore a past value (V1). |
| Q2 | `RecordRevision` (append-only). |
| Q3 | `data.record_revisions` (record_id, table_id, field_id, slot, old jsonb, new jsonb, actor, via, change_seq, created_at). |
| Q4 | Record, field, change (`change_seq` → `base_changes`). |
| Q5 | `GET …/records/{recordId}/revisions?cursor=&fieldId=`. |
| Q6 | `TQ['revisions', recordId]`; merged with comments into one activity feed client-side. |
| Q7 | `history` (written in the write tx for user fields; computed fields **not** revisioned), `access`. |
| Q8 | None (revisions are a consequence of `record.*`). |
| Q9 | `record.read`; old values of fields the viewer cannot see are filtered. |
| Q10 | None. |
| Q11 | Partition retention by plan; Enterprise configurable. Coalescing: consecutive edits of the same cell by the same actor within 60 s merge into one revision (update in place). |
| Q12 | Record purge deletes its revisions; field purge leaves revisions (shown as "deleted field"). |
| Q13 | Restoring a record keeps history. |
| Q14 | Append-only; coalescing uses `ON CONFLICT` on (record_id, slot, actor, coalesce_window) — see [`22`](./22-audit-history-undo-trash.md). |
| Q15 | Not a trigger source. |
| Q16 | Undo (indirectly through `base_changes`), audit exports. |

#### 2.8.3 Undo / redo

[Observed] Users can undo recent edits (cells, deletes, field changes) per session. [Ours] Server-side command log with inverse ops on `base_changes.inverse_ops`; client keeps a per-session stack of change IDs (D25).

| # | Answer |
|---|---|
| Q1 | Ctrl/Cmd-Z, Shift-Cmd-Z; toast "Undid: changed 3 cells"; undo of deletes restores. |
| Q2 | `ChangeSet` (= `base_changes` row) with `ops` and `inverseOps`; client `UndoStack`. |
| Q3 | `data.base_changes` (`inverse_ops`), `data.deletion_batches`. |
| Q4 | Change → actor session; inverse op may reference a deletion batch. |
| Q5 | `POST /v1/bases/{baseId}/changes/{changeId}:undo`, `POST /v1/bases/{baseId}/changes/{changeId}:redo` (also as realtime ops `undo`/`redo`). |
| Q6 | `UI.undoStack[baseId] = [{changeId, label}]` max 100 entries per base per tab; cleared on base switch. |
| Q7 | `history` (apply inverse ops through the normal write path, producing a new change with `via='undo'`). |
| Q8 | `change.undone`, `change.redone` + normal domain events of the applied ops. |
| Q9 | Only the actor of the change (same user; any of their sessions) may undo it; permission re-checked at undo time (a revoked editor cannot undo). |
| Q10 | None. |
| Q11 | 30-day `base_changes` retention bounds undo; UI stack is per-tab memory. |
| Q12 | N/A. |
| Q13 | N/A. |
| Q14 | **Conflict-aware undo:** inverse op `setCell(old)` is applied only if the cell's `cell_meta.seq` still equals the change's seq; otherwise that cell is skipped and reported ("2 cells changed by others were not undone"). Set ops invert to set ops (commutative). |
| Q15 | Undo-produced changes trigger automations like any change (actor via `undo`). |
| Q16 | N/A. |

#### 2.8.4 Trash

[Observed] Deleted records, fields, tables, views, bases and workspaces can be restored for a period. [Ours] Every user delete creates a `deletion_batches` row grouping all soft-deleted objects (and captured link pairs) as one restorable unit; purge after `TRASH_RETENTION`.

| # | Answer |
|---|---|
| Q1 | Trash panel per base (records, fields, tables, views, interfaces, automations) and per workspace (bases); "Restore", "Delete permanently" (admins). |
| Q2 | `DeletionBatch` aggregate (root for restore/purge). |
| Q3 | `data.deletion_batches` (kind, root object, object counts, captured links/payload ref, actor, deleted_at, purge_after, status); objects carry `deleted_at` + `deletion_batch_id`. |
| Q4 | Batch → many soft-deleted objects. |
| Q5 | `GET /v1/bases/{baseId}/trash`, `POST …/trash/{batchId}:restore`, `DELETE …/trash/{batchId}` (permanent, admin only, confirmation token). |
| Q6 | `TQ['trash', baseId]`. |
| Q7 | `history`, `records`, `schema`, `links`, `compute`; `scheduler` + queue `purge`. |
| Q8 | `*.deleted` / `*.restored` per object kind, `trash.purged`. |
| Q9 | Restore requires the permission needed to delete the object; permanent delete requires base creator (base content) / workspace owner (bases). |
| Q10 | None. |
| Q11 | Postgres; very large captured link sets stored in `tabula-snapshots` with key referenced from the batch. |
| Q12 | Purge: hard delete rows in batches of 5,000 (records, links, revisions, comments, attachments marked for orphan sweep). |
| Q13 | Restore validates conflicts (e.g., unique primary in sync tables, restored field name collision → auto-suffix "(restored)"), then clears flags and re-inserts captured links. |
| Q14 | Restore takes an advisory lock on the batch; concurrent restore = idempotent no-op. |
| Q15 | Restored records emit `record.restored` (record triggers can opt in). |
| Q16 | Undo (inverse of delete = restore batch). |

#### 2.8.5 Notifications

[Observed] In-app inbox plus email for mentions, assignments, comments on watched records, automation failures; user-tunable preferences. [Ours] Event-driven `notification` router; `core.notifications` partitioned monthly; preferences per user × scope × category × channel; email digesting.

| # | Answer |
|---|---|
| Q1 | Bell inbox (unread count, mark read, open deep link), email notifications and digests, mobile push (V2), preference matrix. |
| Q2 | `Notification`, `NotificationPreference`, `NotificationDelivery`. |
| Q3 | `core.notifications`, `core.notification_preferences`, `core.notification_deliveries`, `core.email_suppressions`; `data.record_subscriptions` (who watches what). |
| Q4 | Notification → recipient user; references a base/record/comment by public ID in `payload` (rendered at read time with permission check). |
| Q5 | `GET /v1/me/notifications?cursor=&unread=`, `POST /v1/me/notifications:markRead`, `GET/PUT /v1/me/notification-preferences`, `POST /v1/unsubscribe/{token}` (one-click). |
| Q6 | `TQ['notifications']` + realtime user channel push (`ntf` messages) for unread count. |
| Q7 | `notification` (router consumes `mention.created`, `comment.created`, `record.assigned`, `automation.failed`, `invitation.created`, `import.completed`, `export.completed`, `usage.threshold_reached`), queues `notification`, `email`. |
| Q8 | Consumes the above; deliveries tracked in table (no domain events). |
| Q9 | Recipient must still have access at render time; otherwise the item renders as "You no longer have access". |
| Q10 | Unread count per user cached in-process in realtime nodes; preferences fetched per routing batch. |
| Q11 | Notifications retained 90 days; deliveries 30 days. |
| Q12 | User can archive; source deletion leaves notification with "item deleted". |
| Q13 | N/A. |
| Q14 | Mark-read is idempotent; `read_at` LWW. |
| Q15 | Automation actions can send in-app notifications (`ntf`) and emails. |
| Q16 | Delivery records. |

#### 2.8.6 Sharing (share links)

[Observed] Views, forms, interfaces and whole bases can be shared via read-only links, optionally password-protected, domain-restricted, or embeddable. [Ours] `share_links` with unguessable token, scope, options; anonymous access compiled into a share-scoped PermissionSnapshot.

| # | Answer |
|---|---|
| Q1 | Share dialog: invite people (grants) vs. create link (view/form/interface/base), options: allow copy, show all fields, password, email-domain restriction, expiry, embed code. |
| Q2 | `ShareLink` aggregate. |
| Q3 | `data.share_links` (kind ∈ view/form/interface/base, target id, token hash, options jsonb, created_by, expires_at, revoked_at). |
| Q4 | Link → target object; creator user. |
| Q5 | `POST /v1/bases/{baseId}/share-links`, `GET …/share-links`, `PATCH/DELETE …/share-links/{shareId}`; public resolution `GET /v1/shared/{shareToken}` → bootstrap payload; data `POST /v1/shared/{shareToken}/rows:query`. |
| Q6 | Share dialog `TQ['shareLinks', baseId]`; public viewer is a separate route with a read-only RecordStore. |
| Q7 | `share`, `access` (share-scope snapshot: view's visible fields only, view filter forced), `views`, `query`. |
| Q8 | `share_link.created`, `share_link.revoked`, `share_link.accessed` (sampled 1%). |
| Q9 | `base.share`; org policies: disable public links, restrict to domains; password-protected links issue a short-lived share session cookie after password check (Argon2id hash). |
| Q10 | `perm:share_{shareId}:{baseId}:{permEpoch}` snapshot; CDN caching of bootstrap for 30 s when not password protected. |
| Q11 | Token stored hashed; the plaintext token only in the URL. |
| Q12 | Revocation immediate (snapshot key invalidated via `perm_epoch` bump). |
| Q13 | Revoked links are not restorable (create a new one); a link whose target was trashed resumes when the target is restored. |
| Q14 | Options LWW. |
| Q15 | None (form submissions are covered by forms). |
| Q16 | Audit (Enterprise), embed analytics. |

#### 2.8.7 Templates

[Observed] Template galleries let users start bases from curated examples; users can also duplicate bases. [Ours] `core.templates` metadata + base snapshot in S3; instantiate = snapshot restore into a new base on the target workspace's shard.

| # | Answer |
|---|---|
| Q1 | Template gallery with categories/preview; "Use template"; org-private templates (Enterprise). |
| Q2 | `Template`. |
| Q3 | `core.templates` (category, visibility ∈ public/org, snapshot object key, schema version, preview images); S3 `tabula-snapshots`. |
| Q4 | Template → source base snapshot; instantiated bases record `bases.settings.templateId`. |
| Q5 | `GET /v1/templates?category=`, `GET /v1/templates/{templateId}`, `POST /v1/workspaces/{wsId}/bases {fromTemplateId}`, `POST /v1/orgs/{orgId}/templates {fromBaseId}`. |
| Q6 | `TQ['templates', category]`. |
| Q7 | `base`, `history` (snapshot export/import code shared with base snapshots), queue `snapshot`. |
| Q8 | `base.created` (with `data.templateId`). |
| Q9 | Public templates: everyone; org templates: org members; publishing requires `org.manage`. |
| Q10 | Gallery list CDN-cached 5 min. |
| Q11 | Control-plane row + S3 snapshot (versioned bucket). |
| Q12 | Unpublish hides; existing bases unaffected. |
| Q13 | Re-publish. |
| Q14 | N/A. |
| Q15 | Automations in templates are instantiated **off**. |
| Q16 | Bases created from them (informational only). |

#### 2.8.8 AI

[Observed] AI features in the category: AI-generated field values, formula/automation authoring help, summarization, natural-language base building, agent-like assistants. [Ours] `@tabula/ai` provider abstraction + AI gateway module; `ai_generated` field type; every call logged in `ai_invocations`; org AI policy (D22). Detail in [`21`](./21-ai-architecture.md).

| # | Answer |
|---|---|
| Q1 | AI field (prompt referencing fields, "generate"/"regenerate", auto-run on change), "Ask AI" for formulas/automations/filters, record summary, base-from-prompt wizard, AI automation step. |
| Q2 | `AiPromptTemplate` (versioned), `AiInvocation`; AI field = `Field` type `ai_generated` with `config {templateId, templateVersion, inputFieldIds, model, autoRun, outputType}`. |
| Q3 | `data.ai_prompt_templates`, `data.ai_invocations` (partitioned monthly), `records.computed[slot]` = `{value, status, inv}`; usage in `core.usage_events`. |
| Q4 | Invocation → actor, base, record/field (optional), template version, model; AI field depends on input fields (graph edges, but async). |
| Q5 | `POST /v1/bases/{baseId}/ai/formula:suggest`, `POST …/ai/filter:suggest`, `POST …/tables/{tableId}/fields/{fieldId}:generate {recordIds | viewId}`, `POST /v1/workspaces/{wsId}/ai/bases:generate`, `GET /v1/bases/{baseId}/ai/invocations?cursor=` (admin). |
| Q6 | Streaming responses (SSE) into local component state; AI cell status in `RecordStore` (`pending` spinner). |
| Q7 | `ai` gateway (routing: `claude-sonnet-5` default, `claude-haiku-4-5-20251001` for bulk field generation/classification, `claude-opus-5-5` for agents/base generation), `compute` (marks AI cells pending on input change), queue `ai`, `billing` (credits). |
| Q8 | `ai.invocation_completed`, `ai.invocation_failed`, `ai_field.value_generated` (+ `record.computed_updated`). |
| Q9 | `ai.use`; org AI policy (`organization_policies`: enabled, allowed models, data-sharing level, BYO key); inputs restricted to fields the invoking principal can read; AI field auto-runs execute as the field's configured base-scoped identity and only read its declared input fields. |
| Q10 | `ai:cache:{hash}` (hash of template version + model + normalized inputs) TTL 24 h for deterministic (temperature 0) calls. |
| Q11 | Invocation metadata (tokens, cost, latency, input hash; prompt/response bodies stored only if org policy allows, 30 days). |
| Q12 | Deleting an AI field cancels pending jobs; values follow field soft-delete rules. |
| Q13 | Restored values are as last generated (no regeneration). |
| Q14 | Generation result is applied only if the input fields' `cell_meta.seq` still match the seq the generation was based on; otherwise re-queued (debounced). |
| Q15 | AI steps in automations; AI field changes can trigger automations. |
| Q16 | Usage counters, billing, audit. |

---

### 2.9 Enterprise & commercial

#### 2.9.1 Enterprise admin

[Observed] Enterprise consoles: user/workspace inventory, audit logs, policy enforcement (sharing, domains, IP restrictions), data retention, admin API. [Ours] `admin` module on the control plane + fan-out reads to shards for inventory; `organization_policies` enforced in the permission compiler and request middleware.

| # | Answer |
|---|---|
| Q1 | Admin console: users (activate/deactivate, transfer ownership), workspaces & bases inventory, policies, audit log search/export, SIEM stream, support access approvals, data residency info. |
| Q2 | `OrganizationPolicy`, `AuditEvent`, `AuditExport`, `SupportAccessGrant`. |
| Q3 | `core.organization_policies`, `core.support_access_grants`, `audit.audit_events`, `audit.audit_exports`, `core.base_directory` (inventory without shard fan-out). |
| Q4 | Org-scoped. |
| Q5 | `GET /v1/admin/orgs/{orgId}/users`, `POST …/users/{userId}:deactivate`, `GET …/bases` (from `base_directory`), `GET/PUT …/policies`, `GET …/audit-events?filter=&cursor=`, `POST …/audit-exports`, `POST …/support-access-grants`. |
| Q6 | Admin app routes; `TQ['admin', orgId, …]`. |
| Q7 | `organization`, `audit` (writer consumes `tabula.audit.v1`), `access`, `auth`. |
| Q8 | Consumes everything security-relevant; emits `grant.changed`, `user.deactivated`. |
| Q9 | `org.manage`, `audit.read`. |
| Q10 | Policies inside perm snapshots (policy change bumps `perm_epoch` on all org bases via fan-out job). |
| Q11 | Audit store with retention up to 7 years (Parquet archive, S3 object lock). |
| Q12 | Policies are versioned rows (history kept). |
| Q13 | Previous policy version can be re-applied. |
| Q14 | Policy edits `If-Match`. |
| Q15 | Policies restrict automations (external webhooks, AI, script execution). |
| Q16 | Every enforcement point. |

#### 2.9.2 SSO (SAML / OIDC)

[Observed] Enterprise SSO via SAML/OIDC with domain enforcement and JIT provisioning. [Ours] BoxyHQ SAML Jackson behind `SsoProvider`; `sso_connections` per org; domain verification via DNS TXT.

| # | Answer |
|---|---|
| Q1 | Admin: configure IdP (metadata URL/XML or OIDC discovery), test connection, enforce SSO for verified domains; users: "Continue with SSO" by email domain. |
| Q2 | `SsoConnection`, `OrganizationDomain`, `UserIdentity` (provider = saml/oidc). |
| Q3 | `core.sso_connections`, `core.organization_domains`, `core.user_identities`, `core.sessions`. |
| Q4 | Org 1→N connections (usually 1); domain → connection. |
| Q5 | `POST /v1/orgs/{orgId}/sso-connections`, `PATCH/DELETE …/{id}`, `POST …/{id}:test`; login: `POST /auth/sso/start {email}` → redirect, `POST /auth/sso/saml/acs`, `GET /auth/sso/oidc/callback`. |
| Q6 | Login page state only. |
| Q7 | `auth` (Jackson as internal service/sidecar), `organization`, `workspace` (JIT membership), `audit`. |
| Q8 | `session.created` (method `sso`), `user.created` (JIT), `member.added`. |
| Q9 | `org.manage` to configure; enforcement blocks password login for users of verified domains (except designated break-glass owners). |
| Q10 | Connection config cached in Jackson + in-process 5 min. |
| Q11 | Control plane; IdP certs and secrets envelope-encrypted. |
| Q12 | Deleting a connection disables enforcement (requires confirmation; break-glass check). |
| Q13 | Re-create. |
| Q14 | `If-Match`. |
| Q15 | None. |
| Q16 | Sessions (`mfa_level`/`auth_method`), domain enforcement. |

#### 2.9.3 SCIM

[Observed] Enterprise IdPs provision/deprovision users and groups via SCIM 2.0. [Ours] In-house SCIM 2.0 server (`/scim/v2`) per org directory token.

| # | Answer |
|---|---|
| Q1 | Admin: generate SCIM token/endpoint, map groups to teams, sync status. |
| Q2 | `ScimDirectory`, `ScimGroupMapping`; acts on `User`, `OrganizationMember`, `Team`. |
| Q3 | `core.scim_directories`, `core.scim_group_mappings`, `core.users`, `core.organization_members`, `core.teams`, `core.team_members`. |
| Q4 | Directory → org; group mapping → team. |
| Q5 | `/scim/v2/Users` (GET/POST/PUT/PATCH/DELETE), `/scim/v2/Groups`, `/scim/v2/ServiceProviderConfig`, `/scim/v2/Schemas`. |
| Q6 | Admin settings only. |
| Q7 | `auth`, `organization`, `workspace`, `access` (grant fan-out on group change), queue `maintenance`. |
| Q8 | `user.created`, `user.updated`, `user.deactivated`, `member.added/removed`, `team.updated`, `grant.changed`. |
| Q9 | Bearer SCIM token (hashed), scoped to one org. |
| Q10 | None. |
| Q11 | Control plane; `externalId` stored on `user_identities`. |
| Q12 | SCIM DELETE / `active=false` → deactivate user, revoke sessions and tokens, keep content ownership (reassign flow for owned resources). |
| Q13 | `active=true` reactivates. |
| Q14 | SCIM PATCH ops applied in order per request; concurrent IdP pushes serialized by row lock on the user. |
| Q15 | None. |
| Q16 | Teams/grants. |

#### 2.9.4 Billing

[Observed] Per-seat plans with limits; usage-based add-ons (automation runs, AI credits). [Ours] Stripe as payment processor; `plans.limits` JSON is the single source of limits; seats derived from billable members; metering via `tabula.usage.v1`.

| # | Answer |
|---|---|
| Q1 | Plan page, upgrade/downgrade, invoices (Stripe portal), seat count, usage meters with thresholds, limit-reached banners. |
| Q2 | `Plan`, `Subscription`, `UsageCounter`, `UsageEvent`. |
| Q3 | `core.plans`, `core.subscriptions`, `core.usage_counters`, `core.usage_events`. |
| Q4 | Org 1→1 active subscription → plan; usage per org per metric per period. |
| Q5 | `GET /v1/orgs/{orgId}/subscription`, `POST …/subscription:checkout` (Stripe Checkout session), `POST …/subscription:portal`, `GET …/usage`; webhook `POST /billing/stripe/webhook`. |
| Q6 | `TQ['subscription', orgId]`, `TQ['usage', orgId]`. |
| Q7 | `billing` (Stripe adapter, entitlement service), usage aggregator consumer, `scheduler` (period rollover). |
| Q8 | `subscription.changed`, `usage.threshold_reached`, `limit.exceeded`. |
| Q9 | `org.billing`. |
| Q10 | Entitlements (plan limits + overrides) cached in-process per org 60 s and embedded in perm snapshot for hot checks (records per base). |
| Q11 | Control plane; Stripe is source of truth for payment state, mirrored via webhooks (idempotent by Stripe event id). |
| Q12 | Cancellation → downgrade to Free at period end; over-limit bases become read-only (not deleted). |
| Q13 | Re-subscribe restores write access. |
| Q14 | Stripe webhook ordering: apply only if `stripe_event.created` ≥ stored `provider_updated_at`. |
| Q15 | Automation run quotas enforced at trigger time (`limit.exceeded` → run `skipped_quota`). |
| Q16 | Entitlement checks everywhere. |

---

### 2.10 Cross-feature matrices

#### 2.10.1 Delete/restore semantics summary

| Object | Delete type | Grouped in `deletion_batches` | Retention | Restore effect on dependents |
|---|---|---|---|---|
| Record | soft | yes (with captured links) | 30 d | links re-inserted, computed recomputed |
| Field | soft (values kept under slot) | yes (+ inverse link field) | 30 d | dependents heal |
| Table | soft | yes (+ inverse link fields in other tables, views) | 30 d | as field + views |
| View | soft | yes | 30 d | share links resume |
| Interface | soft | yes | 30 d | grants unmasked |
| Automation | soft | yes | 30 d | restored **off** |
| Base | soft | yes (base-level batch) | 30 d (Ent ≤ 180) | webhooks resume if cursor valid |
| Workspace | soft | control-plane flag + per-base batches | 30 d (Ent ≤ 180) | all bases back |
| Comment | soft (tombstone) | no | 30 d | n/a |
| Attachment | orphan sweep | no | until unreferenced + retention | n/a |
| Share link / token / webhook sub | hard (revoke) | no | — | not restorable |

#### 2.10.2 Concurrency semantics summary

| Data | Semantics | Mechanism |
|---|---|---|
| Scalar cell | LWW by commit order | `cell_meta[slot].seq`; optional `If-Match` record version |
| Multi-select / multi-collaborator / attachments | Set add/remove commute; order LWW | set ops |
| Links | Set semantics per pair | `record_links` PK uniqueness; `ON CONFLICT DO NOTHING` |
| Rich long text (V1) | CRDT merge | Yjs doc in `record_rich_docs` |
| Schema (fields/tables) | Serialized per base | `base_runtime` row lock, `schema_version` |
| View config | Top-level key merge + `version` | server-side merge, 409 on same key with stale version (API) |
| Interface draft | Element-level merge | page `version` + element ids |
| Automation draft | Whole-draft `If-Match` | single-editor presence |

#### 2.10.3 Event → consumer matrix (selected)

| Event | Realtime | Automations | Webhooks | Search | Notifications | Audit | Usage | AI | Contacts |
|---|---|---|---|---|---|---|---|---|---|
| `record.created/updated/deleted` | via `base_changes` | ✓ | via `base_changes` | ✓ | — | Ent (sampled field-level) | — | ✓ (AI field inputs) | ✓ (directory) |
| `field.*`, `table.*` | via `base_changes` | config validation | ✓ | ✓ | — | ✓ | — | — | — |
| `comment.created`, `mention.created` | ✓ | ✓ (V1) | — | ✓ (V1) | ✓ | — | — | — | ✓ |
| `form.submitted` | — | ✓ | — | — | — | — | ✓ | — | — |
| `automation.failed` | editors | — | — | — | ✓ | — | — | — | — |
| `grant.changed` | perm refresh | — | — | access cache | ✓ (invite) | ✓ | seats | — | — |
| `ai.invocation_completed` | — | — | — | — | — | — | ✓ | — | — |

---

## 3. What we should NOT copy (Part 57)

### 3.1 The three-tier distinction

| Tier | What it is | How we use it | Example |
|---|---|---|---|
| **Publicly observable behavior** [Observed] | What any user/developer can see: UI behaviors, documented API capabilities, published limits, marketing | Defines the *capability bar* and user expectations (e.g., "a link field creates an inverse field") | "Deleting a record removes it from linked cells and it can be restored from trash." |
| **Reasonable inference** [Inferred] | Plausible engineering explanations of observed behavior | Informs risk assessment; never cited as fact about a vendor | "Per-base write ordering suggests a single ordered change stream per base." |
| **Our architecture** [Ours] | What we design and build | Everything normative in this document set | `base_changes` with `base_runtime.change_seq` |

Rules for authors:

1. Capability statements may cite observed behavior; **design** statements must be [Ours] and justified on their own merits (tradeoffs), not "because vendor X does it".
2. No reverse engineering of private endpoints, client bundles, or network traffic of any vendor product. Public docs only.
3. No vendor screenshots, icons, color schemes or copy in our design system or docs.
4. When an [Observed] limit is used as a target, re-derive our number from our own cost model (spine §12 is ours, not a copy).

### 3.2 Areas to avoid and what we do instead

| Area | Do NOT | Do instead [Ours] |
|---|---|---|
| **Formula function catalog** | Replicate another product's full function list, exact function names en masse, argument orders, quirks, or error strings; re-implement their semantics bug-for-bug | Own catalog designed from first principles and common spreadsheet conventions (generic, widely shared names such as `SUM`, `IF`, `CONCAT` are industry-standard and fine); our own error codes (`#TYPE!`, `#REF!` style is generic spreadsheet convention — our error *codes* are `FORMULA_TYPE_MISMATCH` etc.); documented in [`08`](./08-formula-engine.md). A **migration translator** for imported formulas maps foreign syntax to ours where possible and flags the rest. |
| **Formula implementations** | Port proprietary implementations or test vectors | Our own implementation + property-based tests against our spec |
| **UI artwork & layout** | Copy iconography, color palettes, illustrations, exact layout grids, empty-state art, onboarding flows, sound/animation signatures | Own design system ([`24`](./24-frontend-grid-state-design-system.md)); grid conventions common to all spreadsheets (rows, columns, frozen first column) are generic |
| **Internal ID formats** | Mimic another vendor's ID shapes (prefix + 14 chars etc.) | UUIDv7 + our prefix table + base62 (spine §3) |
| **API shapes** | Copy endpoint paths, request/response JSON verbatim, error envelopes, pagination tokens, webhook payload shapes | Our REST design: `/v1/bases/{baseId}/tables/{tableId}/records`, `:query`/`:batch` custom methods, RFC 9457 errors, our webhook cursor protocol ([`17`](./17-api-architecture.md), [`31`](./31-api-specification.md)). A separate *compatibility adapter* for migrating customers is explicitly **out of scope** unless legal approves. |
| **Field type keys** | Reuse another product's camelCase type identifiers | Our snake_case keys (spine §4) |
| **Branded terminology** | Use competitors' product names for features as our product names | Internal entity names stay canonical (`interface`, `sync_source`, `automation`); product-facing labels are a branding decision. Proposed labels: interfaces → **"Apps"** (pages within an App); sync sources → **"Connected tables"**; extension/script blocks → **"Scripts"**; AI assistant → our own brand name (TBD by marketing). Generic nouns (table, field, record, view, form, automation, workspace) are industry-generic and fine. "Base" is common in the category; marketing to confirm with legal (fallback: "Database"). |
| **Templates & sample content** | Copy template gallery content, sample datasets, help-center text | Own templates authored in-house |
| **Plan structure & pricing copy** | Mirror tier names, exact limit numbers or packaging copy | Our tiers (Free/Team/Business/Enterprise are generic) and our numbers derived from cost model |
| **Keyboard shortcuts** | Replicate an idiosyncratic full shortcut map | Platform-standard shortcuts (copy/paste/undo/arrow navigation are universal); our own map for the rest |
| **Error messages & UX copy** | Copy wording | Own content style guide |

### 3.3 Where we deliberately differ (not just "not copying")

| Topic | Common observed pattern [Observed] | Our choice [Ours] | Why |
|---|---|---|---|
| Field referencing in formulas | Formulas reference fields by name | Stored by field ID, rendered by name | Rename-safe without rewrite; diff-friendly |
| Select values in API | Values often addressed by label | Option IDs canonical, labels accepted as convenience | O(1) renames, no ambiguity |
| Webhooks | Notification-then-fetch | Same pattern (generic), but our cursor is the per-base `seq` shared with realtime and undo | One ordered log, fewer moving parts |
| Contacts | Often modeled as just another table | First-class workspace contact directory with identity resolution and merge/unmerge | Shared people data across bases without duplication |
| Undo | Client-side command stacks | Server-side inverse ops with conflict-aware undo | Works across tabs/devices; safe with concurrent edits |
| Public GraphQL | Some platforms offer it | Not offered (ADR) | Cost-control & permission complexity; REST + query AST suffices |

