# 33 — Architecture Decision Records

> **Status:** Proposed for approval · **Owner:** Platform Architecture · **Date:** 2026-10-03
> These ADRs are the long form of decisions D1–D26 in [`00-canonical-decisions.md`](./00-canonical-decisions.md). If an ADR and the spine ever disagree, the spine wins and the ADR is corrected. New ADRs are appended with the next number; superseded ADRs keep their number with status `Superseded by ADR-NNN`.

**Sections covered**

* **Section 60 — Architecture Decision Records:** template, index, and ADR-001 … ADR-031 covering architecture style, database, plane split & sharding, multi-tenancy, identifiers, record storage, field-type engine, formula engine, computed materialization, linked records, backend stack, query builder, frontend, grid, state management, search, jobs, event bus, outbox relay, realtime, undo, file storage, authentication, authorization, API style, deployment, script sandbox, AI provider abstraction, observability, event sourcing, contract testing.

---

## 60.1 Template

```
## ADR-NNN — Title
Status: Proposed | Accepted | Superseded by ADR-XXX | Deprecated   ·  Date  ·  Deciders  ·  Spine ref (Dn)
### Context        — forces, requirements, constraints (with numbers where possible)
### Decision       — what we do, precisely
### Alternatives considered — each with why rejected
### Consequences   — Positive / Negative (and how negatives are mitigated)
### Revisit triggers — measurable conditions that reopen the decision
```

Statuses below are **Proposed**; they become **Accepted** at the Phase 0 architecture review (29 §54.4 Phase 0 DoD).

## 60.2 Index

| ADR | Title | Spine |
|---|---|---|
| 001 | Modular monolith with process roles | D1 |
| 002 | PostgreSQL as primary database | D2 |
| 003 | Control/data plane split with workspace-affinity sharding | D2, D3 |
| 004 | Shared-schema multi-tenancy with RLS | D4 |
| 005 | UUIDv7 keys and prefixed public IDs | D5 |
| 006 | Hybrid record storage (JSONB cells by slot + normalized links + typed sidecars) | D6 |
| 007 | Field types as plugins in a registry | D6, §4 |
| 008 | Own formula language with Pratt parser, isomorphic engine | D8 |
| 009 | Materialized computed fields with dependency-graph propagation | D7 |
| 010 | Linked records in a single normalized pair table | D6 |
| 011 | TypeScript / Node.js / Fastify backend | D17 |
| 012 | Kysely as query builder | D17 |
| 013 | React + Vite SPA | D18 |
| 014 | Custom canvas grid | D18 |
| 015 | Client state: TanStack Query + custom RecordStore + Zustand | D18 |
| 016 | Search: Postgres FTS → OpenSearch | D14 |
| 017 | Jobs: BullMQ with Postgres durable state | D12 |
| 018 | Event bus: Kafka API (MSK/Redpanda) | D11 |
| 019 | Outbox relay via logical replication | D11 |
| 020 | Realtime: server-authoritative ops with cell-level LWW | D9 |
| 021 | Undo via command log with inverse ops | D25 |
| 022 | File storage: S3 + presigned uploads + scan pipeline | D15 |
| 023 | Authentication: in-house core + SAML Jackson | D19 |
| 024 | Authorization: RBAC + deny restrictions compiled to snapshots | D20 |
| 025 | Public API: REST, no public GraphQL | D16 |
| 026 | Deployment: AWS, ECS for MVP → EKS from V1 | D23 |
| 027 | Automation script sandbox: isolated-vm pool | D21 |
| 028 | AI provider abstraction and gateway | D22 |
| 029 | Observability: OpenTelemetry + Grafana stack | D24 |
| 030 | No event sourcing as system of record | D26 |
| 031 | Contract testing via OpenAPI (no Pact) | 28 §52.3 |

---

## ADR-001 — Modular monolith with process roles

Status: Proposed · 2026-10-03 · Deciders: Principal Eng, EM, Platform lead · Spine: D1

### Context
A team of 10–14 engineers must deliver a product with ~20 tightly coupled subsystems (records, fields, formulas, compute, permissions, realtime, automations…). Most user mutations touch several of them **in one transaction** (record write → compute → change log → outbox → permission checks). Workload profiles differ sharply: request/response API, long-lived WebSockets, CPU-heavy compute, sandboxed scripts, logical-replication readers.

### Decision
One TypeScript codebase organized as **modules with enforced boundaries** (each module exposes a `public` entry; ESLint `boundaries` + dependency-cruiser rules forbid deep imports and cross-module DB table access). One container image deployed as **process roles** (`api`, `realtime`, `worker --queues=…`, `scheduler`, `relay`) plus a separate `sandbox` image. Modules communicate in-process via service interfaces inside a transaction, and asynchronously via domain events. Extraction candidates (realtime gateway, file processing, search indexer, AI gateway, automation runner) are designed with message-based seams so they can be split out.

### Alternatives considered
* **Microservices from day one** — rejected: distributed transactions across record/compute/outbox would require sagas for what is a single ACID write; operational overhead (service mesh, per-service pipelines) is unaffordable for 12 engineers; boundaries are not yet known well enough to cut correctly.
* **Classic unstructured monolith** — rejected: no enforcement of boundaries leads to "everything imports everything", making later extraction impossible.
* **Serverless functions (Lambda)** — rejected: WebSockets, long-running imports, connection pooling to Postgres, and cold starts on the hot write path.

