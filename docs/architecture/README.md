# Tabula — Platform Architecture

> Architecture for an Airtable-class relational spreadsheet/database platform, designed from first principles.
> **Status:** Draft for architectural approval · **Date:** 2026-10-03 · **Code:** none yet (by design)

"Tabula" is a placeholder product name. Package scope `@tabula/*`.

## How to read this set

1. **Start with [00 — Canonical Decisions](00-canonical-decisions.md).** It is normative: the 26 core decisions (plus ratified amendments in §14), ID conventions, field-type keys, the table inventory, event catalogue, topics/queues, permission vocabulary and engine constants. Every other document conforms to it.
2. Read [01 — Executive Summary & Capability Map](01-executive-summary-and-capability-map.md) for the big picture.
3. Then read in order, or jump to the subsystem you own.

Provenance labels are used throughout: **[Observed]** publicly visible product behavior · **[Inferred]** reasonable inference about how such products are built · **[Ours]** what we will build. We make no claims about any vendor's private implementation.

## Document map (follows the required output order)

| # | Document | Required sections |
|---|---|---|
| 00 | [Canonical Decisions, Conventions & Inventories](00-canonical-decisions.md) | spine |
| 01 | [Executive Summary & Product Capability Map](01-executive-summary-and-capability-map.md) | 1–2, "What we should not copy" |
| 02 | [Domain Model & Entity Relationship Diagrams](02-domain-model-and-erd.md) | 3–4 |
| 03 | [System Architecture](03-system-architecture.md) | 5 |
| 04 | [Database Architecture](04-database-architecture.md) | 6 |
| 05 | [Complete SQL Schema](05-sql-schema.md) | 7 |
| 06 | [Record Storage Strategy](06-record-storage.md) | 8 |
| 07 | [Field Engine](07-field-engine.md) | 9 |
| 08 | [Formula Engine](08-formula-engine.md) | 10 |
| 09 | [Linked Record Engine](09-linked-record-engine.md) | 11 |
| 10 | [View Engine](10-view-engine.md) | 12 |
| 11 | [Filter Engine, Sorting & Grouping](11-filter-sort-group.md) | 13–14 |
| 12 | [Contact Object Architecture](12-contacts.md) | 15 |
| 13 | [Interface Builder](13-interface-builder.md) | 16 |
| 14 | [Automation Engine](14-automation-engine.md) | 17 |
| 15 | [Event Architecture](15-events.md) | 18 |
| 16 | [Realtime Architecture](16-realtime.md) | 19 |
| 17 | [API Architecture & Query System](17-api-architecture.md) | 20 |
| 18 | [Search, Attachments & Collaboration](18-search-attachments-collaboration.md) | 21–23 |
| 19 | [Permissions & Multi-Tenancy](19-permissions-and-multitenancy.md) | 24–25 |
| 20 | [Import/Export, Sharing & Integrations](20-import-export-sharing-integrations.md) | 26–28 |
| 21 | [AI Architecture](21-ai-architecture.md) | 29 |
| 22 | [Audit Logs, Version History, Undo/Redo, Trash](22-audit-history-undo-trash.md) | 30–33 |
| 23 | [Notifications, Background Jobs, Caching, Performance](23-notifications-jobs-caching-performance.md) | 34–37 |
| 24 | [Frontend, Grid Engine, State Management, Design System](24-frontend-grid-state-design-system.md) | 38–41 |
| 25 | [Security, Observability, Infrastructure](25-security-observability-infrastructure.md) | 42–44 |
| 26 | [Monolith vs Microservices, Tech Stack, Repository, Service Boundaries](26-architecture-style-stack-repo-services.md) | 45–48 |
| 27 | [Data Flows, Transaction Boundaries, Migrations](27-data-flows-transactions-migrations.md) | 49–51 |
| 28 | [Testing & Edge Cases](28-testing-and-edge-cases.md) | 52–53 |
| 29 | [Implementation Roadmap & MVP/V1/Enterprise Scope](29-roadmap-and-scope.md) | 54–55 |
| 30 | [Architecture Diagrams](30-architecture-diagrams.md) | 56 |
| 31 | [API Specification](31-api-specification.md) | 57 |
| 32 | [Database Table & Object Inventory](32-table-and-object-inventory.md) | 58–59 |
| 33 | [Architecture Decision Records](33-architecture-decision-records.md) | 60 |
| 34 | [Self-Review, Risk Register & Recommended Build Order](34-self-review-risk-register-build-order.md) | quality check |

## The architecture in ten lines

1. **Modular monolith** (TypeScript/Node, Fastify, Kysely) deployed as `api`, `realtime`, `worker`, `scheduler`, `relay` roles — extract services only when a measured reason appears.
2. **PostgreSQL** split into a regional **control plane** (US/EU), a tiny global login directory, and **sharded data plane cells**; a workspace's bases all live on one shard.
3. **Hybrid record storage:** user values in `records.cells` JSONB keyed by stable field *slots*; computed values materialized in `records.computed`; links normalized in `record_links`; typed index sidecars for large-table sort/filter. No per-user DDL.
4. **Plugin field engine** — every field type is one module (codec, operators, SQL compiler, sorter, converter, formula typing, UI renderer).
5. **Own formula language** — Pratt parser → typed AST → compiled closures, isomorphic client/server, field-level dependency graph, incremental recompute.
6. **Server-authoritative realtime** — per-base ordered change log (`base_changes`), cell-level last-writer-wins, set-semantics ops for multi-valued cells; CRDT only for rich text.
7. **Transactional outbox → logical replication relay → Kafka-API log** feeding automations, search, webhooks, notifications, audit, metering.
8. **Durable automation runner** — Postgres run/step state, BullMQ execution, idempotent runs, loop guards, sandboxed scripts, SSRF-safe egress.
9. **RBAC with additive grants + deny restrictions**, compiled per (principal, base) into cached permission snapshots; enforced identically in API, realtime, search, export and AI.
10. **API-first** — the first-party UI uses the same public REST API and WebSocket protocol third parties use.

## Consistency status

The 35 documents were drafted in parallel against the spine, then reconciled in one pass. That pass:

* Ratified 15 decision amendments ([00 §14.1](00-canonical-decisions.md)). The most important is **A1**: the control plane is regional (US/EU), with a tiny global login directory.
* Adopted 24 extra tables. The canonical schema is now **117 tables** across the `global`, `core`, `data` and `audit` schemas ([05 §7.18](05-sql-schema.md), [32](32-table-and-object-inventory.md)).
* Unified the error catalogue at **118 stable codes** ([17 §14](17-api-architecture.md)).
* Aligned the realtime ticket endpoint, the user-content domain and the partition tooling across documents.
* Fixed every broken cross-document link. All **115 Mermaid diagrams** pass the Mermaid 11 parser.

What has **not** been verified: the SQL DDL has not been executed against a live PostgreSQL 16 instance. Running it is the first task of the DB package step (step 6 of the build order in [34](34-self-review-risk-register-build-order.md)), which uses Testcontainers PostgreSQL 16.

## Approval checklist

- [ ] Canonical decisions D1–D26 accepted (or amended in `00`)
- [ ] Record storage strategy (06) accepted after the JSONB-at-scale spike (see 34)
- [ ] Realtime consistency model (16) accepted
- [ ] Permission model (19) accepted by security
- [ ] MVP scope (29) accepted by product
- [ ] Risk register (34) reviewed; spikes scheduled

After approval, the next step is converting [34 — Recommended Build Order](34-self-review-risk-register-build-order.md) and [29 — Roadmap](29-roadmap-and-scope.md) into an implementation plan.
