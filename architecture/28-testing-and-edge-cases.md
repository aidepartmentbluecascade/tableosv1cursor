# 28 — Testing Architecture & Edge Cases

> **Status:** Proposed · **Owner:** Platform Architecture + QA Engineering · **Date:** 2026-10-03
> Conforms to [`00-canonical-decisions.md`](./00-canonical-decisions.md). Where this file names a package or module, the canonical layout in [`26-architecture-style-stack-repo-services.md`](./26-architecture-style-stack-repo-services.md) wins on naming; the testing obligations here still apply.

**Sections covered**

* **Part 49 / Section 52 — Testing architecture:** principles, test pyramid, tooling decisions (incl. Pact decision), test infrastructure, test data factories & generators, per-area strategies (unit, integration with RLS, API contract, DB & migrations, formula, filter-equivalence, field conversion matrix, compute, links, automations, permissions & masking, realtime convergence, undo, search, import/export, frontend/grid, E2E), load/soak/chaos, multi-tenant isolation fuzzing, security testing, migration testing, DR restore drills, 44 critical test cases (given/when/then), CI strategy (sharding, flaky quarantine, affected-test selection), environments and quality gates.
* **Part 50 / Section 53 — Edge cases:** 196 numbered edge cases across 23 areas, each with scenario → expected behavior → mechanism / owning component.

---

# Part 49 — Section 52: Testing Architecture

## 52.1 Principles

1. **Test the invariants, not just the examples.** Tabula's hardest bugs are *equivalence* bugs (SQL filter ≠ in-memory filter, incremental compute ≠ full recompute, client formula ≠ server formula, realtime replica ≠ server state). Every one of those pairs gets a **property-based differential test** with `fast-check`, with shrinking and a persisted seed corpus.
2. **Real infrastructure for anything stateful.** No mocked Postgres. Integration tests run against real Postgres 16 with **RLS enabled and the application connecting as the non-superuser, non-`BYPASSRLS` role** (`tabula_app`), exactly as in production. Redis, Redpanda (Kafka API), MinIO (S3 API) run in Testcontainers.
3. **Determinism is a feature of the code, not of the tests.** Clock (`Clock` port), ID generation (`IdGenerator` port, UUIDv7 with injectable time + randomness), randomness (`Rng` port), and outbound HTTP (`HttpEgress` port) are injected everywhere. Tests never `sleep()`; they advance a `FakeClock`.
4. **One fixture vocabulary.** `@tabula/testing` provides builders, arbitraries, fake connectors, and harnesses used by unit, integration, E2E seeding, and load-test seeding. A test that hand-writes SQL inserts for records is a review smell.
5. **Security properties are tests.** Tenant isolation, field masking, and SSRF protections are encoded as executable suites that block merges — not as checklists.
6. **Every production incident adds a test.** Post-incident review is not closed until a regression test (or an edge case below with a linked test ID) exists.
7. **Budgets are enforced.** PR pipeline p50 ≤ 12 min, p95 ≤ 20 min wall-clock. Tests that blow their per-suite budget fail with a budget error rather than silently slowing CI.

## 52.2 Test pyramid for Tabula

Tabula's pyramid is wider than usual in the **middle** (integration + property) because so much correctness lives in SQL, RLS, triggers on ordering, and transactional outbox behavior that a pure-unit layer cannot see.

```
                      ▲  Manual exploratory / bug bash (per release)
                     ▲▲  Chaos, DR drills, soak (staging, scheduled)
                    ▲▲▲  Load (k6) — nightly + pre-release
                   ▲▲▲▲  E2E Playwright — ~60 critical journeys (PR: smoke 12; nightly: all)
                ▲▲▲▲▲▲▲  Contract: OpenAPI conformance + schema-diff + webhook payload schemas
           ▲▲▲▲▲▲▲▲▲▲▲▲  Integration (real PG+RLS / Redis / Redpanda / MinIO) — module-level
        ▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲  Property / differential (fast-check) — engines & invariants
   ▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲  Unit (Vitest) — pure functions, field types, parsers, reducers
```

| Layer | Approx. count at V1 | Runtime budget (PR) | Runs |
|---|---|---|---|
| Unit | 12–18k | ≤ 3 min (sharded ×8) | every PR, affected packages |
| Property/differential | 300 properties | ≤ 4 min at `numRuns` PR profile | every PR (affected), nightly at ×20 runs |
| Integration | 3–5k | ≤ 8 min (sharded ×16) | every PR (affected modules) |
| Contract | ~1.2k generated | ≤ 3 min | every PR touching `api` or schemas |
| E2E | ~60 journeys | smoke ≤ 6 min; full ≤ 25 min | smoke on PR, full on main + nightly |
| Load | 8 scenarios | n/a | nightly (reduced), pre-release (full) |
| Soak | 2 scenarios | n/a | weekly 24h, pre-GA 72h |
| Chaos / DR | 12 experiments + quarterly restore | n/a | weekly staging game-day; quarterly DR drill |

## 52.3 Tooling decisions

| Concern | Tool | Decision & rationale |
|---|---|---|
| Unit & integration runner | **Vitest** (workspace mode) | Fast, ESM-native, same runner for server/web/isomorphic packages; `--shard` support; per-project config. Jest rejected (slower ESM story). |
| Property testing | **fast-check** | Mature shrinking, model-based testing (`fc.commands`) for realtime/undo state machines, replayable seeds (`seed`, `path`). |
| Containers | **Testcontainers (Node)** | Postgres 16 (with `pg_trgm`, `btree_gin`, logical replication `wal_level=logical`), Redis 7, **Redpanda** (Kafka API; faster startup than Kafka), MinIO, ClamAV (nightly only), Toxiproxy. Reuse mode (`TESTCONTAINERS_REUSE_ENABLE`) locally; per-shard-job containers in CI. |
| E2E | **Playwright** | Multi-context (true multi-user realtime tests in one test), trace viewer, network interception, screenshot diffs for the canvas grid, `axe-core` integration. Cypress rejected (single-tab, weak multi-user). |
| Load | **k6** (+ `xk6-websockets`) | JS scripting reuses our payload builders (via bundled `@tabula/testing/load`), WebSocket support, Prometheus remote-write output to Grafana. Gatling/Locust rejected for language mismatch. |
| API contract | **OpenAPI 3.1 conformance** (generated from TypeBox) + **Schemathesis** (stateful fuzzing from the spec) + **oasdiff** (breaking-change detection vs last released spec) | See Pact decision below. |
| Pact (consumer-driven contracts) | **Not adopted** (revisit trigger: ≥ 2 separately deployed internal services with independent release cadence) | Our consumers are (a) our own SPA in the same monorepo — shared generated types make drift a compile error; (b) third parties we don't control — they can't publish Pact files to us. The provider-side OpenAPI spec is the contract; oasdiff blocks breaking changes; Schemathesis verifies the implementation matches the spec. Webhook/event payloads are covered by JSON Schema snapshot tests of the event catalogue. When the realtime gateway or AI gateway is extracted (D1), we re-evaluate Pact for those internal boundaries. |
| Chaos | **Toxiproxy** (integration level: latency, resets, partitions between app ↔ PG/Redis/Kafka); **Chaos Mesh** on staging EKS (pod kill, network partition, IO latency); AWS FIS for RDS failover and AZ impairment | Layered: deterministic chaos in CI, real chaos in staging. |
| Security DAST | **OWASP ZAP** (authenticated scans with session context; API scan from OpenAPI) | Nightly against staging; baseline scan on PR preview envs. |
| SAST / deps | Semgrep (custom rules: raw SQL concat, missing `withTenant`, `fetch` bypassing `HttpEgress`), CodeQL, `npm audit`/OSV-Scanner, Trivy (images), gitleaks | PR gates. |
| Visual regression | Playwright screenshot assertions (grid canvas, interfaces) with per-platform baselines in a container | Fonts pinned in the CI image for stable rasterization. |
| Accessibility | `@axe-core/playwright` + custom grid a11y assertions (ARIA grid mirror) | PR gate for changed pages. |
| Mutation testing | **Stryker** on `@tabula/formula`, `@tabula/filter`, `@tabula/permissions` | Weekly; mutation score ≥ 80% enforced on these three packages. |
| Benchmarks | `vitest bench` + `tinybench`, pgbench custom scripts for DB micro-benchmarks | Nightly; regression > 15% opens an issue automatically. |

## 52.4 Test infrastructure

### 52.4.1 Postgres test harness (`@tabula/testing/pg`)

* **One container per CI job**, started once in Vitest `globalSetup`. Migrations (control plane `core`, data plane `data`, `audit`) applied **once** to a template database `tabula_tpl`.
* Each test file gets its own database via `CREATE DATABASE t_<worker>_<n> TEMPLATE tabula_tpl` (≈ 40–80 ms) — isolation without per-test migration cost. Within a file, each test runs inside a **savepoint-wrapped transaction** only when it does not exercise commit-dependent behavior (outbox/relay, logical replication, `SKIP LOCKED` contention). Tests that need real commits opt into `useCommittedDb()` which truncates touched tables in `afterEach`.
* **Roles mirror production:** migrations run as `tabula_migrator`; the app connects as `tabula_app` (`NOBYPASSRLS`, not table owner); the relay connects as `tabula_relay` (`REPLICATION`). A global `afterAll` asserts that no test connected as superuser except the harness.
* **Two-plane topology in tests:** the harness provisions `core` in one database and **two data-plane shards** (`shard_a`, `shard_b`) as separate databases. Every integration test of cross-plane flows therefore exercises the shard router with ≥ 2 shards, even though production MVP runs one (catches "accidentally assumes single shard" bugs from day one).
* `pg_stat_statements` enabled; a `queryBudget(n)` helper fails tests whose request path executes more than *n* statements (N+1 guard on hot endpoints: record list, record update, view load).

### 52.4.2 Other containers and fakes

| Dependency | In unit tests | In integration | In E2E/staging |
|---|---|---|---|
| Postgres | not used | Testcontainers (real) | RDS (staging) / container (PR preview) |
| Redis (cache, BullMQ) | `FakeCache` (in-memory, same interface) | Testcontainers Redis 7 | ElastiCache |
| Kafka API | `InMemoryEventBus` | Redpanda container (full profile) **and** BullMQ MVP profile — event tests run against **both** `EventBus` implementations | MSK/Redpanda |
| S3 | `FakeObjectStore` | MinIO | S3 |
| ClamAV | `FakeScanner` (EICAR-string detection) | FakeScanner; real ClamAV nightly | real |
| Email | `CapturingMailer` | `CapturingMailer` (inspect via `testkit.mail.lastTo(email)`) | Mailpit in preview envs; SES sandbox in staging |
| LLM providers | `FakeLlmProvider` (scripted responses, token accounting, latency/failure injection) | same | real provider with low quota on staging nightly (`ai-smoke`) |
| External connectors (Slack, Gmail, HTTP) | `FakeConnector` registry | `FakeConnector` + **WireMock-style** `testkit.httpStub` bound behind `HttpEgress` | sandbox accounts (nightly) |
| SAML/OIDC | Jackson in container with a mock IdP (`saml-idp` / `oidc-provider`) | same | Okta/Entra test tenants (nightly) |
| Stripe | `stripe-mock` | `stripe-mock` + signed webhook fixtures | Stripe test mode |
| Time | `FakeClock` | `FakeClock` injected into app container; Postgres `now()` is **not** used for business timestamps (app supplies them) so fake time is coherent | real |