### Consequences
* ➕ Single transaction for core writes; one deploy; shared types; fast refactoring; per-role scaling still possible.
* ➕ Process roles give isolation of failure domains (a stuck worker doesn't take down the API).
* ➖ Risk of boundary erosion — mitigated by lint rules in CI and module ownership in CODEOWNERS.
* ➖ One bad dependency upgrade affects all roles — mitigated by canary deploys per role.

### Revisit triggers
* A module needs an independent release cadence or language (e.g., Rust for compute) — extract it.
* Build/test time for the monorepo exceeds PR budget despite affected-test selection.
* Team grows beyond ~40 engineers / 6+ squads.

---

## ADR-002 — PostgreSQL as primary database

Status: Proposed · Spine: D2

### Context
We need: ACID multi-row transactions (record + links + change log + outbox), flexible per-table schemas defined by users, rich indexing (B-tree, GIN on JSONB, trigram), row-level security, logical replication for CDC, mature managed offerings, and engineers who know it. Data volume per workspace is bounded (≤ 2M records/base standard, 10M on dedicated), total volume grows by adding shards.

### Decision
**PostgreSQL 16+** (RDS PostgreSQL; Aurora PostgreSQL acceptable where its logical replication & failover characteristics are verified by spike S-04) for control plane, data plane shards and the audit hot store.

### Alternatives considered
* **MongoDB** — flexible documents fit records, but: multi-document transactions are costlier and less battle-tested at our write shape; no RLS equivalent; relational features (links, joins for rollups, constraints) would be rebuilt in the app; change streams are good, but we'd lose SQL's planner for user-defined filters.
* **DynamoDB** — excellent scale and ops, but no ad-hoc querying: every user-defined filter/sort/group would need precomputed indexes or a secondary query engine; 400 KB item limit; transactions limited to 100 items (batch writes of 1000 records, link fan-out). Rejected.
* **CockroachDB / Spanner** — distributed SQL removes our sharding layer, but: higher per-transaction latency (consensus on every write), the hot per-base `change_seq` counter becomes a cross-range contention point, logical replication/CDC semantics differ, cost is higher, and our tenancy model already gives natural shard boundaries. Rejected for now; see revisit.
* **MySQL** — viable, but weaker JSON indexing (no GIN on JSON), no RLS, less expressive partial/expression indexes, logical decoding via binlog is fine but our team is stronger in PG. Rejected.

### Consequences
* ➕ One technology for transactional, JSONB, FTS (MVP), CDC, RLS.
* ➕ Partitioning (hash by `table_id`, time-based for logs) built in.
* ➖ Vertical limits per shard → requires our own sharding (ADR-003).
* ➖ JSONB filter performance on very large tables needs sidecars (ADR-006); vacuum tuning for hot rows (`base_runtime`).

### Revisit triggers
* Shard count > 200 and operational toil of shard management exceeds 1 FTE → re-evaluate distributed SQL.
* A single workspace needs > 1 shard's write throughput (current cap estimate: ~5k writes/s sustained).

---

## ADR-003 — Control/data plane split with workspace-affinity sharding

Status: Proposed · Spine: D2, D3

### Context
Global entities (users, orgs, billing, grants, routing) need a single source of truth; base content (records, links, revisions) dominates volume and must scale horizontally. Most operations are within a workspace (links, lookups, automations, contact directory all workspace-local). Enterprise customers want isolation and residency.

### Decision
* **Control plane:** one Postgres cluster (schema `core`) + read replicas.
* **Data plane:** N Postgres clusters ("cells", schema `data`), each hosting many workspaces. **Shard key = workspace**: all bases and the contact directory of a workspace live on one shard. Routing via `core.workspace_directory` and `core.base_directory`, cached in-process + Redis with versioned entries.
* No cross-plane joins; cross-plane consistency via events and idempotent reconciliation.
* Online **workspace move** tool: snapshot copy → logical-replication catch-up filtered by `workspace_id` → brief write freeze (≤ 5 s) → routing flip → cleanup.
* Enterprise: dedicated shard per org; residency = shards in-region.

### Alternatives considered
* **Citus (distributed Postgres)** — transparent sharding by `workspace_id` with co-location is attractive, but: managed availability on AWS is limited (Azure-centric), RLS + distributed tables have caveats, logical replication from workers is complex, and we'd still need app awareness of distribution columns. Rejected; revisit if a managed Citus on AWS matures.
* **Database per base** — strong isolation, but tens of thousands of databases, connection pooling nightmares, migrations across 100k DBs, and cross-base features (sync, workspace contact directory) broken. Rejected.
* **Shard by base** — better balance but breaks workspace-local features (contact directory links across bases of a workspace, workspace-level automations) and complicates moves. Rejected.
* **Single big cluster + read replicas** — simplest; hits write ceiling and blast radius limits within ~2 years of growth. Rejected (but MVP runs exactly this topology logically: one shard).

### Consequences
* ➕ Linear scale by adding shards; blast-radius containment; dedicated shards & residency for free.
* ➖ Hot/huge workspaces can outgrow a shard → dedicated shard, then per-base split (future ADR) as last resort.
* ➖ Routing layer & move tool are critical infrastructure — spike S-12 and chaos tests.
* ➖ Cross-workspace features (global search, notifications) are control-plane or event-driven.

### Revisit triggers
* A single workspace exceeds 50% of a dedicated shard's capacity.
* Workspace move freeze consistently > 10 s.

---

## ADR-004 — Shared-schema multi-tenancy with Postgres RLS

Status: Proposed · Spine: D4

### Context
Tens of thousands of small tenants per shard; isolation failures are existential.

### Decision
Shared schema; every data-plane row carries `workspace_id`; **RLS policies** on every tenant table using `current_setting('app.workspace_id', true)::uuid`; the app connects as `tabula_app` (`NOBYPASSRLS`, not owner); each transaction runs `SET LOCAL app.workspace_id` via `withTenant()`. Application-level authorization remains primary (ADR-024); RLS is defense in depth. Automated RLS coverage tests (28 §52.6.2). Enterprise: dedicated shard + dedicated KMS key.

### Alternatives considered
* **Schema per tenant** — catalog bloat with 10k+ schemas per shard, slow migrations, pooler issues. Rejected.
* **Database per tenant** — see ADR-003. Rejected except dedicated shards.
* **App-only checks without RLS** — one missed `WHERE workspace_id` = breach. Rejected.

### Consequences
* ➕ Efficient packing; one migration per shard.
* ➖ RLS adds planner overhead (small; policies are simple equality on indexed column) and requires transaction-scoped settings compatible with PgBouncer transaction pooling (we use `SET LOCAL` inside explicit transactions only).
* ➖ Cross-workspace maintenance jobs need a separate privileged role with audited use.

### Revisit triggers
* RLS overhead > 5% on hot queries (benchmark S-01).
* Regulatory demand for physical isolation beyond dedicated shards.

---

## ADR-005 — UUIDv7 keys and type-prefixed public IDs

Status: Proposed · Spine: D5

### Context
IDs must exist before insert (outbox, idempotency, client-generated optimistic records), be index-friendly, globally unique across shards (workspace moves), and public IDs must be self-describing and not leak counts.

### Decision
UUIDv7 generated in the application; stored as `uuid`; public form `prefix_base62` (22 chars). Decoding validates prefix ↔ resource type.

### Alternatives considered
* **bigint sequences** — not globally unique across shards; leaks volume; can't pre-generate client-side. Rejected.
* **UUIDv4** — random inserts fragment B-trees on large tables. Rejected.
* **Snowflake/KSUID** — need coordination (worker IDs) or are non-standard types. Rejected.
* **Exposing raw UUIDs** — not self-describing; prefix helps support/debugging and prevents cross-type confusion. Rejected.

### Consequences
* ➕ Time-ordered locality; IDs creatable on client for optimistic creates (server validates time skew bound ±5 min).
* ➖ 16-byte keys (vs 8) increase index size ~15–20%.

### Revisit triggers
* None expected; PG18 native `uuidv7()` may replace the extension fallback.

---

## ADR-006 — Hybrid record storage

Status: Proposed · Spine: D6

### Context
Users define tables and fields at runtime (up to 500 fields, 500 tables/base); schema changes are frequent and must be instant; filtering/sorting must be fast on up to 2M+ records; computed values must be filterable.

### Decision
`records` table hash-partitioned by `table_id` with `cells jsonb` keyed by **field slot**, `computed jsonb`, `cell_meta jsonb`; links in `record_links`; **typed index sidecars** (`record_index_num/text/time`) maintained on write for fields used in filters/sorts on tables above `INDEX_SIDECAR_THRESHOLD`. No per-user-table DDL.

### Alternatives considered
* **Dynamic DDL (real table per user table, column per field)** — best query performance, but: schema changes take locks and rewrites, migrations across millions of user tables, catalog bloat, RLS policies per table, and type conversion = `ALTER COLUMN TYPE` rewrite. Rejected.
* **EAV (one row per cell)** — trivial schema evolution, but 500× row amplification, record reads need pivots, filters become self-joins. Rejected.
* **Pure JSONB without sidecars** — simplest; GIN supports containment but not range/sort efficiently on large tables. Rejected for large tables; kept as small-table path.
* **Columnar/analytics store for views** — great scans, poor point updates/realtime. Rejected (may be added for reporting later).

### Consequences
* ➕ Instant field add/rename/delete; record read = one row.
* ➖ Sidecar maintenance write amplification (only for indexed fields on large tables); equivalence of filter paths must be property-tested (28 §52.6.6).
* ➖ Large rows: TOAST behavior and full-row rewrite on each update — mitigated by row budget (2 MB) and HOT-friendly fillfactor.

### Revisit triggers
* Spike S-01 shows JSONB filter p95 > 250 ms at 1M rows/partition even with sidecars.
* Write amplification from `cells` rewrite exceeds 3× logical change volume on hot tables.

---

## ADR-007 — Field types as plugins in a registry

Status: Proposed · Spine: §4

### Context
~30 field types, each affecting validation, storage, rendering, filtering, sorting, search, import/export, formula typing, conversion and AI.

### Decision
`FieldTypeDefinition` interface in `@tabula/fields` (isomorphic core + server-only and client-only extension points): `configSchema`, `validate`, `normalize`, `parseInput`, `format`, `isEmpty`, `compare`, `toSortKey`, `toSidecar`, `filterOperators` (+ SQL & memory implementations), `toSearchText`, `toCsv/fromCsv`, `formulaType`, `conversions`, `storage` (`cells|computed|links|record_column|none`), renderers/editors on the client. A shared conformance suite gates registration.

### Alternatives considered
* **Switch statements per subsystem** — fast to start, unmanageable at 30 types × 15 subsystems. Rejected.
* **Fully dynamic third-party field types (marketplace)** — security and correctness risk; not needed. Rejected (registry is internal-only).

### Consequences
* ➕ Adding a type is a single package with a checklist enforced by tests.
* ➖ Interface is wide; changes ripple to all plugins — mitigated by default implementations and versioned interface.

### Revisit triggers
* Need for customer-defined field types (extensions platform).

---

## ADR-008 — Own formula language, Pratt parser, isomorphic engine

Status: Proposed · Spine: D8

### Context
Formulas must be fast (evaluated per record on write), safe (no arbitrary code), typed (to drive formatting, filtering, sorting), produce identical results on client (preview) and server (authoritative), and support our field references `{Field Name}` stored as field IDs.

### Decision
Hand-written lexer + **Pratt parser** → AST → type checker → compiled JS closures; function library implemented by us; same package runs in browser and Node. Limits: `MAX_FORMULA_DEPTH` 64, result size caps, regex with linear-time engine.

### Alternatives considered
* **ANTLR** — robust grammar tooling, but generated JS runtime is heavy for the client bundle, error recovery/messages are harder to make friendly, and Pratt is simple for an expression language. Rejected.
* **Chevrotain** — good TS parser toolkit; viable. Rejected narrowly: a ~600-line Pratt parser gives us full control of error spans/recovery for the editor and zero dependency risk; we may use Chevrotain if grammar grows (statements, lambdas).
* **HyperFormula / reuse spreadsheet engines** — designed for A1-cell-reference spreadsheets with a recalculation graph over cells, GPLv3/commercial licensing, semantics (implicit intersection, Excel quirks) not matching record-oriented formulas; integrating our typed field references and link-based lookups would fight the engine. Rejected.
* **Embedding JS (`new Function`) or expression libs (expr-eval, mathjs)** — security (sandboxing user JS on the write path), weak typing, inconsistent semantics. Rejected.

### Consequences
* ➕ Full control over semantics, errors, performance, and isomorphism.
* ➖ We own ~120 function implementations and their edge cases — mitigated by golden tests and client/server equivalence properties.

### Revisit triggers
* Grammar extension to statements/lambdas → consider Chevrotain.
* Formula evaluation becomes a CPU bottleneck → compile to WASM / move compute to a Rust worker.

---

## ADR-009 — Materialized computed fields with dependency-graph propagation

Status: Proposed · Spine: D7

### Context
Computed fields (formula, lookup, rollup, count, AI) must be filterable, sortable, searchable, exportable and fast on large tables, and must update across links.

### Decision
Materialize into `records.computed`. Field-level dependency graph in `field_dependencies`; same-record recompute synchronous; cross-record propagation synchronous when fan-out ≤ `COMPUTE_SYNC_FANOUT_LIMIT` (500), otherwise deferred via `compute` queue with `computed_stale` markers; volatile functions by scheduled buckets.

### Alternatives considered
* **Compute on read** — no write amplification, always fresh, but filters/sorts on computed fields require evaluating every record per query (no index), lookups/rollups require joins over links on every read; unworkable at 100k+ rows. Rejected.
* **Hybrid: compute on read for same-record formulas, materialize only cross-record** — saves storage but complicates the filter compiler (two code paths) and still requires indexing. Rejected; we may skip materializing trivially cheap formulas not used in filters as an optimization later.
* **Async-only materialization** — simpler writes but users see stale values after every edit. Rejected.

### Consequences
* ➕ Reads and queries are cheap; computed fields behave like stored ones for filters/sidecars.
* ➖ Write amplification and staleness windows for large fan-outs (UI shows stale indicators).
* ➖ Correctness risk in incremental propagation — mitigated by "incremental == full recompute" model tests and a nightly sampling verifier in production (recompute 0.1% of records, alert on mismatch).

### Revisit triggers
* Deferred staleness p95 > 60 s in production; or `computed` writes > 50% of shard WAL.

---

## ADR-010 — Linked records in a single normalized pair table

Status: Proposed · Spine: D6

### Context
Bidirectional links with an inverse field on the other table; up to 100k+ links per record; order per side; concurrent add/remove.

### Decision
`link_relations` (one row per bidirectional relation) and `record_links (relation_id, a_record_id, b_record_id, a_order, b_order)`, hash-partitioned by `relation_id`, one row per pair. Set-semantics realtime ops.

### Alternatives considered
* **Arrays of record IDs in both records' cells** — two writes per link, divergence risk, 100k-element arrays rewritten on each change. Rejected.
* **Graph database** — operational overhead, no transactional coupling with records. Rejected.
* **Separate row per side** — doubles storage and invites asymmetry. Rejected.

### Consequences
* ➕ Symmetry by construction; O(1) add/remove; index-backed traversal both ways.
* ➖ Self-relations require care (`a` and `b` both same table); per-side ordering needs two fractional keys.

### Revisit triggers
* Partition hot-spotting on a single relation with > 50M pairs.

---

## ADR-011 — TypeScript / Node.js 22 / Fastify backend

Status: Proposed · Spine: D17

### Context
Isomorphic code is a core requirement (formula engine, filter evaluator, field types, permission evaluator shared by client and server). Team hiring pool. I/O-heavy workload with some CPU (compute, formulas).

### Decision
Node.js 22 LTS, TypeScript strict, Fastify (schema-first, fast, plugin model), Zod internally, TypeBox for OpenAPI, pino, OpenTelemetry. CPU-heavy work (compute fan-out, imports) runs in worker roles; `worker_threads` for formula batch evaluation where needed.

### Alternatives considered
* **Go** — excellent performance and concurrency; loses isomorphism (would need two formula/filter implementations kept equivalent — exactly our riskiest bug class). Rejected.
* **Kotlin/JVM (Spring/Ktor)** — strong typing and performance; same isomorphism problem (Kotlin/JS possible but immature for our needs). Rejected.
* **Elixir/Phoenix** — superb for realtime/presence; isomorphism lost, smaller hiring pool, dynamic SQL tooling weaker. Rejected; Phoenix-style channel ideas inform our gateway.
* **Ruby on Rails** — productivity, but performance for realtime and compute, and no isomorphism. Rejected.
* **NestJS on Node** — heavier DI/decorator framework; we prefer explicit composition with Fastify. Rejected.

### Consequences
* ➕ One language end-to-end; shared packages; large talent pool.
* ➖ Single-threaded event loop: CPU spikes hurt latency — mitigated by role separation, worker threads, event-loop lag SLOs.
* ➖ Memory per process higher than Go.

### Revisit triggers
* Compute/formula CPU > 40% of worker fleet cost → Rust/WASM module for compute.
* Realtime gateway at > 200k concurrent connections per region → consider extracting to Go/Elixir.

---

## ADR-012 — Kysely as query builder

Status: Proposed · Spine: D17

### Context
Core queries are **dynamic** (user-defined filters/sorts compiled to SQL with JSONB paths, sidecar joins, keyset cursors), require precise control of SQL, locks (`FOR UPDATE`, `SKIP LOCKED`), CTEs, and partition-aware statements. Type safety for static tables is still valuable.

### Decision
**Kysely** for all SQL, with generated table types (`kysely-codegen` from migrations), raw `sql` template tags for compiler output (parameterized only), migrations as plain SQL files.

### Alternatives considered
* **Prisma** — great DX for CRUD, but dynamic SQL needs raw queries (losing types), weaker control of locking/CTEs, query engine sidecar, migration tooling conflicts with expand/contract on partitioned tables. Rejected.
* **Drizzle** — close second: typed, SQL-like; rejected narrowly due to Kysely's more mature dynamic query composition and plugin ecosystem at decision time; revisit is cheap.
* **TypeORM** — active-record/decorators, inconsistent typing, historical bugs. Rejected.
* **Raw `pg` only** — maximum control, no types. Rejected (Kysely is a thin layer over it).

### Consequences
* ➕ Typed composition, transparent SQL, easy to log/explain.
* ➖ No ORM features (relations, identity map) — intentional.

### Revisit triggers
* Kysely maintenance stalls (bus factor) → Drizzle migration path (similar mental model).

---

## ADR-013 — React + Vite SPA

Status: Proposed · Spine: D18

### Context
App is fully authenticated, highly interactive, long-lived sessions, heavy client state; SEO irrelevant inside the app; public forms/shared views need fast first load.

### Decision
React 19 + TypeScript + Vite SPA with TanStack Router; separate lightweight bundle for public forms/shared views; marketing site separate (Astro/Next.js).

### Alternatives considered
* **Next.js (App Router, SSR/RSC)** — benefits (SEO, streaming) mostly irrelevant behind auth; RSC complicates realtime/global client stores; server infra for SSR adds cost/latency to every navigation. Rejected for the app.
* **SvelteKit/Solid** — strong performance; smaller ecosystem for complex editors/a11y primitives, hiring. Rejected.
* **Angular** — heavier, smaller talent overlap with our stack. Rejected.

### Consequences
* ➕ Simple static hosting on CloudFront; fast dev loop; full control.
* ➖ First load of large SPA — mitigated by route-level code splitting and budgets (initial ≤ 350 kB gz).

### Revisit triggers
* Public-facing surfaces (shared interfaces, portals) need SEO → SSR for that bundle only.

---

## ADR-014 — Custom canvas grid

Status: Proposed · Spine: D18

### Context
Grid must handle 1M-row tables (windowed fetch), 500 fields, 60 fps scrolling, custom renderers for 30 field types, realtime cell flashes, selection/fill/paste, frozen columns, grouping, and a11y.

### Decision
Own **canvas-rendered grid** (prior art: Glide Data Grid, MIT) with a DOM overlay for editors and an **offscreen ARIA grid mirror** for accessibility; data via RecordStore windows (200 rows, ±2 prefetch).

### Alternatives considered
* **AG Grid (Enterprise)** — feature-rich, but DOM-based virtualization struggles at 500 columns × fast scroll; license cost per developer; deep customization of rendering/realtime and grouping semantics fights the framework. Rejected.
* **Glide Data Grid directly** — closest fit; MIT; we'd fork anyway for grouping, realtime flashes, our selection model, and a11y. Decision: own implementation borrowing ideas; **fallback = fork Glide** if spike S-07 fails.
* **DOM virtualization (TanStack Virtual)** — simpler a11y, but per-cell DOM cost limits width/fps. Rejected for the main grid; used for list views and interfaces.

### Consequences
* ➕ Performance ceiling and full control.
* ➖ A11y is harder (custom mirror), text rendering/IME edge cases, high build cost (≈ 2 engineers × 5 months).

### Revisit triggers
* Spike S-07/S-08 fails fps or a11y targets → fork Glide.

---

## ADR-015 — Client state: TanStack Query + custom RecordStore + Zustand

Status: Proposed · Spine: D18

### Context
Metadata (bases, schema, views) is request/response-shaped; record data is huge, windowed, and mutated by realtime ops and optimistic local ops; UI state is local.

### Decision
TanStack Query for metadata/server state; **custom normalized RecordStore** (`useSyncExternalStore`, per-table maps, window index, pending-op queue with rebase on server ops) for records; Zustand for UI state.

### Alternatives considered
* **Redux Toolkit for everything** — workable but heavy for windowed data and per-cell subscriptions; RTK Query not built for op streams. Rejected.
* **TanStack Query for records** — cache keyed by query, not by entity; realtime op application across many queries and optimistic rebase become awkward. Rejected.
* **Replicache/Zero/Electric (sync engines)** — attractive, but impose their own server protocol/storage that conflicts with our server-authoritative change log and permission masking. Rejected (ideas borrowed).
* **MobX** — fine-grained reactivity; less explicit data flow. Rejected.

### Consequences
* ➕ Precise control over memory and re-render granularity.
* ➖ We own a sync client — mitigated by model-based tests (28 §52.6.12).

### Revisit triggers
* Offline-first requirement emerges → reconsider sync engines.

---

## ADR-016 — Search: Postgres FTS (MVP) → OpenSearch (V1)

Status: Proposed · Spine: D14

### Context
Global search across records/tables/bases/contacts with permission filtering; MVP volume modest; V1 needs relevance, typo tolerance, scale, and offload from OLTP shards.

### Decision
MVP: `search_documents` with `tsvector` + `pg_trgm` per shard. V1: **OpenSearch** fed from the event log, per-shard indices, permission filtering by accessible base IDs + visible field slots at query time. `SearchBackend` abstraction.

### Alternatives considered
* **Elasticsearch (Elastic Cloud)** — equivalent capability; license (SSPL/ELv2/AGPL) and AWS integration favor OpenSearch Service. Rejected.
* **Meilisearch / Typesense** — great typo tolerance and DX; weaker at our multi-tenant scale (index-per-tenant or filter-heavy), fewer managed AWS options, aggregations less mature. Rejected.
* **Postgres FTS forever** — loads OLTP shards; weak relevance/typo tolerance. Rejected beyond MVP.

### Consequences
* ➕ Cheap MVP; scalable V1.
* ➖ Eventual consistency (index lag) — UI hints + DB fallback for exact primary match.

### Revisit triggers
* Vector/semantic search needs → OpenSearch k-NN or pgvector evaluation.

---

## ADR-017 — Jobs: BullMQ with Postgres durable state

Status: Proposed · Spine: D12

### Context
Many job types (compute, automation steps, webhooks, email, file processing, imports). Durability and auditability matter for automations/webhooks; throughput matters for compute.

### Decision
BullMQ on dedicated Redis (AOF) for execution; **durable state in Postgres** (`automation_runs`, `webhook_deliveries`, `long_operations`…); reconciler re-enqueues rows stuck past lease. Per-queue worker pools; group-based fairness per workspace.

### Alternatives considered
* **Temporal** — excellent durable workflows (automations are workflows), but: another critical stateful cluster to operate (or Temporal Cloud cost), determinism constraints on workflow code, and our step model is simple (linear/branching with retries). Deferred; revisit trigger below.
* **SQS** — durable, managed; no priorities/rate limiting/groups as rich as BullMQ; delay ≤ 15 min; local dev parity worse. Rejected (could back the same interface later).
* **RabbitMQ** — mature; operations burden; no advantage over BullMQ for our patterns. Rejected.
* **Postgres-only queue (pg-boss/graphile-worker)** — attractive simplicity, but high-throughput queues (compute, webhooks) would load OLTP shards. Rejected for hot queues; acceptable for low-volume maintenance jobs.

### Consequences
* ➕ Fast, feature-rich queues; Postgres as truth makes Redis loss survivable.
* ➖ Two sources (Redis + PG) must be reconciled — reconciler is critical code with tests (E190).

### Revisit triggers
* Automations add long-running human-in-the-loop waits, complex compensation, or > 1M runs/day with versioned workflow code → adopt Temporal for the automation runner.

---

## ADR-018 — Event bus: Kafka API (MSK / Redpanda)

Status: Proposed · Spine: D11

### Context
Many consumers (realtime fan-out, automations, webhooks, search, audit, usage, notifications, AI) need ordered-per-base, replayable, durable streams with independent consumer groups.

### Decision
Kafka API (Amazon MSK or Redpanda) from V1, topics per spine §7, keyed by `base_id`/`workspace_id`/`org_id`. MVP profile: relay dispatches directly into BullMQ via the same `EventBus` interface.

### Alternatives considered
* **NATS JetStream** — lighter ops, good performance; smaller managed ecosystem on AWS, less mature tooling for long retention/replay and connectors. Rejected (viable alternative).
* **SNS/SQS fan-out** — managed, but ordering only via FIFO with throughput limits, no replay, per-consumer queues to manage. Rejected.
* **Kinesis** — ordering per shard key, replay; awkward consumer scaling and shard limits; less portable. Rejected.
* **Redis Streams** — cheap, but durability/retention not suited to audit/replay at scale. Rejected.

### Consequences
* ➕ Replay, independent consumers, high throughput, standard ecosystem.
* ➖ Operational cost/complexity — deferred to V1 via the MVP profile.

### Revisit triggers
* Event volume < 1k/s at V1 GA and MSK cost dominates → stay on MVP profile longer.

---

## ADR-019 — Outbox relay via Postgres logical replication

Status: Proposed · Spine: D11

### Context
Events must be published **iff** the transaction commits, in commit order per base, with no gaps, at low latency.

### Decision
`relay` role reads each shard's logical replication slot (`pgoutput`, publication on `outbox_events` and `base_changes`), publishes to the bus, checkpoints LSN after publish acks; leader-elected per shard with a standby; slot loss recovery from durable rows (TC-29).

### Alternatives considered
* **Polling outbox table** (`SELECT … WHERE published = false ORDER BY id FOR UPDATE SKIP LOCKED`) — simple, but ordering by commit is not guaranteed by ID order (concurrent transactions commit out of ID order → gaps/reordering), polling latency vs load trade-off, updates to mark published add write load. Rejected as primary; **kept as fallback implementation** behind the same interface (ordering via `base_changes.seq` per base makes it tolerable).
* **Debezium (Kafka Connect)** — mature CDC; but adds Kafka Connect cluster, JVM ops, and our MVP profile (no Kafka) wouldn't work. Rejected; revisit when on Kafka.
* **Dual writes / publishing in app after commit** — loses events on crash. Rejected.
* **Triggers + `LISTEN/NOTIFY`** — not durable, payload limits. Rejected.

### Consequences
* ➕ Commit-ordered, gap-free, low latency.
* ➖ Slot management on failover (RDS failover may lose slots unless slot sync is available) — recovery mode + spike S-04; WAL retention risk if relay stalls (alert on `pg_replication_slots` lag; `max_slot_wal_keep_size` set).

### Revisit triggers
* Slot loss incidents > 1/quarter → Debezium or polling fallback.

---

## ADR-020 — Realtime: server-authoritative ops with cell-level LWW

Status: Proposed · Spine: D9

### Context
Structured cells (atomic values) dominate; conflicts on the same cell are rare and LWW is the expected UX; permissions and validation must be enforced server-side; rich text needs character-level merging.

### Decision
Clients send ops; server validates, applies in a transaction, assigns per-base `change_seq` (total order), broadcasts. Cell-level LWW; set-semantics ops for links/multi-select/collaborators; optional `If-Match` for strict clients. Yjs CRDT only for rich long text (V1+). WebSocket gateway; Redis presence.

### Alternatives considered
* **CRDT for everything (Yjs/Automerge documents per base/table)** — offline-first and P2P-friendly, but: server-side validation, permissions, computed fields, and SQL queries need materialized state anyway; document size for 1M-row tables infeasible; tombstone growth. Rejected.
* **OT** — designed for text sequences; unnecessary complexity for atomic cells. Rejected.
* **Pessimistic cell locking** — poor UX, lock leakage on disconnect. Rejected.

### Consequences
* ➕ Simple mental model; authoritative permissions & validation; total order enables catch-up/undo/webhooks.
* ➖ Per-base `change_seq` serialization point — spike S-02; no offline editing beyond short disconnects.

### Revisit triggers
* Offline-first product requirement; or `change_seq` contention p99 > 50 ms on hot bases.

---

## ADR-021 — Undo via command log with inverse operations

Status: Proposed · Spine: D25

### Context
Users expect multi-step undo/redo across sessions, including schema operations; collaborative edits interleave.

### Decision
Every mutation records forward and inverse ops in `base_changes`; the client keeps per-session stacks of change IDs; undo applies inverse ops as a new change (`via: undo`) with conflict checks per cell (skip cells modified later by others → partial undo).

### Alternatives considered
* **Event sourcing replay** — rebuilds state to a prior point; can't selectively undo one user's change amid others; expensive. Rejected.
* **Snapshot-based undo** — coarse, heavy. Rejected (snapshots are for restore, not undo).
* **Client-only undo** — loses across reload, can't undo server-side effects consistently. Rejected.

### Consequences
* ➕ Precise, collaborative-friendly, bounded by `BASE_CHANGES_RETENTION`.
* ➖ Every mutation must produce correct inverse ops — enforced by property tests (apply op then inverse = identity on touched cells).

### Revisit triggers
* Demand for undo beyond 30 days → rely on revision history restore, not undo.

---

## ADR-022 — File storage: S3, presigned multipart uploads, scan pipeline

Status: Proposed · Spine: D15

### Context
Attachments up to 5 GB, untrusted content, previews, CDN delivery, per-plan quotas.

### Decision
Presigned multipart upload to quarantine bucket → ClamAV scan → promote to `tabula-attachments` (SSE-KMS) → libvips/ffmpeg variants → CloudFront signed URLs from a **separate cookieless domain**; object key `{workspaceId}/{baseId}/{attachmentId}/{variant}`.

### Alternatives considered
* **Upload through API servers** — bandwidth and memory on API pods; slow. Rejected.
* **Third-party file service (Uploadcare/Filestack/Cloudinary)** — fast to integrate, but data residency, BYOK, cost at scale, and data leaving our boundary. Rejected (may be used for specific transforms).
* **Database blobs** — no. Rejected.

### Consequences
* ➕ Scalable, cheap, secure by quarantine.
* ➖ Asynchronous availability (scan latency) — UI shows "processing".

### Revisit triggers
* Need for in-browser document editing (Office) → integrate a WOPI provider.

---

## ADR-023 — Authentication: in-house identity core + BoxyHQ SAML Jackson

Status: Proposed · Spine: D19

### Context
Need sessions, passwords, MFA (TOTP, WebAuthn), social login, enterprise SSO (SAML/OIDC), SCIM, PATs, OAuth 2.1 for third-party apps; data residency; cost at 1M+ users.

### Decision
In-house identity core (opaque hashed session tokens in Postgres + Redis cache, Argon2id, TOTP/WebAuthn, OAuth social login), **SAML/OIDC via self-hosted Jackson** behind `SsoProvider`, SCIM server in-house, OAuth 2.1 authorization server in-house (PKCE, refresh rotation).

### Alternatives considered
* **Auth0 / Okta CIC** — rich features; per-MAU cost at scale is very high; residency & customization limits; tenant model mismatch with our orgs. Rejected.
* **Clerk** — superb DX for B2C/B2B SaaS; per-MAU cost, less control over session semantics needed by realtime revocation; residency. Rejected.
* **WorkOS** — strong SSO/SCIM; cost per connection acceptable — kept as **buy alternative** behind `SsoProvider` if Jackson ops burden is high.
* **Cognito** — cheap, but limited customization, awkward SAML UX, weak multi-tenant B2B model. Rejected.
* **Keycloak** — full IAM, self-hosted; heavy JVM ops, realm-per-tenant scaling issues, theming effort. Rejected.

### Consequences
* ➕ Control over sessions (instant revocation, perm epochs), residency, low marginal cost.
* ➖ Security-critical code we own — mitigated by using vetted libs (`@simplewebauthn`, `otplib`, `argon2`), external pentests, and narrow scope.

### Revisit triggers
* SSO onboarding support load > 0.5 FTE → WorkOS.

---

## ADR-024 — Authorization: hierarchical RBAC + deny restrictions compiled to snapshots

Status: Proposed · Spine: D20

### Context
Permission questions are mostly "role at base X" with overlays (field/table restrictions, locked views, interface scoping, Enterprise row policies). Checks happen per cell write and per realtime frame — must be in-memory fast.

### Decision
Grants in `core.access_grants` (org/workspace/base/interface; user/team/service account), max-role wins; deny-style restrictions stored with resources; compiled into a **PermissionSnapshot** per (principal, base), cached in Redis keyed by `perm_epoch`; evaluated in memory; record-scope predicates compiled into the filter AST (reusing ADR-006/filter compiler).

### Alternatives considered
* **Zanzibar-style ReBAC (SpiceDB / OpenFGA)** — expressive relationship graphs and consistent checks at scale, but: our permission model is shallow (3–4 levels), checks are per-cell/per-frame (network hop per check unacceptable without heavy caching), record-level filtering needs *query-time* predicates (list filtering), which Zanzibar systems handle poorly at 1M rows ("LookupResources" over millions), and it's another critical stateful system. Rejected for now.
* **OPA/Rego policies** — flexible; per-check evaluation overhead, policy language for product teams. Rejected (may be used for org policies later).
* **Ad-hoc checks in services** — error-prone. Rejected.

### Consequences
* ➕ O(1) in-memory checks; snapshot invalidation via epoch; reusable for all channels.
* ➖ Expressiveness ceiling (e.g., arbitrary sharing of single records to external users).

### Revisit triggers
* Requirements for **fine-grained per-record sharing** to arbitrary principals at scale, nested group hierarchies beyond teams, or cross-product authorization (multiple products sharing one permission graph) → re-evaluate SpiceDB/OpenFGA, keeping snapshots as a cache layer.

---

## ADR-025 — Public API: REST, no public GraphQL

Status: Proposed · Spine: D16

### Context
Users' schemas are dynamic (per-base fields); integrators range from Zapier to enterprise ETL; we need rate limiting, caching, idempotency, and stable error semantics.

### Decision
Resource-oriented REST/JSON `/v1`, cursor pagination, JSON filter AST via `records:query`, problem+json errors, `Idempotency-Key`, webhooks with cursors. Internal frontend uses the same API + WebSocket.

### Alternatives considered
* **Public GraphQL** — per-base dynamic schemas mean schema-per-base introspection, query cost analysis complexity, harder rate limiting/caching, N+1 risks across links; little benefit since records are already a flexible document shape. Rejected.
* **gRPC public API** — poor fit for browser/no-code integrators. Rejected (could be used internally after extraction).
* **OData** — rich querying, but unfamiliar to most integrators and heavy spec. Rejected (filter AST is simpler).

### Consequences
* ➕ Simple, cacheable, tool-friendly; one API for first and third parties.
* ➖ Over/under-fetching handled via `fields` selection and `cellFormat`.

### Revisit triggers
* Strong partner demand plus a clear cost model for GraphQL → read-only GraphQL facade over REST semantics.

---

## ADR-026 — Deployment: AWS; ECS Fargate for MVP, EKS from V1

Status: Proposed · Spine: D23

### Context
≥ 5 process roles, per-queue autoscaling, isolated sandbox pools, WebSockets, multiple regions later; small platform team early.

### Decision
AWS reference: CloudFront → ALB → compute; RDS PostgreSQL, ElastiCache/Valkey, MSK/Redpanda, S3, OpenSearch. MVP may run on **ECS Fargate** with identical containers; **EKS from V1** (Phase 6) for sandbox node isolation, KEDA queue-based autoscaling, and Argo CD GitOps. Terraform for infra.

### Alternatives considered
* **EKS from day one** — more upfront platform work for 3 engineers. Rejected for MVP (allowed if team has strong k8s expertise).
* **PaaS (Render, Fly.io, Heroku)** — fast start; limits on private networking, logical replication access, compliance, residency, sandbox isolation. Rejected.
* **Multi-cloud** — doubles platform cost. Rejected.
* **GCP/Azure** — viable; AWS chosen for managed service breadth and team familiarity.

### Consequences
* ➕ Managed data services; containers portable across ECS/EKS.
* ➖ Migration ECS → EKS mid-roadmap — mitigated by identical images, env config via the same contract, and Helm charts started in Phase 4.

### Revisit triggers
* Customer demand for other clouds or on-prem.

---

## ADR-027 — Automation script sandbox: isolated-vm worker pool

Status: Proposed · Spine: D21

### Context
Users run JavaScript in automations (and later extensions) with access to base data via an SDK; must not access host, other tenants, or network except via an allowlisted proxy; budgets: 30 s CPU/wall, 128–512 MB memory.

### Decision
Dedicated `sandbox` service (separate image, separate node pool, no IAM role, network egress only to the egress proxy) running **V8 isolates via `isolated-vm`**; one isolate per execution, pooled processes recycled after N executions; SDK calls marshalled to the host which re-authorizes as the automation principal. Heavier/longer workloads (V1+) route to **Firecracker microVMs** (or Deno subprocess with permissions off) behind the same `SandboxRunner` interface.

### Alternatives considered
* **Node `vm` module** — not a security boundary. Rejected.
* **Deno subprocess** — permissions model is good; process-per-execution cost higher; acceptable as second tier.
* **Firecracker microVMs** — strongest isolation; cold start/ops cost; second tier for heavy scripts.
* **WASM (QuickJS-in-WASM)** — strong isolation, but slower JS, limited ecosystem/async ergonomics. Rejected for now; revisit for extensions.
* **AWS Lambda per script** — strong isolation; cold starts, per-invocation cost, VPC/egress control complexity. Rejected.

### Consequences
* ➕ Fast startup (ms), tight memory/CPU limits.
* ➖ V8 isolate escapes are historically rare but possible → defense in depth: separate nodes, seccomp, no credentials, egress proxy, rapid patching.

### Revisit triggers
* Any isolate-escape CVE without timely patch → move all scripts to Firecracker tier.
* Need for npm packages in scripts.

---

## ADR-028 — AI provider abstraction and AI gateway

Status: Proposed · Spine: D22

### Context
AI features (fields, assistants, automation actions) need multiple models, cost control, policy enforcement (data access, org opt-out), observability, caching, and provider portability.

### Decision
`@tabula/ai` provider abstraction (`generate`, `stream`, `embed`, tool use, structured output) and an **AI gateway module**: versioned prompt templates (`ai_prompt_templates`), model routing by task class (default Anthropic `claude-sonnet-5`; `claude-haiku-4-5-20251001` for high-volume classification/extraction; `claude-opus-5-5` for agents), token/cost metering (`ai_invocations`, `usage_events`), response caching (`ai:cache:*`), per-workspace policies, permission-filtered context assembly, eval harness.

### Alternatives considered
* **Direct SDK calls from features** — no central policy/metering; vendor lock. Rejected.
* **Third-party LLM gateway (LiteLLM proxy, Portkey)** — useful routing/metering, but policy enforcement and permission-filtered context are ours anyway; adds a hop & data processor. Rejected (LiteLLM may be used as a library adapter).
* **Self-hosted open models only** — cost/quality trade-offs and GPU ops. Rejected for default; pluggable later.

### Consequences
* ➕ Provider portability, central governance, cost visibility.
* ➖ Abstraction must expose provider-specific features (prompt caching, tool use) without lowest-common-denominator — capability flags per provider.

### Revisit triggers
* Provider pricing/quality shifts → routing table change (config, not code).

---

## ADR-029 — Observability: OpenTelemetry + Grafana stack

Status: Proposed · Spine: D24

### Context
Distributed flows across roles (api → db → relay → bus → worker → realtime); need per-tenant debugging, SLOs, cost control.

### Decision
OpenTelemetry SDKs everywhere (traces, metrics, logs correlation; `traceparent` in event envelope); Grafana stack (Tempo, Mimir/Prometheus, Loki, Grafana) — managed Grafana Cloud or self-hosted; Sentry for errors (client + server); pganalyze + `pg_stat_statements` for DB. Tenant IDs as span attributes, not metric labels (cardinality).

### Alternatives considered
* **Datadog** — best-in-class UX, high cost at our cardinality/log volume; kept as buy-alternative via OTel exporters.
* **New Relic / Honeycomb** — Honeycomb excellent for high-cardinality tracing; viable add-on. Not chosen as primary for cost/consolidation.
* **CloudWatch only** — weak tracing/UX. Rejected.

### Consequences
* ➕ Vendor-neutral instrumentation; costs controllable.
* ➖ Self-hosting Grafana stack needs ops time — prefer Grafana Cloud until scale justifies.

### Revisit triggers
* Observability spend > 8% of infra cost.

---

## ADR-030 — No event sourcing as system of record

Status: Proposed · Spine: D26

### Context
Change log exists for realtime/undo/webhooks; tempting to make it the source of truth.

### Decision
Current-state tables are authoritative; `base_changes` retained 30 days; `record_revisions` for history per plan; snapshots for restore.

### Alternatives considered
* **Full event sourcing** — perfect audit/time travel, but projections for every query, schema evolution of events forever, rebuild times on 10M-record bases, GDPR erasure conflicts with immutable logs. Rejected.

### Consequences
* ➕ Simple queries; GDPR erasure feasible.
* ➖ Time-travel limited to revisions/snapshots.

### Revisit triggers
* Product requirement for arbitrary point-in-time base views beyond snapshots.

---

## ADR-031 — Contract testing via OpenAPI conformance (no Pact)

Status: Proposed · Ref: 28 §52.3

### Context
Consumers of our API are our monorepo SPA (shared generated types) and third parties (can't publish consumer contracts).

### Decision
OpenAPI 3.1 generated from TypeBox is the contract; oasdiff blocks breaking changes; Schemathesis fuzzes conformance; strict response validation in tests; JSON Schemas for events/webhooks snapshot-tested.

### Alternatives considered
* **Pact** — valuable for independently deployed internal services; we have none yet. Rejected.

### Consequences
* ➕ One contract artifact; low overhead.
* ➖ No consumer-driven signal from third parties — mitigated by API beta programs and deprecation policy.

### Revisit triggers
* ≥ 2 separately deployed internal services with independent release cadence (e.g., extracted realtime gateway).