### 52.4.3 Deterministic clock and scheduler

`Clock` exposes `now()`, `monotonic()`, `setTimeout`-like `schedule()`. `FakeClock.advance(ms)` fires scheduled callbacks in order. BullMQ delays in tests are driven through a `QueueClock` adapter (tests call `testkit.jobs.drain({ advanceClock: true })` which repeatedly advances to the next delayed job and processes queues until quiescent). This makes retry/backoff schedules, scheduled triggers, volatile formula buckets, lease reconciliation and trash purge testable in milliseconds.

## 52.5 Test data factories & generators (`@tabula/testing`)

### 52.5.1 Builders (example-based)

```ts
const w = await world()                        // org + workspace on shard_a + owner user
  .user('alice', { orgRole: 'member' })
  .user('bob')
  .base('CRM', b => b
    .table('Companies', t => t
      .field('Name', 'text', { primary: true })
      .field('ARR', 'currency', { currencyCode: 'USD', precision: 2 })
      .field('Tier', 'single_select', { options: ['Gold', 'Silver'] }))
    .table('Deals', t => t
      .field('Title', 'text', { primary: true })
      .link('Company', 'Companies', { allowMultiple: false, inverse: 'Deals' })
      .lookup('Company ARR', { via: 'Company', field: 'ARR' })
      .formula('Score', '{Company ARR} * 0.1'))
    .grant('alice', 'editor')
    .grant('bob', 'viewer'))
  .records('Companies', 50, faker => ({ Name: faker.company(), ARR: faker.money(), Tier: faker.pick(['Gold','Silver']) }))
  .build();                                    // goes through the real service layer, not raw SQL
```

* Builders call **domain services** (same code paths as the API) so materialized computed values, `base_changes`, outbox rows and sidecars are consistent. A `rawInsert` escape hatch exists only for performance fixtures (1M rows) and is followed by `testkit.compute.rebuild(tableId)` + `testkit.sidecars.rebuild(tableId)`.
* Names resolve to IDs via `w.ids.field('Deals', 'Score')`; public IDs via `w.pub.record(...)`.
* `world().on('shard_b')` places the workspace on the second shard.

### 52.5.2 Arbitraries (property-based)

| Arbitrary | Produces | Notes |
|---|---|---|
| `arbFieldConfig(type)` | valid `fields.config` per type | precision, options (1–40, incl. unicode/emoji/RTL/duplicate-looking labels), timezones (incl. `Pacific/Chatham`, `Asia/Kathmandu`, `America/St_Johns`, DST zones), `allowMultiple` |
| `arbSchema({ maxTables, maxFields })` | multi-table base schema with links, lookups, rollups, formulas forming a **DAG** | can be biased to "near-cycle" shapes to test cycle detection |
| `arbCellValue(field)` | valid canonical values incl. boundaries | ±0, `-0` normalization, 1e308, 15+ significant digits, currency `"0.005"` rounding, empty-string vs absent, 10k-char text, zero-width joiners, combining marks, surrogate pairs, leap-day dates, `9999-12-31` |
| `arbRawInput(field)` | **unnormalized** user input (paste/API) | `"1,234.5"`, `"(12)"`, `"12%"`, `"TRUE"`, `"yes"`, locale variants, junk |
| `arbFilterAst(schema)` | filter AST using operators valid for each field type | nested AND/OR depth ≤ 5, empty groups, `isEmpty`/`isNotEmpty`, relative dates (`today`, `pastNumberOfDays`), `contains` with `%`/`_`/`\` characters (LIKE-escape traps) |
| `arbSortSpec(schema)` | 0–5 sort keys | incl. on lookup/rollup/formula/select (option order) |
| `arbFormulaAst(schema, resultType?)` | well-typed AST | depth ≤ `MAX_FORMULA_DEPTH`, function coverage-weighted |
| `arbFormulaSource()` | **arbitrary strings** | for parser robustness (never throws non-`FormulaError`) |
| `arbOps(schema)` | sequences of realtime ops (`cell.set`, `links.add/remove`, `multi.add/remove`, `record.create/delete`, `field.update`) | used by realtime and compute model tests |
| `arbPrincipal(world)` | user/team/service account/share link/interface user with random grants & restrictions | for permission matrix fuzzing |

Generators are **seeded per CI run** (`FC_SEED` printed in the log; failures print a reproduction command `pnpm test:prop --seed=… --path=…`). Every shrunk counterexample found in CI is committed to `__regressions__/*.json` and replayed forever as an example test.

## 52.6 Strategies per area

### 52.6.1 Unit tests

* **Field type plugins** (`@tabula/fields`): for every type — `validate`, `normalize`, `parseInput` (paste/CSV/API), `format` (locale), `toSortKey`, `toIndexSidecar`, `toSearchText`, `toCsv`, `fromCsv`, `compare`, `isEmpty`. Shared conformance suite `fieldTypeConformance(def)` is run for every registered plugin; a new plugin cannot be registered without passing it (test discovers plugins from the registry).
  * Laws: `normalize(normalize(x)) == normalize(x)`; `parseInput(format(x)) == x` for lossless types; `compare` is a total preorder consistent with `toSortKey` (byte order of sort keys == compare order); `isEmpty(x) ⇔ key absent after write`.
* **IDs** (`@tabula/types` (ID codec)): base62 encode/decode roundtrip, prefix mismatch rejection, UUIDv7 monotonicity under same-millisecond generation, fixed-width 22 chars.
* **Fractional index**: `between(a,b)` strictly between, key length growth bounded under 10k adversarial inserts at the same position (rebalance trigger fires).
* **Permission evaluator** (pure): snapshot compile from grants + restrictions; see 52.6.11.
* **Frontend**: RecordStore reducers (apply server op, optimistic op, rebase), grid layout math (row heights, frozen columns, hit testing), keyboard navigation state machine, clipboard TSV parse/serialize.

### 52.6.2 Integration tests (real Postgres with RLS)

Scope: one module through its public service interface + its repositories + real DB + outbox. Every integration test runs inside `withTenant(workspaceId)` which issues `SET LOCAL app.workspace_id`. Mandatory module-level suites:

* **RLS negative suite (auto-generated):** for every table in `data.*` with a `workspace_id` column, the harness inserts a row for workspace A, sets `app.workspace_id = B`, and asserts `SELECT/UPDATE/DELETE` affect 0 rows and `INSERT` with A's id fails the `WITH CHECK`. Test enumerates tables from `information_schema` — **a new table without an RLS policy fails CI** (`rls-coverage` test). Unset `app.workspace_id` must yield zero rows (policy uses `current_setting('app.workspace_id', true)::uuid` which is NULL → no match).
* **Outbox atomicity:** any service method that writes domain state must produce its `base_changes` row and `outbox_events` rows in the same transaction; a test helper `expectEmits(['record.updated'])` checks outbox after commit; rolled-back transactions emit nothing.
* **Query budgets** on hot paths (52.4.1).
* **Lock ordering**: concurrent bulk update + schema change tests run with `lock_timeout=2s` and must not deadlock (we assert no `40P01`).

### 52.6.3 API contract tests

1. **Spec generation is deterministic**: `pnpm openapi:gen` output is committed; CI fails if regenerated spec differs (spec drift).
2. **oasdiff** against the last released `v1` spec: any breaking change (removed field, narrowed enum, new required param, changed type) fails unless the PR carries the `api-breaking-approved` label + changelog entry (only allowed for unreleased/beta endpoints).
3. **Response conformance**: every integration test that goes through the HTTP layer validates the response body against the spec schema (Fastify response schema in `test` mode is *strict*: extra properties fail, unlike production which strips).
4. **Schemathesis stateful fuzzing** (nightly + on API PRs, 15 min budget): uses OpenAPI links (create base → create table → create field → create records → query) to explore sequences; checks: no 5xx, problem+json shape for every 4xx, declared status codes only, idempotency (`Idempotency-Key` replay returns identical response), pagination cursor stability.
5. **Error code catalogue test**: every `code` emitted by the server exists in `errors.catalog.ts` with a stable `type` URI; unknown codes fail.
6. **Event/webhook payload contracts**: JSON Schemas for every event type in the catalogue (§6 of the spine) are snapshot-tested; a schema change without a `schemaVersion` bump fails.

### 52.6.4 Database & migration tests

* **Up on empty**: all migrations apply on an empty database for `core`, `data`, `audit`.
* **Up on prod-like snapshot**: nightly job restores an **anonymized** production-shape snapshot (synthetic generator `testkit.synthetic.shard({ workspaces: 2_000, bases: 20_000, records: 50M })` for pre-GA; post-GA, a masked copy of a real shard produced by the masking pipeline in [`25-security-observability-infrastructure.md`](./25-security-observability-infrastructure.md)) and applies pending migrations, measuring: duration, lock wait (`pg_locks` sampling every 100 ms), max `ACCESS EXCLUSIVE` hold (budget: 2 s; any longer requires an expand/contract plan), WAL generated, replication lag on a replica.
* **Expand/contract compatibility**: for each migration, the **previous application version** runs its integration smoke suite against the **new schema** (N-1 compatibility), because rolling deploys run both versions simultaneously.
* **Migration lint** (`squawk` + custom rules): forbid `ALTER TABLE … ADD COLUMN … DEFAULT volatile`, non-concurrent index creation on large tables, `ALTER TYPE` rewrites, `NOT NULL` without `CHECK … NOT VALID` → `VALIDATE`, missing RLS policy on new tenant tables, foreign keys across partitioned tables without index.
* **Down migrations are not used in production** (forward-fix policy); tests do not require them. Data backfills are jobs (`maintenance` queue) with their own idempotency tests.
* **Partition maintenance**: `base_changes` daily and `*_runs` monthly partition creation/drop jobs tested with `FakeClock` across month/year boundaries; asserts partitions exist ≥ 7 days ahead.

### 52.6.5 Formula engine tests (`@tabula/formula`)

| Test type | Description |
|---|---|
| **Golden tests per function** | `formula/golden/<FUNCTION>.yaml`: each function ≥ 10 cases incl. empty/absent args, wrong types (error value), boundary numbers, unicode, locale-independent output, timezone-sensitive ones evaluated in ≥ 3 zones. Runner executes each case on (a) the server evaluator (Node), (b) the **client evaluator in a real browser** (Playwright component runner, Chromium + WebKit + Firefox) — outputs must be byte-identical after canonical serialization. |
| **Parser roundtrip** | Property: `parse(print(ast)) ≡ ast` for `arbFormulaAst`; and `print(parse(src))` is a fixed point after one iteration. |
| **Parser robustness** | Property: for `arbFormulaSource()`, `parse` returns `Ok` or `FormulaError` with a span inside the input — never throws, never exceeds 50 ms for inputs ≤ 10k chars (guards against pathological backtracking/recursion). Depth > `MAX_FORMULA_DEPTH` → `FORMULA_TOO_DEEP`. |
| **Type checker soundness** | Property: if `typecheck(ast) = T`, then `eval(ast, randomRecord)` returns a value of type `T` or a typed error value — never a JS exception, `NaN`, `Infinity`, or `undefined`. |
| **Client/server equivalence** | Property: for random schema + record + well-typed formula, server evaluation == client evaluation (both compiled closures; client run in jsdom for speed on PR, browsers nightly). Covers floating-point formatting, `ROUND` half-away-from-zero vs banker's, date arithmetic across DST, string collation for comparisons. |
| **Field reference rewrite** | Property: renaming any referenced field leaves the stored canonical form unchanged (refs stored by field ID) and the displayed text updated. |
| **Dependency extraction** | `deps(ast)` equals the set of field IDs referenced; for lookups through links includes `(linkField, targetField)` pairs. |
| **Performance** | Bench: 100k evaluations of a 30-node formula ≤ 50 ms on CI reference machine. |

### 52.6.6 Filter, sort, group equivalence (critical)

**Why critical:** the same filter AST is evaluated in at least four places — (1) SQL compiler against `records.cells` JSONB (small tables), (2) SQL compiler using **typed index sidecars** (large tables, `INDEX_SIDECAR_THRESHOLD`), (3) the **in-memory evaluator** used by realtime to decide whether a changed record enters/leaves a client's view, by automation trigger conditions (“when record matches conditions”), and by interface element filters, and (4) the client-side evaluator for optimistic view membership. Any divergence is a user-visible bug (“record vanishes then reappears”) or a **security** bug (interface user filters / row policies).

**Property `filterEquivalence`:**

```
∀ schema S ← arbSchema, records R ← arbRecords(S, 0..300), filter F ← arbFilterAst(S), tz ← arbTimezone, now ← arbInstant:
  ids_sql_jsonb   = execSql(compileFilter(F, S, { sidecars: false, tz, now }), R)
  ids_sql_sidecar = execSql(compileFilter(F, S, { sidecars: true,  tz, now }), R)
  ids_mem_server  = R.filter(r => evalFilter(F, S, r, { tz, now }))
  ids_mem_client  = (same evaluator package, browser build)  [nightly]
  assert ids_sql_jsonb == ids_sql_sidecar == ids_mem_server (== ids_mem_client)
```

Required coverage dimensions (the generator is weighted to hit these):

* Empty semantics: absent key vs empty string vs empty array vs `false` checkbox; `isEmpty` on lookups whose all values are empty; `!=` on empty (must include empty cells, per our spec in [`11-filter-sort-group.md`](./11-filter-sort-group.md)).
* Numeric: JSON numbers vs currency decimal strings (SQL must cast `numeric`, not `float8`), `-0`, very large/small, precision-rounded display vs stored value (filter on stored value).
* Text: case-insensitivity and accent rules (both sides use the same ICU collation and the same normalization — NFC), `contains` with LIKE metacharacters, leading/trailing whitespace, emoji.
* Dates: `date` vs `datetime` with field timezone, relative operators at **DST transitions** and midnight boundaries, `isWithin` past/next N days, week start locale.
* Selects: option deleted (cell holds orphan ID), `hasAnyOf`/`hasAllOf`/`isExactly` on multi-select, option order for sort.
* Links/lookups/rollups: filter on `computed` values, stale markers (records with `computed_stale` rows — SQL and memory must agree to use the materialized value; staleness is a separate UI concern).
* Collaborator: `me` macro resolved per principal.

**Property `sortEquivalence`:** `ORDER BY` from the SQL compiler (with sort-key expressions and the tie-breaker `(row_order, id)`) equals `R.sort(compareBySpec)` in memory; empties sort last ascending and first descending (our spec). Collation: Postgres uses an ICU collation `und-u-ks-level2` created by migration; JS uses `Intl.Collator('und', { sensitivity: 'accent' })` — the equivalence test runs against a pinned ICU version and the CI image asserts `icu_version` matches the version vendored in the client build; mismatch is a test failure, not a flake.

**Property `groupEquivalence`:** group keys and counts from SQL aggregation equal in-memory grouping, including multi-select "group by each option" semantics and empty group placement.

**Property `pageStability`:** paginating a sorted+filtered view with cursor size k ∈ {1, 7, 200} yields exactly the full ordered result, no duplicates/omissions, including while concurrent updates move records across the cursor boundary (keyset cursor includes the full sort tuple + id).

These properties run at `numRuns=200` on PR (when `@tabula/filter`, `@tabula/fields` or `data` migrations change) and `numRuns=20_000` nightly with fresh seeds.

### 52.6.7 Field conversion matrix tests

* The matrix is **generated from the registry**: for every ordered pair (A, B) of convertible field types (~30 × 30), the registry declares `conversion(A→B) ∈ {lossless, lossy, recompute, forbidden}` plus a converter. A test enumerates all pairs; **an undeclared pair fails CI**.
* For each declared pair, property test over `arbCellValue(A)`:
  * `forbidden` → API returns `FIELD_TYPE_CHANGE_UNSUPPORTED`, no state change.
  * `lossless` → `convert(B→A)(convert(A→B)(x)) == x`.
  * `lossy` → the **preview** endpoint (`dryRun`) reports exactly the set of cells that will change/clear, and the actual conversion produces exactly the previewed result (preview == execution).
  * All conversions: undo restores original values bit-exactly (inverse ops store original cells), dependent formulas are re-typechecked (become `invalid` with a clear error if the type no longer fits), filters referencing the field are migrated or flagged (`view.config` filter conditions with now-invalid operators are **disabled, not dropped**), sidecar index entries rebuilt.
* Large conversion (≥ 10k records) runs as a `long_operation`; tests assert chunked progress, resumability after worker kill mid-way (idempotent per chunk), and that edits made **during** conversion to the field are either rejected with `FIELD_CONVERSION_IN_PROGRESS` or applied post-conversion — never lost.

### 52.6.8 Compute engine tests (`@tabula/compute`)

* **Incremental = full recompute (model-based):** `fc.commands` with operations: create/update/delete record, add/remove link, change formula, convert field type, delete/restore field, delete/restore record. After each command, the materialized `records.computed` for all records equals `fullRecompute(schema, cells, links)`. Runs with `COMPUTE_SYNC_FANOUT_LIMIT` set to tiny values (1, 3) to force the deferred path, then drains `compute` queue before comparing.
* **Cycle detection**: random DAG + one random back-edge → schema change rejected with `FORMULA_CIRCULAR_REFERENCE` listing the cycle path; graph unchanged.
* **Depth limit**: chain of 33 dependent fields → 33rd rejected (`MAX_DEPENDENCY_CHAIN`).
* **Staleness**: records marked in `computed_stale` are visible in API responses with `meta.stale` flags (per [`06-record-storage.md`](./06-record-storage.md)) and cleared after drain; no record stays stale > SLO under steady load (soak metric).
* **Volatile bucket** tests with `FakeClock` crossing midnight in multiple base timezones.

### 52.6.9 Linked records tests

* **Symmetry invariant**: for every `link_relation`, side A's view of links equals the transpose of side B's view (single `record_links` row per pair guarantees this structurally; tests assert APIs never expose divergence, including order keys per side).
* **Cardinality**: `allowMultiple=false` enforced under concurrent adds (two clients add different targets simultaneously → exactly one survives, LWW by `change_seq`, the other client receives a corrective op).
* **Delete cascade**: deleting a record removes its links (soft-deleted with the record's `deletion_batch` so restore re-links), recomputes lookups/rollups/counts on the other side, emits `record.links_changed` for affected counterpart records.
* **Fan-out**: 100k links on one record — lookup recompute deferred, UI paginates linked records, `count` field correct.

### 52.6.10 Automation tests

* **Deterministic engine harness** `testkit.automations`: `FakeClock`, `FakeConnector`s with programmable responses (`succeed`, `fail(500)`, `timeout`, `rateLimit(retryAfter)`, `succeedAfter(n)`), event injection, `drain()`.
* Scenarios: trigger matching for every trigger type; condition evaluation (in-memory filter → covered by 52.6.6); step retries with backoff schedule exactly as specified; **idempotency** (same `trigger_event_id` delivered twice → one run, unique `(automation_id, trigger_event_id)`); **step idempotency keys** passed to connectors (connector stub asserts duplicate key not double-applied); **lease expiry** (worker killed mid-step → reconciler re-enqueues after lease; step re-executed with same idempotency key); **loop guard** (automation A updates record → triggers A → … stops at `MAX_CAUSATION_DEPTH = 8`, run marked `loop_limited`, `automation.disabled_by_system` emitted only if budget exceeded repeatedly); **budgets** (`ratebudget:automation:*` exhausted → runs queued as `throttled`, not dropped); version pinning (run uses the `automation_version` that was published at trigger time).
* **Script sandbox**: CPU limit (infinite loop terminated at 30 s wall/CPU budget), memory limit (allocation bomb → isolate disposed), no ambient network (only `fetch` via egress proxy with allowlist), no access to `process`, `require`, timers beyond budget; escape suite in 52.6.18.

### 52.6.11 Permission tests

**Generated matrix:** `roles (org × workspace × base × interface) × actions (spine §9 list, 35 actions) × resources (table/field/view/record/interface/automation, with/without restrictions)`. The expected outcome is computed by an **independent, deliberately naive reference model** (`permissions.reference.ts`, ~300 lines, written by a different engineer from the production evaluator, reviewed by security) — the production evaluator (compiled `PermissionSnapshot`) must agree on every cell of the matrix (~120k combinations, runs in < 20 s as a pure test). Any disagreement shrinks to a minimal grant set.

**Channel enforcement tests (“canary” technique):** for field masking, record visibility (interface record scoping, Enterprise row policies), and table restrictions, a world is built where a hidden field contains a unique canary string `CANARY-<uuid>` and a hidden record contains another. Then **every egress channel** is exercised as the unauthorized principal, and the test asserts the canary bytes never appear in any response body, WebSocket frame, email, webhook payload, file, or log line:

| Channel | How exercised |
|---|---|
| REST read (list, get, query, `cellFormat=string`) | API calls |
| REST filter/sort *on* hidden field | must be rejected (`FIELD_NOT_ACCESSIBLE`) — filtering is an oracle attack (binary search by `>`) |
| Realtime | subscribe; another user edits hidden field; frame capture |
| Search | query for canary; result counts and snippets |
| Formula/lookup/rollup | visible formula referencing hidden field — value policy per [`19-permissions-and-multitenancy.md`](./19-permissions-and-multitenancy.md) (computed value visible only if the field's definition owner allowed; the *formula text* never reveals hidden field names) |
| Export (CSV/XLSX) | export job output file |
| Shared views & forms | share link fetch, form prefill params |
| Interfaces | element data endpoints, record detail, linked record picker |
| Comments/mentions/notifications | notification payload & email body |
| Webhooks | outbound payload for subscriber without access |
| Automations | run as owner vs triggering user (owner-run semantics documented) |
| AI | prompt assembly log (`ai_invocations` input hash + debug capture in test) — hidden field content must not be in the prompt |
| Audit/logs | pino log capture — canary not logged at info level |
| Attachments | signed URL issuance for attachment in hidden field → 403 |
| Revision history/undo | record history endpoint |

**Revocation tests:** permission changes bump `perm_epoch`; tests assert (a) the next HTTP request uses the new snapshot (no stale Redis snapshot), (b) open WebSocket subscriptions are re-authorized within 2 s and frames for now-hidden fields stop, (c) queued exports/automations started by the revoked user are cancelled or proceed under owner semantics as specified.

### 52.6.12 Realtime tests

* **Protocol unit tests**: op encoding, sequence handling, gap detection, resubscribe.
* **Deterministic multi-client simulation** (`testkit.realtime.sim`): N virtual clients (in-process), a real server stack (api + realtime roles in process, real Postgres, Redis), and a **controllable network** (per-client message queues with an adversarial scheduler that reorders deliveries *across* clients, delays, drops connections, and replays). fast-check `fc.scheduler()` drives interleavings. Operations from `arbOps`.
  * **Convergence property:** after all clients reconnect and quiesce, every client's RecordStore == server state (read via API) for all subscribed records; every client's applied `change_seq` == server `base_runtime.change_seq`.
  * **No lost acknowledged writes:** every op acknowledged to a client is reflected in final state unless overwritten by a later `change_seq` (checked with an LWW oracle over the server's total order).
  * **Optimistic rollback correctness:** ops rejected by the server (permission, validation, conflict with `If-Match`) are rolled back on the client and the final UI state equals server state.
  * **Catch-up:** client offline for k changes (k ≤ retention) gets exactly the missing range from `base_changes`; beyond retention or after a schema change requiring full reload → `resync_required` and full reload.
* **Multi-node fan-out**: two `realtime` processes subscribing to the event bus; client A on node 1, client B on node 2; ordering preserved per base.
* **Playwright realtime E2E**: 3 browser contexts editing the same grid with network throttling and `context.setOffline(true)` toggles.

### 52.6.13 Undo/redo & history tests

* Model-based: random op sequences with interleaved undo/redo from 2 users; invariant: undoing user U's change C restores the **cells C changed** to C's pre-images *unless* a later change by someone else touched the same cell — then undo is a no-op for that cell and reports `UNDO_CONFLICT` partial (per [`22-audit-history-undo-trash.md`](./22-audit-history-undo-trash.md)).
* Undo of schema ops (field delete → restore with data; field type change → revert with original cells).
* Trash: delete table/base → restore within retention restores records, links, views, automations (paused), share links (still revoked unless re-enabled — security default).

### 52.6.14 Search tests

* Indexing: every `record.*` / `field.*` / schema event produces the right `search_documents` (MVP) or OpenSearch doc (V1) — run against both backends with the same suite.
* **Permission filtering** is post-query-safe: searching as a user without access to base X returns no hits and **no counts** that reveal existence.
* Hidden field content not indexed into the user-visible document unless the index stores per-field and filters at query time (V1 design: per-field `field_slot` subdocuments; query restricted to visible slots).
* Lag test: P95 index latency < 5 s at nightly load.

### 52.6.15 Import/export tests

* Golden files: CSV (UTF-8 with/without BOM, UTF-16LE, Windows-1252, `;`-delimited, quoted newlines, ragged rows), XLSX (dates as serials incl. 1900 leap bug, merged cells, multiple sheets, formulas → values), JSON.
* Roundtrip property: export(view) → import into empty table with inferred types → re-export == original export for lossless types.
* **CSV injection**: exported cells starting with `=`, `+`, `-`, `@`, tab, CR are prefixed with `'` (configurable per export for "raw").
* 1M-row import: streaming parse, chunked commits (`records.bulk_changed`), resumable from the last committed chunk, row errors to `import_errors`, memory ceiling (worker RSS < 512 MB).

### 52.6.16 Frontend tests

* **Component tests** (Vitest + Testing Library) for forms, field editors, filter builder, interface element configurators.
* **Canvas grid**: unit tests on layout & hit-testing; Playwright visual snapshots per field type renderer; **a11y**: the grid maintains an offscreen ARIA grid mirror for the focused region — tests assert `role=grid`, `aria-rowcount`, `aria-colindex`, focus movement announcements, and keyboard-only flows (navigate, edit, expand record, fill-down) with screen-reader-oriented assertions.
* **Performance**: Playwright + Chrome tracing on a 1M-row table: scroll 10k px/s for 10 s → frame time p95 < 16.7 ms, no long tasks > 50 ms, heap < 500 MB.

### 52.6.17 E2E critical journeys (Playwright)

Smoke (PR, 12): sign-up+verify, login+MFA, create base from template, add fields of 10 types, edit cells + undo, filter/sort/group view, link two tables + lookup, form submit via share link, invite collaborator (email capture) and realtime co-edit, create & run automation (record created → send email), API token create + `records:query`, attachment upload + thumbnail.

Full (nightly, ~60) adds: SSO (SAML) login + JIT provisioning, SCIM deprovision effect, interfaces build+publish+use as interface-only user, CSV import 10k rows with mapping, export, webhooks subscription + delivery + replay, trash/restore table, snapshot restore, AI field generation (fake provider), comments + mentions + notification email, contacts merge/unmerge, plan downgrade flow, billing upgrade (Stripe test), admin audit log search, share link password + expiry, mobile viewport record detail, keyboard-only grid editing, field type conversion with preview, base duplicate, sync source, row policy (Enterprise) behavior.

### 52.6.18 Security tests

* **ZAP**: authenticated API scan from OpenAPI (session + PAT contexts); spider of SPA routes; active scan on staging nightly; alerts above Low fail the nightly and page AppSec on High.
* **SSRF suite** (`security/ssrf.spec.ts`), applied to **every** egress point: webhook targets, automation HTTP action, script `fetch`, URL attachment import ("attach from URL"), integration OAuth callbacks, AI tool URLs, import-from-URL, avatar URLs. Payloads: `127.0.0.1`, `localhost`, `0.0.0.0`, `[::1]`, `[::ffff:127.0.0.1]`, `169.254.169.254` (+ IMDSv2 token path), `fd00::/8`, decimal/octal/hex IP encodings (`2130706433`, `0177.0.0.1`, `0x7f000001`), DNS names resolving to private IPs, **DNS rebinding** (resolver stub returns public then private), redirects 301/302/307 to private addresses, `file://`, `gopher://`, `dict://`, IPv6 zone IDs, ports outside allowlist, overlong URLs, userinfo tricks (`http://good@evil`). Expected: blocked at the egress proxy with `EGRESS_DESTINATION_BLOCKED`, connection never opened (asserted by a canary listener on the private range in the test network).
* **Sandbox escape suite**: prototype pollution of host objects, `constructor.constructor('return process')()`, `SharedArrayBuffer`/timing, `WebAssembly` memory bombs, deep recursion, `Atomics.wait` hangs, `Proxy` traps on transferred objects, ReDoS in user regex.
* **AuthN/AuthZ**: session fixation, cookie flags, CSRF (double-submit / `SameSite=Lax` + Origin check for state-changing first-party calls), PAT scope enforcement, OAuth PKCE downgrade, refresh-token reuse detection (family revocation), IDOR fuzz (swap IDs across tenants for every path param — automated from OpenAPI).
* **Upload**: polyglot files, SVG with script (served with `Content-Disposition: attachment` + CSP sandbox from a separate cookieless domain), zip bombs in XLSX import, EXIF GPS stripping in variants, MIME sniffing mismatch.
* **Formula/Filter injection**: SQL compiler property test with adversarial strings in every literal position; asserts that compiled SQL uses parameters only (no literal concatenation — checked by parsing the generated SQL with `pg-query-parser` and asserting all literals are `$n` params).
* **Rate limiting & abuse**: login brute force lockout, form spam (rate + optional captcha by the *product*, which our tests stub), public share link scraping limits.
* External **pentest** before GA and annually; bug bounty after V1.

### 52.6.19 Multi-tenant isolation fuzzing

`tenant-fuzz` (nightly, 30 min): builds 20 tenants across 2 shards with random schemas; a principal from tenant T issues random valid API calls (from Schemathesis + our op generators) **with IDs substituted from other tenants** (bases, tables, fields, records, views, attachments, comments, automations, share links, webhooks, tokens). Oracles:

1. Response is 404 (`NOT_FOUND`) — never 403 (existence oracle) — and never 2xx.
2. Database audit: a Postgres `log_statement`-free trigger-less check — after the run, a verifier scans `base_changes` and `outbox_events` and asserts every row's `workspace_id` belongs to the actor's accessible set (no cross-tenant writes).
3. Response bodies scanned for any foreign tenant's canary values.
4. Cache keys: Redis keyspace scan asserts every `perm:*`/`schema:*` entry accessed by T's requests belongs to T's bases (instrumented cache adapter).

### 52.6.20 Load tests (k6)

Environment: dedicated `perf` environment sized like a single production cell (1 data shard `db.r7g.4xlarge`, 1 control-plane `db.r7g.2xlarge`, api ×6, realtime ×4, worker pools autoscaled). Seeded by `testkit.synthetic` (rawInsert + rebuild).

| ID | Scenario | Load shape | Targets (pass criteria) |
|---|---|---|---|
| L1 | **Grid scroll on 1M-row table** (40 fields incl. 5 lookups, 3 formulas; view filtered on 2 fields + sorted on 1 sidecar-indexed field) | 200 VUs each scrolling: fetch 200-row windows at random offsets and sequential keyset pages | window fetch p50 < 80 ms, p95 < 250 ms, p99 < 600 ms; DB CPU < 60%; zero errors; initial view load (schema + first window + count) p95 < 1.2 s |
| L2 | **500 concurrent editors on one base** | 500 WS clients; each 1 cell edit / 2 s (250 ops/s) on a 50k-record table, 20% on the same 1k "hot" records; 10% link ops | op ack p95 < 150 ms, p99 < 400 ms; fan-out delivery to other clients p95 < 300 ms; `base_runtime.change_seq` row lock wait p99 < 20 ms; no convergence violations (post-run verifier) |
| L3 | **10k automation runs/min** | record-created trigger from API writes across 500 bases; automations with 3 steps (condition, update record, HTTP to fake endpoint) | trigger→run start p95 < 5 s; run completion p95 < 20 s; no duplicate runs (unique check); queue depth returns to baseline within 2 min after load stops |
| L4 | **Import 1M rows** (CSV 20 columns, 400 MB) | 1 import + background L1 at 50 VUs | completes < 20 min; L1 p95 degrades < 30%; worker RSS < 1 GB; replication lag < 10 s |
| L5 | API mixed traffic | 2k req/s: 70% reads, 20% `records:query`, 10% batch writes | p95 < 300 ms; 429s only when over per-token limits |
| L6 | Compute fan-out | update a record linked from 50k records with rollups | deferred recompute completes < 60 s; sync path never exceeds `COMPUTE_SYNC_FANOUT_LIMIT` |
| L7 | Realtime connection storm | 50k WS connects in 60 s (deploy reconnect herd) | gateway accepts with jittered backoff; CP DB connection count stable (session validation from Redis) |
| L8 | Webhook delivery | 2k deliveries/s to fake receivers with 5% 500s and 2% timeouts | delivery p95 < 10 s from commit; retries obey schedule; no duplicate delivery IDs |

Load results are written to Grafana with a run annotation; regression > 20% on any p95 vs last baseline fails the pre-release gate.

### 52.6.21 Soak tests

* **S1 (24 h weekly, 72 h pre-GA):** L2 at 40% + L3 at 30% + L5 at 30%. Watch: heap growth on api/realtime (< 5%/24h after warm-up), Redis memory, BullMQ completed-job retention, `base_changes` partition rotation at midnight, Postgres bloat/autovacuum on `records` and `base_runtime` (HOT updates ratio > 90% on `base_runtime`), connection pool leaks, logical replication slot lag (< 30 s), relay restarts.
* **S2 (24 h):** scheduled automations every minute across 2k bases + volatile formula buckets crossing a DST transition (staging clock offset tooling via `FakeClock`-compatible “time travel” for the scheduler role only).

### 52.6.22 Chaos tests

| ID | Experiment | Expected outcome |
|---|---|---|
| C1 | Kill `relay` pod during high write load | Standby relay acquires slot lease within 30 s; no lost/duplicated events beyond at-least-once (consumers dedupe by event id); realtime clients see a pause, then catch up |
| C2 | RDS failover of a data shard (Multi-AZ) mid-transaction | In-flight transactions fail with retriable error; API retries idempotent requests (with `Idempotency-Key`) once; no partial writes (outbox+state atomic); logical replication slot recreated per [`27-data-flows-transactions-migrations.md`](./27-data-flows-transactions-migrations.md) slot-loss procedure |
| C3 | Redis (BullMQ) primary failover | Jobs in flight re-delivered; reconciler re-enqueues stuck Postgres-state rows; no lost automation runs |
| C4 | Kafka broker loss | Producer retries (idempotent producer); consumer rebalance; lag recovers |
| C5 | Network partition api ↔ Redis | Permission snapshot cache misses fall back to Postgres compile; rate limiter fails **open for reads, closed for expensive ops** per policy; sessions validated from Postgres |
| C6 | Worker pool OOM loop on poison job | Job moved to DLQ after N attempts; other jobs unaffected |
| C7 | S3 latency 5 s | Upload presign unaffected; thumbnail processing backs off; UI shows pending variants |
| C8 | Clock skew +90 s on one api node | No business logic uses node wall clock for ordering (change_seq ordering); session expiry tolerance; JWT-like tokens (OAuth) validated with ±60 s leeway; warning alert from NTP monitoring |
| C9 | Realtime node drain (deploy) | Clients reconnect to other nodes with jitter, resume from last seq, no full reload |
| C10 | AZ impairment | Service degrades within SLO; RDS standby promoted; no cross-tenant routing errors |
| C11 | Sandbox node exhaustion | Script steps queue with backpressure, not failure; timeouts reported per run |
| C12 | Control plane DB read-only (failover) | Data-plane reads/writes for already-routed workspaces continue using cached routing + session cache; sign-ups/billing degrade gracefully |

### 52.6.23 DR restore drills

* **Quarterly per region:** restore one data shard from PITR to a fresh cluster at T−15 min in an isolated account; run the **restore verification suite**: row counts per workspace vs control-plane expectations, checksum sample of 10k records, `base_runtime.change_seq` ≥ max(`base_changes.seq`), relay can create a new slot and resume, attachment object references resolvable (S3 cross-region replica), search reindex job from restored shard completes. Targets: RPO ≤ 5 min, RTO ≤ 4 h for a shard (Enterprise contract may tighten).
* **Base-level restore** (snapshot → new base) tested weekly in staging with a 500k-record base.
* **Control plane restore** drill semiannually including Jackson SSO config and KMS key access.
* Drill results are recorded as audit evidence (SOC 2).

## 52.7 Critical test cases (given / when / then)

Each test case ID is referenced from code (`it('TC-07 …')`) and from the edge-case tables (§53). Layer: U = unit, P = property, I = integration, C = contract, E = E2E, L = load, X = chaos/DR.

| ID | Layer | Given | When | Then |
|---|---|---|---|---|
| TC-01 | P | Random schema S, 0–300 random records, random filter F, random tz/now | F compiled to SQL (JSONB path), to SQL (sidecars), and evaluated in memory | All three return identical record ID sets (52.6.6) |
| TC-02 | P | Random sort spec over text/number/date/select/lookup fields | Sorted via SQL and via in-memory comparator | Identical order incl. tie-break `(row order, id)` and empty placement |
| TC-03 | P | Random op sequence (model-based) on a schema with links, lookups, rollups, formulas; fan-out limit forced to 1 | Each op committed and `compute` queue drained | Materialized `records.computed` == full recompute for every record |
| TC-04 | I | Formula A references B; B references C | User edits C's formula to reference A | 422 `FORMULA_CIRCULAR_REFERENCE` with path `C→A→B→C`; `field_dependencies` unchanged; no `base_changes` row |
| TC-05 | I | Deals links to Companies; Deal D links to company X; Deals has lookup of X.ARR and rollup SUM | Company X deleted | D's link no longer contains X; lookup empty; rollup recomputed; `record.links_changed` for D; deletion batch restorable; restoring X re-creates the link and recomputes |
| TC-06 | I | Automation A: "when record updated → update same record" whose condition matches its own output | One user edit triggers A | Chain stops when `causationDepth` reaches `MAX_CAUSATION_DEPTH` (8); next trigger suppressed, run recorded `loop_limited`; owner notified once |
| TC-07 | I | Inbound webhook endpoint wired to an automation; sender retries | Same payload with same `Idempotency-Key` (or same body hash within 24 h when the sender sends none, configurable) arrives twice, 200 ms apart, on two api nodes | Exactly one `automation_runs` row; second request 200 with `duplicate: true` |
| TC-08 | I | Outbound webhook subscriber returns 500 then 200 | Delivery attempted | Second attempt after backoff; same delivery ID header; identical payload; cursor advanced once |
| TC-09 | I | Presigned multipart upload started; client uploads 2/3 parts then disconnects | 24 h pass (FakeClock) | Pending `attachments` row expired; multipart aborted; no cell referenced it; quota reservation released |
| TC-10 | I | Uploaded file contains EICAR | Scan completes | Attachment `rejected`; removed from cell via system op (`actor.type=system`); uploader notified; quarantine object deleted; `attachment.rejected` emitted |
| TC-11 | P | Every declared conversion pair A→B, random values | `dryRun` preview then conversion | Execution == preview; undo restores originals; dependents retypechecked |
| TC-12 | I | Text field with "1,234.50", "abc", "", "  42 " (en-US) | Converted to `number` | 1234.5, cleared (reported), absent, 42; report counts 1 cleared; filter `> 100` on the field stays valid |
| TC-13 | I | single_select used in view filter `is Gold` | Option Gold deleted | Cells cleared with inverse ops stored; filter condition marked invalid and **disabled** with UI warning (never silently dropped) |
| TC-14 | E | Alice and Bob in the same grid, throttled network | Both edit the same cell within 50 ms | Both converge on the higher `change_seq`; loser sees a "changed by …" flash; history shows both revisions |
| TC-15 | P | 5 simulated clients, random ops, adversarial delivery scheduler with disconnects | Run to quiescence | Every client store == server state (52.6.12) |
| TC-16 | E | Editor typing in a cell; network offline 30 s | Edits made offline; network restored | Pending ops retried with same client op IDs (server dedupes); "offline — changes pending" indicator; converges; rejected ops surfaced in a "couldn't save" list |
| TC-17 | I | Bob is editor, editing over WS | Admin downgrades Bob to viewer | `perm_epoch` bumped; next op rejected `PERMISSION_DENIED`; server pushes `permissions_changed`; client switches to read-only ≤ 2 s; optimistic edit rolled back |
| TC-18 | I | User U in workspace W with sessions + PAT | U removed from W | Grants via W gone; WS subscriptions to W's bases closed; PAT calls → 404; U's automations follow the org ownership policy (transfer or pause); history attribution retained |
| TC-19 | X | Automation run at step 2 of 4 in base B | B soft-deleted | Step runner checks base status before each step & on lease renewal → run `cancelled` (`reason: base_deleted`); no writes after delete; restoring B does not resume (runs listed with retry) |
| TC-20 | I | Steps: (1) create record ✓ (2) Slack ✓ (3) HTTP fails permanently | Run executes | Run `failed` at step 3; steps 1–2 not rolled back (documented); retry-from-failed-step reuses outputs, no duplicates |
| TC-21 | I | Enterprise hidden field F for viewer | Viewer queries with filter or sort on F | 422 `FIELD_NOT_ACCESSIBLE`, independent of data (no oracle) |
| TC-22 | P | Generated principal × action × resource matrix | Production evaluator vs reference model | 100% agreement |
| TC-23 | I | Canary values in hidden field and hidden record | Unauthorized principal exercises all egress channels (52.6.11) | Canary never appears |
| TC-24 | I | Interface element filter `Owner = current user` for interface-only user U | U sends crafted params (filter override, underlying `viewId`, foreign `recordId`, sort by hidden field) | Server-side element scope enforced; client params can only narrow; foreign record → 404 |
| TC-25 | I | Share link to view V | V soft-deleted, then restored | 410 `SHARE_TARGET_DELETED` while deleted; after restore link stays **disabled** until a creator re-enables |
| TC-26 | E | SSO user with active session; SCIM directory | IdP sends SCIM `active=false` | `user.deactivated`; sessions & PATs revoked ≤ 60 s; WS closed `session_revoked`; API 401 |
| TC-27 | I | Record version 7, two api nodes | Two `PATCH` with `If-Match: "7"` race | Exactly one 200 (v8); other 412 with current version |
| TC-28 | I | Trigger matcher processes event E, crashes before offset commit | Restart, E redelivered | Run deduped by `(automation_id, trigger_event_id)` |
| TC-29 | X | Relay on shard S; logical slot lost (failover without slot sync) | Relay restarts | Recovery mode: new slot, backfill from durable `outbox_events`/`base_changes` beyond last published checkpoint, original event IDs, consumers dedupe, alert |
| TC-30 | X | Shard failover while a 1000-record batch commits | Client retries with same `Idempotency-Key` | Either committed once (retry returns stored response) or not at all; never partial |
| TC-31 | I | Base with 120k records; org downgrades Business → Team (100k limit) | Downgrade processed | Data retained; base **over-limit**: creates blocked `RECORD_LIMIT_EXCEEDED`, edits/deletes allowed; banner; nothing deleted |
| TC-32 | I | Base tz `Pacific/Auckland`; formula `IS_SAME(TODAY(), {Due}, 'day')` | FakeClock crosses NZ DST start | Volatile bucket recompute fires once at local midnight; values correct both sides |
| TC-33 | I | Record with 100k links | Open record; add one more link | Linked records paginated (first 100); insert O(1); `count` = 100,001; lookup recompute deferred then completes |
| TC-34 | E | Clipboard with 1000 × 50 TSV | Paste at A1 of a 600-row table | Chunked batches ≤ 1000; confirm creating 400 rows; progress UI; one undo entry (shared `correlationId`) |
| TC-35 | I | Formula references field F | F deleted, then restored | Formula invalid (`FIELD_REF_DELETED`), values show error; restore heals + recompute |
| TC-36 | I | Primary field is text | Delete it / convert to attachment | Delete → `PRIMARY_FIELD_REQUIRED`; ineligible conversion rejected; conversion to formula allowed |
| TC-37 | L | 1M-row table | L1 | Targets met |
| TC-38 | L | 500 editors | L2 | Targets met; convergence verifier passes |
| TC-39 | C | Released v1 OpenAPI | PR removes a response property | oasdiff fails build |
| TC-40 | I | Migration adding indexed column to `records` | Run on prod-like snapshot | `CREATE INDEX CONCURRENTLY` per partition; max ACCESS EXCLUSIVE < 2 s; N-1 smoke passes |
| TC-41 | X | PITR restore of shard to T−15 min | Verification suite | Counts/checksums match; relay resumes; RPO/RTO met |
| TC-42 | I | HTTP action URL `http://169.254.169.254/…` (+ DNS-rebinding variant) | Step executes | `EGRESS_DESTINATION_BLOCKED`; no connection opened; non-retriable |
| TC-43 | I | AI field; invoking context cannot see field H; template references `{H}` | Config save and generation | Config rejected for that context; runtime omission flagged; captured prompt contains no H content |
| TC-44 | I | Alice's change C; Bob later edited one of C's cells | Alice undoes C | Cells untouched by Bob reverted; Bob's cell kept; response `UNDO_PARTIAL` lists skipped cells |

## 52.8 CI strategy

### 52.8.1 Pipeline (GitHub Actions; pnpm + Turborepo task graph)

```
PR opened/updated
 ├─ stage 0 (≤ 2 min): install (pnpm store cache), typecheck (tsc -b, affected), eslint (+ module-boundary rules),
 │                      semgrep, prettier, squawk migration lint, openapi:gen drift check, event-schema drift check
 ├─ stage 1 (parallel, ≤ 8 min):
 │    ├─ unit          (affected, Vitest --shard=i/8)
 │    ├─ property      (affected, PR profile numRuns)
 │    ├─ integration   (affected modules, --shard=i/16; each shard has its own Testcontainers set)
 │    ├─ contract      (oasdiff, response conformance, event schemas)
 │    └─ web           (component tests + bundle budget: initial JS ≤ 350 kB gz)
 ├─ stage 2 (≤ 8 min): build image → PR preview env (ephemeral namespace, seeded) →
 │                      Playwright smoke (×4) + axe + ZAP baseline
 └─ gates: all required; changed-lines coverage ≥ 80% in engine packages; quarantine rules (52.8.4)

main merge → full integration, full E2E (×8), cosign image signing, deploy to staging
nightly    → property ×20 runs fresh seeds, Schemathesis, tenant-fuzz, ZAP full, k6 reduced (L1/L2/L3 at 25%),
             migrations on prod-like snapshot, browser matrix for formula/filter equivalence, real ClamAV, ai-smoke
weekly     → Stryker mutation, 24 h soak, chaos game-day on staging
pre-release→ full k6, 72 h soak (pre-GA), DR verification (quarterly cadence)
```

### 52.8.2 Sharding

* **Timing-balanced shards:** a `test-timings.json` artifact from the latest main run feeds a custom Vitest sequencer that bin-packs files so shard wall times differ < 15%.
* **Integration shards** start their own Postgres/Redis/Redpanda; the template DB is built once per shard (~10 s). Containers run on `tmpfs` with `fsync=off, synchronous_commit=off, full_page_writes=off` — **except** the `durability` suite (relay, logical replication, failover simulation) which uses production settings.
* **Playwright** shards (4 on PR / 8 on main); each shard seeds isolated orgs via `/internal/testing/seed`, an endpoint compiled out of production images (build flag `TABULA_TESTING_ENDPOINTS` + startup assertion that it is false when `NODE_ENV=production`).

### 52.8.3 Affected-test selection

Turborepo's graph selects affected packages. **Global triggers** force full runs: `packages/db/migrations/**`, `@tabula/fields`, `@tabula/filter`, `@tabula/permissions`, `@tabula/events`, `@tabula/formula`, CI config, lockfile. Main always runs everything.

### 52.8.4 Flaky test policy & quarantine

* **Detection:** each failure on main is re-run once in isolation; pass-on-retry ⇒ flagged *flaky*, recorded (JUnit → test-outcomes table → dashboard).
* **Quarantine:** ≥ 2 flakes in 7 days auto-opens a PR adding the test to `quarantine.json` (test ID, owning team from CODEOWNERS, issue link, expiry +14 days). Quarantined tests still run (non-blocking) so fixes are visible.
* **Non-quarantinable suites:** security, tenant isolation, permission matrix, equivalence properties, RLS coverage. A flake there is a P1 bug.
* **Budgets:** expired entries fail the owning team's packages; > 5 entries per team requires EM sign-off on that team's PRs.
* **Prevention lint:** no `sleep`/`setTimeout` in tests, no `Date.now()`/`new Date()` in domain code (use `Clock`), no array-equality assertions on SQL results without `ORDER BY`, no Playwright `waitForTimeout`. Grid exposes a non-production `window.__tabulaGrid` inspection API (cell at (row,col), visible range) so E2E never pixel-hunts.
* **Property failures are never "flaky":** a fresh-seed failure is a counterexample; the seed is stored in `__regressions__` and an issue opened automatically.

### 52.8.5 Test data management

* All fixtures via builders (52.5). Large datasets generated by `testkit.synthetic`, stored as `pg_dump -Fc` artifacts in S3 keyed by schema hash; restore ≈ 4 min.
* **No production data in tests** except the masked prod-like snapshot pipeline (irreversible tokenization; access limited to the migration-test job role).
* E2E seeds are namespaced by run ID; a janitor deletes namespaces older than 24 h.

## 52.9 Test environments

| Env | Purpose | Data | Topology |
|---|---|---|---|
| Local | dev loop | builders | docker compose: 1 PG (core + 2 shard DBs + audit), Redis, Redpanda, MinIO, Mailpit, Jackson; `pnpm dev` runs all roles in one process |
| CI | automated | builders, synthetic | Testcontainers |
| PR preview | smoke E2E, design review | seed | ephemeral namespace; shared RDS with per-PR databases; BullMQ MVP event profile |
| Staging | full E2E, ZAP, chaos | seed + synthetic | production topology at ¼ scale, 2 data shards, Kafka profile |
| Perf | k6, soak | 1M–50M rows synthetic | one production-sized cell |
| DR sandbox | restore drills | restored backups | isolated AWS account |

## 52.10 Quality gates (testing definition of done)

1. Every new route has tests tagged `@authz` (denial path) and `@tenant` (cross-tenant 404) — enforced by a route-coverage lint.
2. New field types pass `fieldTypeConformance` and are present in the conversion matrix, filter-equivalence generator, formula type system, and import/export goldens.
3. New egress points are registered in the SSRF suite (the `HttpEgress` registry is enumerated by the test).
4. New events have JSON Schemas in the catalogue snapshot.
5. New tables have RLS policies (auto-tested), a retention/partition plan, and appear in the inventory (or "Proposed additions").
6. Hot endpoints have query budgets; new background jobs have a load-profile entry or waiver.
7. Relevant §53 edge cases have linked tests (edge IDs in test names).

---

# Part 50 — Section 53: Edge Cases

Format: **# · Scenario · Expected behavior · Mechanism / owning component** (number in parentheses = owning doc: 06 record storage, 07 field engine, 08 formula, 09 links, 10 views, 11 filter/sort/group, 12 contacts, 13 interfaces, 14 automations, 15 events, 16 realtime, 17 API, 18 search/attachments/collab, 19 permissions/tenancy, 20 import/export/sharing/integrations, 21 AI, 22 history/undo/trash, 23 notifications/jobs/perf, 24 frontend, 25 security/infra, 27 data flows/migrations). Critical tests in brackets.

### 53.1 Records & cells

| # | Scenario | Expected behavior | Mechanism / owner |
|---|---|---|---|
| E001 | Two users edit **different** cells of one record concurrently | Both persist; no conflict | Cell-level LWW; per-slot `cell_meta` (16, 06) |
| E002 | Two users edit the **same** cell concurrently [TC-14] | Higher `change_seq` wins; loser notified; both in history | Per-base total order `base_runtime.change_seq` (16) |
| E003 | API update with stale `If-Match` [TC-27] | 412 with current version | `records.version` CAS (17, 06) |
| E004 | Writing `null` / `""` / `[]` | Normalized to absent key; `isEmpty` true | Field `normalize`; spine rule "empty ⇒ absent" (07) |
| E005 | Text > 10k (`text`) / > 100k (`long_text`) via API | 422 `FIELD_VALIDATION_FAILED`; UI paste truncates with warning | Field validation (07) |
| E006 | Number `1e309`, `NaN`, 20 significant digits | `Infinity`/`NaN` rejected; > 15 digits accepted with precision warning (use currency for exact decimals) | `number.validate` (07) |
| E007 | Currency `"0.005"` with precision 2 | Normalized at write to `"0.01"` (half away from zero), documented | `currency.normalize` (07) |
| E008 | Record approaching JSONB size (500 fields × long text) | `cells` guard ≤ 1 MB compressed per record → 413 `RECORD_TOO_LARGE`; large values TOASTed | Write-path guard (06 §limits) |
| E009 | Record deleted while another user has it expanded | Card shows "deleted by X" + restore (if permitted); edits blocked | `record.deleted` realtime op (16, 24) |
| E010 | Edit arrives for a soft-deleted record (race) | 404 `RECORD_NOT_FOUND`; optimistic op rolled back | Write path checks `deleted_at` under row lock (06) |
| E011 | Bulk delete of 100k records | `long_operation` in chunks under one `deletion_batch`; single trash entry & single undo; dependents recomputed via deferred path | (22, 06) |
| E012 | Autonumber after deletes/restores | Never reused; restored record keeps its `row_number` | `tables.next_row_number` (06) |
| E013 | Form, API, and UI creates race at the plan's record limit | Never exceeds limit; excess → 403 `RECORD_LIMIT_EXCEEDED` | `base_runtime.record_count` (proposed column, 06) checked in the create txn while the `base_runtime` row is already locked for `change_seq` (06, 23) |
| E014 | Paste of 50k cells [TC-34] | Batches ≤ 1000; confirmation for new rows; one undo group | Client paste pipeline + `correlationId` grouping (24, 22) |
| E015 | Paste mismatched types (text → number/select/date) | Per-cell `parseInput`; unparseable cells skipped and reported; new select options only with `field.update` | (07) |
| E016 | Fill-down over rows partially hidden by filter | Only rows visible in the view are modified | Op scoped to view row IDs (10, 24) |
| E017 | Manual reorder in a sorted view | Drag disabled with explanation | (10) |
| E018 | Fractional keys degenerate (thousands of inserts at one spot) | Background rebalance of the range; no visible reorder | Fractional index rebalance (10) |
| E019 | Record created with values for computed fields via API | Computed fields ignored with warning (or 422 when `strict=true`) | Field type `writable=false` (07, 17) |
| E020 | Very wide row edit by two clients each sending full-record PUT | `PUT` treated as replace of provided fields only for API v1 PATCH semantics; full `PUT` requires `If-Match` to avoid clobbering | (17) |

### 53.2 Fields & type changes

| # | Scenario | Expected behavior | Mechanism / owner |
|---|---|---|---|
| E021 | Field type conversion text → number [TC-12] | Preview of lossy cells; long_operation if > 10k records; undoable | Conversion matrix (07) |
| E022 | Converting a field referenced by formulas, filters, sorts, groups, automations, interfaces | Formulas retypechecked (may go invalid); incompatible view conditions **disabled, not dropped**; automations flagged "needs attention"; interface elements show config error | Dependents registry (07, 10, 13, 14) |
| E023 | Edits during conversion of that field | Rejected `FIELD_CONVERSION_IN_PROGRESS`; editors disabled; other fields unaffected | Conversion lock flag checked in write path (07) |
| E024 | Worker dies mid-conversion | Resumes from `long_operations` cursor; chunk application idempotent | (23, 27) |
| E025 | Select option deleted while used in records and a filter [TC-13] | Cells cleared with inverse ops; filter condition disabled + warning | (07, 11) |
| E026 | Select option renamed | O(1) metadata change | Option IDs stored in cells (spine §3) |
| E027 | API write with unknown option label | Creates option only with `typecast=true` and `field.update`; else 422 | (17, 07) |
| E028 | Primary field deleted [TC-36] | Rejected until another primary designated | (07) |
| E029 | Primary field converted to formula | Allowed; link pickers/search use computed primary text | (07, 09) |
| E030 | Field deleted, new field with same name created, old one restored | New field gets new ID + new slot; restored field auto-renamed "Name (restored)" | Slots never reused (spine §3) |
| E031 | 501st field | `FIELD_LIMIT_REACHED` (soft-deleted fields don't count toward limit but consume slots) | (07) |
| E032 | Slot churn approaches smallint max (32,767) through repeated create/delete | Purged slots go to `tables.tombstoned_slots` and are swept from JSONB (06); slots are still never reused, so at 30k an alert fires and further field creation on that table is blocked at 32k with `FIELD_SLOT_SPACE_EXHAUSTED` (recovery: duplicate table, which reassigns compact slots) | (06); see risk R-36 in [34](./34-self-review-risk-register-build-order.md) |
| E033 | Link field target table changed | Treated as conversion: links dropped (preview count), new relation, old inverse field soft-deleted | (09) |
| E034 | link → text | Snapshot of comma-joined primary values; relation soft-deleted (undoable) | (09, 07) |
| E035 | multi_select → single_select | First option by cell order kept; lossy preview | (07) |
| E036 | Datetime display tz changed | No data change (UTC); tz-dependent formulas recomputed | (07, 08) |
| E037 | Field names: RTL, emoji, 1000 chars, case variants | ≤ 255 chars; uniqueness on NFC + case-folded name per table | (07) |
| E038 | Two creators rename different fields to the same name concurrently | Second commit → 409 `FIELD_NAME_TAKEN` | Partial unique index on normalized name where not deleted (05) |
| E039 | Field type change on a 2M-record table on Enterprise | Long operation with throttling (≤ 5k rows/s/shard) to protect replication lag; ETA shown | (07, 23) |

### 53.3 Formulas

| # | Scenario | Expected behavior | Mechanism / owner |
|---|---|---|---|
| E040 | Circular formula [TC-04] | Rejected with cycle path | Cycle detection (08) |
| E041 | Formula references deleted field [TC-35] | Invalid; restore heals | (08, 07) |
| E042 | Divide by zero, `SQRT(-1)`, `LOG(0)` | Typed error values (`ERR_DIV_ZERO`, `ERR_NUM`), sort last, filterable via `isError` | (08) |
| E043 | Nesting depth 65 | `FORMULA_TOO_DEEP` | Parser (08) |
| E044 | 33-level dependency chain | `DEPENDENCY_CHAIN_TOO_LONG` | (08) |
| E045 | `NOW()` in 500k-record table | Bucket recompute on schedule in chunks; "updated x min ago" | Volatile buckets (spine D7) |
| E046 | `DATEADD(d, 1, 'day')` across DST in `America/New_York` | Wall-clock calendar semantics, not +86400 s | tz-aware date lib (08) |
| E047 | Client/server engine version skew during deploy | Server value authoritative; client preview labelled; engine version in compile cache key | (08) |
| E048 | Formula referencing a field hidden from the viewer | Result visible per definition policy; formula text renders `{hidden field}` for that viewer | (19, 08) |
| E049 | Catastrophic regex | Linear-time regex engine (RE2 semantics); per-eval 10 ms cap → `ERR_REGEX_TIMEOUT` | (08) |
| E050 | `REPT('x', 1e6)` | Result capped 100k chars → `ERR_RESULT_TOO_LARGE` | (08) |
| E051 | Formula result type changes (number → text) while used in sort/filter/rollup | Dependents retypechecked; incompatible filter conditions disabled | (08, 11) |
| E052 | Formula over a stale lookup (deferred compute) | Topological order within compute job; record stale until both computed | (08) |
| E053 | Formula referencing a field of a different base by pasted ID | Parse error `FIELD_NOT_FOUND` (refs resolved within table + via links only) | (08) |

### 53.4 Links, lookups, rollups

| # | Scenario | Expected behavior | Mechanism / owner |
|---|---|---|---|
| E054 | Deleted linked record [TC-05] | Links removed (restorable); lookups/rollups recomputed; inverse updated | (09) |
| E055 | 100k links on one record [TC-33] | Paginated; deferred lookups; "showing first 100" | (09) |
| E056 | Linking when user can edit source field but inverse field is edit-restricted | Rejected 403 — a link edit changes both sides | (09, 19) |
| E057 | Self-link table; record linked to itself | Allowed; field graph must be a DAG, record graph may be cyclic | (09) |
| E058 | Single-link field, concurrent adds | One survives (LWW); corrective op to loser | (09, 16) |
| E059 | Rollup over a restricted/hidden target field | Creator must have access at creation; viewers see aggregate per policy; never itemized | (19, 09) |
| E060 | Lookup of lookup of lookup (3 tables) | Allowed within `MAX_DEPENDENCY_CHAIN`; propagation in topo order | (08, 09) |
| E061 | Link target table deleted | Relation soft-deleted; link field shows "broken"; table restore heals | (09, 22) |
| E062 | Cross-base link attempt | Not supported; sync tables are the mechanism | (09, 20) |
| E063 | Picker on a 1M-record target table | Server-side search on primary text; never loads all | (09, 24) |
| E064 | Link order manipulated concurrently | Per-side fractional order keys; LWW per key; set membership commutes | (09, 16) |

### 53.5 Views, filters, sort, group

| # | Scenario | Expected behavior | Mechanism / owner |
|---|---|---|---|
| E065 | Edited record stops matching filter | Remains visible ("sticky", greyed indicator) until refresh/navigation | (24, 10) |
| E066 | Filter on a field later deleted | Condition invalid + disabled; restore re-enables | (11) |
| E067 | Relative date filter (`today`) viewed from different timezones | Uses base/field timezone for collaborative views (documented) | (11) |
| E068 | Group by multi-select | Record appears in each option group; group counts may sum > total | (11) |
| E069 | Sort by multi-value lookup | Key = first value by link order; equivalence-tested | (11) |
| E070 | Filter on JSONB field in 1M-row table without sidecar | Auto-enable sidecar over `INDEX_SIDECAR_THRESHOLD`; "optimizing view" while backfilling | (06, 11) |
| E071 | Locked view config changed by an editor | Rejected unless `view.lock` holder; personal views invisible to others | (10) |
| E072 | Hide all fields | Primary field always visible | (10) |
| E073 | Keyset pagination while rows move | No duplicates/omissions; client re-anchors by record ID | (10, 11) |
| E074 | Filter with 500 conditions / depth 10 | `QUERY_TOO_COMPLEX` (limits: 200 conditions, depth 5) | (11) |
| E075 | `contains "%_\"` | LIKE metacharacters escaped | SQL compiler (11) |
| E076 | Calendar view with `datetime` events crossing DST / multi-day | Rendered in viewer tz with tz label; all-day for `date` fields | (10, 24) |
| E077 | Kanban grouped by select; option deleted | Cards move to "Uncategorized" column | (10) |

### 53.6 Forms

| # | Scenario | Expected behavior | Mechanism / owner |
|---|---|---|---|
| E078 | Field deleted while a public form is open | Unknown fields ignored; required mismatch → 422 "form changed, reload" | (20) |
| E079 | Prefill params for hidden fields | Only fields with `allowPrefill`; values validated; never echoes hidden values | (20) |
| E080 | Spam burst (1000/min/IP) | Per-link + per-IP rate limit; optional challenge | (20, 25) |
| E081 | Attachment upload via form | Presign scoped to link + field; plan limits; scanned before visible | (18, 20) |
| E082 | Submission after base hits record limit | Friendly error; owner notified once/day | (23) |
| E083 | Linked-record field on public form | Picker off by default; when on, shows only primary values within `linkPickerFilter` | (20, 09) |

### 53.7 Interfaces

| # | Scenario | Expected behavior | Mechanism / owner |
|---|---|---|---|
| E084 | User filter bypass attempts [TC-24] | Server-enforced element scope; client params only narrow | (13, 19) |
| E085 | Published interface references a later-deleted field | Element shows "field unavailable"; no crash; draft flagged | (13) |
| E086 | Publish while users are active | `interface.published`; soft reload at next navigation; in-progress edits kept | (13, 16) |
| E087 | Interface-only user calls base/table endpoints | 404 | (19) |
| E088 | Element allows editing a field restricted at field level | Field restriction wins (deny overlay) | (19) |
| E089 | Direct URL to record outside scope | 404 | (13) |
| E090 | Interface element's source view later changed by base creator | Elements bind to table + element-local filter, not to mutable view config (published version is immutable) | (13) |

### 53.8 Automations

| # | Scenario | Expected behavior | Mechanism / owner |
|---|---|---|---|
| E091 | Automation loop [TC-06] | Stopped at depth 8, `loop_limited` | Causation depth (14) |
| E092 | Two automations ping-pong | Same causation chain → guard; report names both | (14) |
| E093 | Base deleted while automation running [TC-19] | Cancelled before next step | (14) |
| E094 | Action partially succeeds [TC-20] | No rollback; retry from failed step | (14) |
| E095 | Trigger event redelivered [TC-28] | Deduped | (14, 15) |
| E096 | Automation edited with runs in flight | Runs pinned to `automation_version` | (14) |
| E097 | Owner leaves workspace | Policy: transfer to workspace owner (default) or pause; runs attributed `actor.type=automation` | (14, 19) |
| E098 | Scheduler leader failover at fire time | Advisory-lock leader election; fire idempotent on `(automation_id, scheduled_for)`; catch-up ≤ 10 min, older skipped & logged | (14, 23) |
| E099 | Scheduled at 02:30 on DST-start day / 01:30 on DST-end | Nonexistent → 03:00; ambiguous → first occurrence only | tz-aware `automation_schedules` (14) |
| E100 | "Matches conditions" flapping | Fires on each transition into matching, debounced 1 s per record | (14) |
| E101 | Monthly run quota exhausted | Runs `throttled_quota`, held 72 h then dropped with report; 80/100% notifications | (14, 23) |
| E102 | Script infinite loop / memory bomb | Isolate killed: `SCRIPT_TIMEOUT` / `SCRIPT_OOM` | Sandbox (14) |
| E103 | Connector token expired mid-run | One refresh; then `integration.auth_failed`, non-retriable failure, connection flagged | (20) |
| E104 | Target record deleted between trigger and step | `RECORD_NOT_FOUND` non-retriable (or "skip if missing" option) | (14) |
| E105 | Import of 1M rows with a "record created" automation | `records.bulk_changed`; per-record triggers only if `includeBulk`, budget-limited | (14, 20) |
| E106 | Automation sends email to 10k recipients via "find records" | Action limit 1000 recipients/run; above → step error with guidance | (14, 23) |

### 53.9 Events & delivery

| # | Scenario | Expected behavior | Mechanism / owner |
|---|---|---|---|
| E107 | Kafka redelivery | At-least-once; consumers idempotent on `event.id` or natural keys | (15) |
| E108 | Relay slot lost [TC-29] | Recovery mode from durable rows; alert | (15, 27) |
| E109 | Huge bulk op (50k records) | Chunked `records.bulk_changed` ≤ 256 KB each, referencing `base_changes` seq range | (15) |
| E110 | Poison event / unknown schema version | DLQ after 5 attempts; consumer continues; replay tool | (15) |
| E111 | Consumer assumes cross-base ordering | Not guaranteed (only per key); documented and lint-reviewed | (15) |
| E112 | Duplicate outbound webhook | Same delivery ID; receivers dedupe | (20) |
| E113 | Slow webhook receiver | 10 s timeout; retries; disabled after 7 days of failure + email | (20) |
| E114 | Webhook cursor older than `BASE_CHANGES_RETENTION` | 410 `CURSOR_EXPIRED`; resync required | (17, 20) |
| E115 | Relay publishes, crashes before checkpoint | Duplicate publish on restart; dedupe by event ID | (15) |

### 53.10 Realtime & concurrency

| # | Scenario | Expected behavior | Mechanism / owner |
|---|---|---|---|
| E116 | Network disconnect during editing [TC-16] | Buffered pending ops, retried with client op IDs | (16, 24) |
| E117 | Reconnect after > 30 days | `resync_required`; full reload; pending ops revalidated | (16) |
| E118 | Field deleted while client has pending ops for it | Ops rejected `FIELD_NOT_FOUND`; client drops with notice | (16) |
| E119 | Realtime node crash | Reconnect elsewhere; resume from last seq | (16) |
| E120 | 500 editors on one base [TC-38] | `change_seq` allocated late in txn (short lock); fan-out batched per 10 ms | (16, 06) |
| E121 | Client/server clock skew | Server timestamps authoritative; client uses handshake offset for relative times | (16) |
| E122 | Same user, 10 tabs | Presence per connection aggregated per user; undo per tab | (16, 22) |
| E123 | Concurrent rich-text editing (V1) | Yjs merge; no lost characters | (16) |
| E124 | Ops for fields hidden from a subscriber | Masked/filtered per subscriber snapshot before send | (16, 19) |
| E125 | Deploy restarts all realtime pods | Rolling drain; jittered reconnect; no thundering herd on CP DB | (16, 25) |

### 53.11 Permissions

| # | Scenario | Expected behavior | Mechanism / owner |
|---|---|---|---|
| E126 | Permission revoked while editing [TC-17] | Next op denied; read-only ≤ 2 s | `perm_epoch` (19) |
| E127 | User removed from workspace [TC-18] | Access gone; attribution "Former collaborator" retained | (19) |
| E128 | Workspace viewer + base editor | Effective = editor (max-role) | (19) |
| E129 | Team removed from base | Members via team lose access; epoch bump | (19) |
| E130 | Filter/sort on hidden field as oracle [TC-21] | Rejected | (19, 11) |
| E131 | Share link creator loses `base.share` | Link persists (owned by base) unless org policy `revokeLinksOnCreatorLoss`; admins list/revoke | (20, 19) |
| E132 | Guest enumerates workspace members | Only collaborators of shared bases; emails hidden per policy | (19) |
| E133 | Stale permission snapshot | Keys include `perm_epoch`; epoch read from `base_runtime` (≤ 1 s cache) | (19) |
| E134 | Last owner removes self | `LAST_OWNER` rejected | (19) |
| E135 | PAT scoped to base A used on base B | 404 | (17, 19) |

### 53.12 Multi-tenancy

| # | Scenario | Expected behavior | Mechanism / owner |
|---|---|---|---|
| E136 | Code path forgets `SET LOCAL app.workspace_id` | RLS returns 0 rows → loud failure in tests; prod metric `rls_empty_context` alert | (19, 26) |
| E137 | Cross-tenant ID guessing | 404, never 403 | (19) |
| E138 | Workspace moved between shards while active | Write freeze ≤ 5 s; routing flip with version; clients reconnect; `change_seq` continuity | (27) |
| E139 | Noisy neighbor saturates shard | Per-workspace statement timeouts, rate limits, BullMQ group fairness, relocation | (23, 25) |
| E140 | Dedicated-shard org revokes BYOK key | Fails closed for that org only; clear error | (25) |

### 53.13 Attachments

| # | Scenario | Expected behavior | Mechanism / owner |
|---|---|---|---|
| E141 | Failed upload [TC-09] | Expired; multipart aborted; no quota charge | (18) |
| E142 | Malware [TC-10] | Rejected; removed from cell | (18) |
| E143 | Record duplicated 1000× with attachments | Attachment rows reference same object (checksum, workspace-scoped refcount) | (18) |
| E144 | HEIC/PSD/huge PDF thumbnail | Best-effort, 60 s timeout, fallback icon | (18) |
| E145 | Quota exceeded mid-upload | Reservation at presign; recheck at completion | (18, 23) |
| E146 | Signed URL shared externally | Short TTL; denied after attachment deletion | (18) |

### 53.14 Comments & mentions

| # | Scenario | Expected behavior | Mechanism / owner |
|---|---|---|---|
| E147 | Mention user without base access | Warning; no record content in notification; inviting requires share permission | (18, 19) |
| E148 | Comment on record later deleted | Soft-deleted in same batch; restored with record | (18, 22) |
| E149 | Comment deleted after mention notification | In-app notification shows "deleted"; sent emails cannot be recalled | (23) |
| E150 | Mention a team of 5,000 | Chunked fan-out; digest | (23) |

### 53.15 Contacts

| # | Scenario | Expected behavior | Mechanism / owner |
|---|---|---|---|
| E151 | Same email created concurrently (form + import) | Unique normalized identifier per workspace → merge suggestion/update | `contact_identifiers` (12) |
| E152 | Merge with conflicting values | Per-field survivor rule recorded in `contact_merge_events` | (12) |
| E153 | Unmerge after new activity on survivor | Attributable activities split; ambiguous stay on survivor, flagged | (12) |
| E154 | GDPR erasure of a contact | Erase across cells/links/activities/search/revisions; crypto-shred where applicable; PII-free audit entry | (12, 25) |

### 53.16 Search

| # | Scenario | Expected behavior | Mechanism / owner |
|---|---|---|---|
| E155 | Index lag after bulk import | "Indexing…" hint; DB fallback for primary-field prefix match in current table | (18) |
| E156 | Hits in a base the user lost access to | Query-time filter by accessible bases; stale docs harmless | (18, 19) |
| E157 | Search for hidden field content | No hits, no counts | (18) |

### 53.17 Import / export

| # | Scenario | Expected behavior | Mechanism / owner |
|---|---|---|---|
| E158 | Mixed encodings / BOM / ragged rows | Detection + override; padded rows; `import_errors` per row | (20) |
| E159 | Crash at 600k of 1M rows | Resume; chunk idempotency `import_id:chunk_no` | (20) |
| E160 | Export of formula-like strings | CSV-injection escape by default | (20) |
| E161 | XLSX zip bomb | Ratio/size caps → `IMPORT_FILE_REJECTED` | (20, 25) |
| E162 | Excel 1900 leap-year bug / serial dates | Corrected conversion; tested goldens | (20) |

### 53.18 Sharing

| # | Scenario | Expected behavior | Mechanism / owner |
|---|---|---|---|
| E163 | Share link to deleted view [TC-25] | 410; stays disabled after restore | (20) |
| E164 | Password brute force on link | Lockout 15 min after 10 failures per link+IP | (20) |
| E165 | Org disables public sharing with links live | Stop serving immediately (evaluated on access) | (19, 20) |
| E166 | Shared view filter uses hidden field | Applied server-side; values never sent; viewers can't alter | (20) |

### 53.19 Integrations & webhooks

| # | Scenario | Expected behavior | Mechanism / owner |
|---|---|---|---|
| E167 | Duplicate inbound webhook [TC-07] | One run | (14, 20) |
| E168 | Inbound payload 10 MB | 413 (limit 1 MB) | (20) |
| E169 | Sync source column removed upstream | Field marked "source removed", read-only; sync continues | (20) |
| E170 | OAuth app scopes beyond user role | Effective = scopes ∩ user permissions | (17, 19) |
| E171 | SSRF via webhook target [TC-42] | Blocked at egress proxy | (25) |

### 53.20 AI

| # | Scenario | Expected behavior | Mechanism / owner |
|---|---|---|---|
| E172 | AI field over 100k records | Batched via `ai` queue; per-workspace concurrency + credits; per-cell status | (21) |
| E173 | Provider outage / 429 | Backoff; fallback model if policy allows; cell `error` + retry | (21) |
| E174 | Prompt injection in cell content | Delimited data section; no tools for field generation; schema-validated output; no side effects | (21) |
| E175 | AI policy disabled mid-generation | Cancel at next batch boundary | (21) |
| E176 | Template references hidden field [TC-43] | Excluded | (21, 19) |
| E177 | Credits exhausted | `AI_BUDGET_EXCEEDED`; existing values kept | (21, 23) |

### 53.21 History, undo, trash

| # | Scenario | Expected behavior | Mechanism / owner |
|---|---|---|---|
| E178 | Undo after another user changed same cell [TC-44] | Partial; skipped cells reported | (22) |
| E179 | Undo of field deletion after 30 days | Not via undo; trash restore until purge | (22) |
| E180 | Purge job vs concurrent restore | Row lock on `deletion_batches`; purge skips `restoring` | (22) |
| E181 | Snapshot restore of 500k-record base | Restored as **new base**; automations paused in copy | (22) |
| E182 | Cell changed 100k times by automation | Revisions coalesced per actor per minute for automation actors | (22) |

### 53.22 Billing & limits

| # | Scenario | Expected behavior | Mechanism / owner |
|---|---|---|---|
| E183 | Plan downgrade over limits [TC-31] | Over-limit read-mostly; no deletion | (23) |
| E184 | Payment failure | 14-day grace → read-only (no data loss) | (23) |
| E185 | SCIM provisions beyond seats | Auto true-up or reject per contract setting | (23) |
| E186 | Usage counter drift Redis vs Postgres | `usage_counters` authoritative; reconcile every 5 min | (23) |

### 53.23 Infrastructure & failure

| # | Scenario | Expected behavior | Mechanism / owner |
|---|---|---|---|
| E187 | Shard failover mid-transaction [TC-30] | Atomic; idempotent retry | (27) |
| E188 | SCIM deprovision mid-session [TC-26] | Sessions revoked ≤ 60 s | (19, 25) |
| E189 | Redis cache flush | Single-flight recompile from Postgres; no correctness change | (23) |
| E190 | BullMQ Redis loss | Reconciler re-enqueues rows past lease | (23) |
| E191 | Control-plane outage | Data plane continues for cached routes/sessions (≤ 15 min TTL); new logins degrade | (25) |
| E192 | Rolling deploy with migration | Expand/contract; N-1 compatible | (27) |
| E193 | Clock skew on a worker node (+90 s) | Ordering by `change_seq`; lease expiry computed with DB `now()`; NTP alert | (23, 27) |
| E194 | Shard disk nearly full | Alerts 75/85%; storage autoscale; relocate workspaces | (25) |
| E195 | Poison job | DLQ after N attempts | (23) |
| E196 | Region outage | Residency regions independent; DR per RTO | (25) |

**Total: 196 edge cases.** New edge cases append to the relevant group with the next free number; numbers are never reused.
