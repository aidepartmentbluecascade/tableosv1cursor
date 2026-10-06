# 17 — API Architecture

> **Status:** Proposed for architectural approval · **Owner:** API Platform · **Date:** 2026-10-03
> Conforms to [`00-canonical-decisions.md`](./00-canonical-decisions.md) (D16, D19, D20, §3, §4, §8, §9, §12). Endpoint-by-endpoint contract lives in [`31-api-specification.md`](./31-api-specification.md).

**Sections covered:** Section 20 (API Architecture) · Part 15 (Public API & Developer Platform) · Part 16 (API Query System)

Related: [`11-filter-sort-group.md`](./11-filter-sort-group.md) (filter AST — normative for `filter`), [`14-automation-engine.md`](./14-automation-engine.md), [`16-realtime.md`](./16-realtime.md), [`19-permissions-and-multitenancy.md`](./19-permissions-and-multitenancy.md), [`20-import-export-sharing-integrations.md`](./20-import-export-sharing-integrations.md), [`25-security-observability-infrastructure.md`](./25-security-observability-infrastructure.md), [`33-architecture-decision-records.md`](./33-architecture-decision-records.md).

---

## Table of contents

1. Scope and design principles
2. Protocol decision: REST vs GraphQL vs gRPC vs tRPC
3. Resource model, URL grammar, custom methods
4. Versioning: `/v1` + dated `Tabula-Version`
5. Authentication methods and token formats
6. OAuth scopes catalogue
7. Authorization middleware pipeline
8. Request validation, TypeBox and OpenAPI generation
9. Record representation: `cellFormat`, `fieldKey`, `typecast`
10. Idempotency (`Idempotency-Key`)
11. Optimistic concurrency (`ETag` / `If-Match`)
12. Batch semantics
13. Asynchronous operations (202 + `long_operations`)
14. Error model and stable error-code catalogue
15. Rate limiting and quotas
16. Pagination and cursor encoding
17. API Query System (Part 16)
18. Outbound webhooks API
19. Relationship to realtime (WebSocket)
20. SDKs
21. Deprecation and change policy
22. Developer portal
23. API observability and per-token analytics
24. Implementation layout (`apps/server`, `packages/api-contract`)
25. Proposed additions

---

## 1. Scope and design principles

The Tabula API is **one API** consumed by three audiences:

| Audience | Transport | Auth | Notes |
|---|---|---|---|
| First-party web app (SPA, D18) | Same REST endpoints + WebSocket (`16-realtime.md`) | Session cookie + CSRF header | A small set of endpoints are tagged `x-internal: true` (e.g. grid window fetch with compact encoding, presence bootstrap) and excluded from the public OpenAPI document but served by the same handlers and middleware. |
| Customers / integrators | REST `/v1` | PAT, service-account token | Rate-limited per token/base/org. |
| Third-party apps (marketplace) | REST `/v1` | OAuth 2.1 access tokens (PKCE) | Consent screen shows scopes + bases. |

**[Ours] Principles**

1. **One contract, many consumers.** The SPA eats our own dog food. Any capability the UI has is either already public or deliberately internal with an ADR-documented reason (performance encoding, unstable). This prevents "the UI can do it but the API can't" drift — a recurring complaint about Airtable-class products **[Observed]**.
2. **Resource-oriented, predictable.** Nouns in paths, standard methods (`GET`, `POST`, `PATCH`, `PUT`, `DELETE`), and a *small, enumerated* set of **custom methods** using the colon suffix (`records:query`, `records:batch`, `:restore`, `:duplicate`) for operations that do not map cleanly.
3. **IDs are canonical, names are convenience.** Every response contains stable public IDs (§3 of the Spine). Names are accepted on input only where explicitly enabled (`fieldKey=name`), because names change and IDs never do.
4. **The same filter AST everywhere.** View filters, API queries, automation conditions, interface element filters and webhook specs share the AST defined in `11-filter-sort-group.md`. No second query language to keep in sync.
5. **Safe to retry.** All mutations accept `Idempotency-Key`; all `GET`s are safe; batch endpoints are atomic by default.
6. **Least privilege by construction.** Every token carries scopes *and* an optional resource allow-list; the effective permission is `scope ∩ role grants ∩ restrictions` (§7).
7. **Explicit async.** Anything that can exceed ~2 s p99 returns `202 Accepted` with a long-operation resource; no request blocks on unbounded work.
8. **Errors are a product surface.** Stable machine codes, RFC 9457 `application/problem+json`, field-level pointers, request IDs, documentation links.
9. **Evolve without breaking.** Additive changes ship continuously; behavior changes are gated by a dated version header; breaking changes require a new major path (rare).
10. **Cost-visible.** Expensive operations (aggregations, includes, large pages) cost more rate-limit units, so callers can reason about throughput.

**Non-goals:** a public GraphQL endpoint (§2), exposing internal slots/UUIDs, exposing SQL, server-side user JavaScript via the API (scripts run only in the sandbox via automations — D21).

---

## 2. Protocol decision: REST vs GraphQL vs gRPC vs tRPC

### 2.1 Evaluation

| Criterion | REST/JSON (+ OpenAPI) | GraphQL | gRPC (+ grpc-web/Connect) | tRPC |
|---|---|---|---|---|
| Public developer familiarity | Universal; curl-able; low-code tools (Zapier/Make) speak it natively | Good, but low-code tooling weaker | Poor for browsers & no-code; needs proxies | TS-only, not a public API technology |
| Fit for **user-defined schemas** (tables/fields defined at runtime) | Good: records are maps keyed by field ID; schema endpoint describes them | **Poor**: GraphQL types are static per schema; per-base dynamic schemas mean per-base introspection, schema cache explosion, and breaking "type changes" whenever a user renames/retypes a field | Same problem (static protobuf); would degrade to `google.protobuf.Struct` = untyped JSON anyway | Static TS types; same issue |
| Cost control / rate limiting | Per-endpoint cost weights, simple | Requires query-cost analysis, depth limits, persisted queries; N+1 risks across links | Per-RPC, fine | Per-procedure, fine |
| Caching (HTTP/CDN/ETag) | Native (ETag, Cache-Control) | Mostly POST → bypasses HTTP caching | None at HTTP layer | Limited |
| Permission enforcement | One check per endpoint + field masking | Per-resolver checks; easy to leak via nested paths (record → link → record in another table with different restrictions) | Per-RPC | Per-procedure |
| Evolution | Additive JSON + dated versions | Good additive story; deprecations in schema | Good (protobuf field numbers) | Coupled to monorepo |
| Streaming/realtime | Separate WebSocket (we need one anyway — D9) | Subscriptions → yet another stateful transport | Streaming RPC (not browser-native) | Subscriptions via WS |
| Internal frontend ergonomics | Typed via generated client from OpenAPI (TS) | Excellent (fragments, normalized cache) | OK via Connect | Excellent within monorepo |
| Ops complexity | Lowest | Medium-High (query planner, cost, persisted queries) | Medium (proxies, LB HTTP/2) | Low but non-public |

### 2.2 Decision **[Ours]** (ADR-016 in `33-…`)

* **Public: REST/JSON over HTTPS, `/v1`, OpenAPI 3.1 contract.**
* **Internal (SPA): the same REST API + the WebSocket protocol** for realtime ops/presence. The SPA uses the generated TS client (`@tabula/api-client`) plus TanStack Query.
* **Service-to-service:** in-process module calls (modular monolith, D1). When a module is extracted (e.g. realtime gateway, file processing), it talks via the event log or a small internal HTTP/JSON API with the same TypeBox contracts. **gRPC is not adopted** now; reconsider only if an extracted service needs high-QPS binary RPC (ADR re-open trigger: > 20k internal RPS on a single edge).
* **No public GraphQL.** Reasons in priority order:
  1. *Dynamic user schemas* make static GraphQL types a liability; we'd ship `fields: JSON` and lose GraphQL's main benefit.
  2. *Permission leakage surface*: nested link traversal across tables with field restrictions is exactly where row/field masking bugs hide. Our `includes` (§17.6) give controlled depth-1 expansion with a single permission evaluation.
  3. *Cost control*: arbitrary query shapes need cost analysis; our query body is bounded by construction (limits table §17.9).
  4. *Two contracts to maintain* for one team.
  **Re-open trigger:** if > 30% of marketplace partners request it and the record query system cannot express their needs, consider a *read-only* GraphQL façade generated per base over the same query planner.
* **No tRPC.** It would couple the SPA to server internals and bypass the public contract, violating principle 1.

---

## 3. Resource model, URL grammar, custom methods

### 3.1 Hierarchy

```
/v1
├── /auth/…                                   (login, mfa, sso, oauth, ws-ticket)
├── /users/me, /users/me/tokens, …
├── /organizations/{orgId}/…                  (members, teams, domains, policies, sso, audit)
├── /workspaces/{workspaceId}/…               (members, invitations, bases listing)
└── /bases/{baseId}
    ├── /schema                               (full schema snapshot, ETag = schemaVersion)
    ├── /tables/{tableId}
    │   ├── /fields/{fieldId}
    │   ├── /records            GET list (simple params) · POST create
    │   ├── /records:query      POST canonical query
    │   ├── /records:batch      POST batch create/update/upsert/delete
    │   ├── /records/{recordId} GET · PATCH · PUT · DELETE
    │   ├── /records/{recordId}:restore
    │   ├── /records/{recordId}/history
    │   └── /records/{recordId}/links/{fieldId}   POST add / DELETE remove
    ├── /views/{viewId}  (+ /records via view)
    ├── /interfaces/{interfaceId}, /automations/{automationId}, /webhooks/{webhookId}
    ├── /changes                              (base change feed)
    └── /long-operations/{operationId}
```

**Why `/bases/{baseId}` is the routing root for data:** the base ID resolves, via `core.base_directory` (D3), to the shard. Every data request therefore needs exactly one directory lookup (Redis-cached), after which all SQL goes to a single shard. Workspace and org IDs are **not** required in data paths (shorter URLs; moving a base between workspaces does not change its URLs).

Tables, fields, views and records are **addressable only under their base**; the public decoder verifies that `tbl_…` belongs to `bas_…` (cross-base ID injection returns `404 TABLE_NOT_FOUND`).

### 3.2 Custom methods (closed list)

| Suffix | Semantics | HTTP |
|---|---|---|
| `:query` | Read with a JSON body (complex filter, includes, aggregations) | `POST`, safe & idempotent by contract (no `Idempotency-Key` needed) |
| `:batch` | Many writes in one request | `POST` |
| `:restore` | Undelete from trash (soft-deleted object) | `POST` |
| `:duplicate` | Copy base/table/view/interface/automation | `POST` → usually `202` |
| `:publish` | Publish interface/automation draft | `POST` |
| `:test` | Dry-run automation/integration connection | `POST` |
| `:cancel` | Cancel long operation | `POST` |
| `:merge` / `:unmerge` | Contact merge operations | `POST` |
| `:rotate-secret` | Rotate webhook/inbound webhook secret | `POST` |

The colon form (borrowed from Google AIP-136 style, a public convention) keeps verbs out of the noun hierarchy and makes route tables trivial: `/:resource:verb` cannot collide with `/:resource/:id`.

### 3.3 Naming conventions

* JSON properties: `camelCase`. Enum values: `snake_case` (match field type keys from Spine §4 — `single_select`, not `singleSelect`).
* Timestamps: RFC 3339 UTC with milliseconds (`2026-10-03T14:05:00.123Z`).
* Money: decimal **strings** (Spine §4 `currency`).
* Every object has `"object": "<type>"` discriminator (`"record"`, `"field"`, `"list"`, `"long_operation"`…). It makes polymorphic responses (search, includes, webhook payloads) self-describing and SDK deserialization trivial.
* Collections: `{ "object": "list", "data": [...], "nextCursor": "…" | null, "hasMore": bool }`.

---

## 4. Versioning

### 4.1 Options considered

| Option | Pros | Cons |
|---|---|---|
| Path major only (`/v1`, `/v2`) | Simple, visible | Every behavior fix is either breaking-in-place or a full new major |
| Header date versions only (`Tabula-Version: 2026-10-01`) | Fine-grained evolution, per-client pinning | Invisible in URLs; harder for curl users; requires version-transform layer |
| **Hybrid: path major + dated minor header** | Big-bang changes rare & visible; small behavior changes pinned per client | Needs a transform layer (we accept the cost) |

### 4.2 Decision **[Ours]**

* **Major in path:** `/v1`. A `/v2` is only cut for wholesale model changes (expect ≥ 3 years between majors). `/v1` supported ≥ 24 months after `/v2` GA.
* **Dated minor versions** via request header `Tabula-Version: YYYY-MM-DD`.
  * Version dates are published in the changelog; only dates with behavior changes exist (e.g. `2026-10-01`, `2027-02-15`).
  * **Default resolution:** header → token's pinned version (set at token/OAuth-app creation to the then-current version, editable in the developer portal) → account default → oldest supported. This guarantees an integration that never sends the header never breaks silently.
  * Response always echoes `Tabula-Version: <resolved>`.
  * Unknown date → `400 UNSUPPORTED_API_VERSION`.
* **What needs a new dated version** (behavior-changing but not structural): changing a default (`pageSize`), changing an enum's default rendering, tightening validation, changing error code for a case, renaming a property (old kept in older versions).
* **What never needs a version** (always-additive, clients MUST tolerate): new endpoints, new optional request params, new response properties, new enum values in *response* fields documented as open (`fieldType`, `event types`, `error codes`), new error codes under existing HTTP statuses, new headers.
* **Implementation:** the handler always produces the **latest** internal representation. A chain of `VersionTransform` modules (Stripe-style, a public pattern) downgrades responses and upgrades requests:

```ts
// packages/api-contract/src/versioning.ts
export interface VersionTransform {
  version: string;                    // '2027-02-15' — the version that INTRODUCED the change
  description: string;
  appliesTo: RouteMatcher[];          // which operations are affected
  upgradeRequest?(req: VersionedRequest): void;   // old-shape → current
  downgradeResponse?(res: VersionedResponse): void; // current → old-shape
}
// For resolved version V, apply all transforms with version > V, newest-first on responses.
```

Transforms are unit-tested with golden files per version; a transform is deleted when its version leaves support (≥ 18 months after the next version date and after deprecation notice — §21).

---

## 5. Authentication

### 5.1 Methods

| Method | Who | Where it's accepted | Storage | Lifetime |
|---|---|---|---|---|
| **Session cookie** `tabula_sid` | First-party SPA | `app.tabula.example` → `api.tabula.example` (same-site) | `core.sessions` (SHA-256 of token) + `sess:{tokenHash}` Redis | Idle 14 d / absolute 30 d; org policy may shorten; MFA level recorded |
| **Personal access token (PAT)** | A user, scripts | `Authorization: Bearer` | `core.api_tokens` (kind=`pat`) | Optional expiry (org policy may force ≤ 90 d) |
| **Service account token** | Org-owned automation/integration | `Authorization: Bearer` | `core.api_tokens` (kind=`service_account`, principal = `core.service_accounts`) | Optional expiry; Business+ |
| **OAuth 2.1 access token** | Third-party app on behalf of a user | `Authorization: Bearer` | `core.api_tokens` (kind=`oauth_access`, `oauth_grant_id`) — see Proposed additions | 1 h; refresh tokens rotate (family in `core.oauth_grants`) |
| **Share token** | Anonymous public viewer | Path segment on share endpoints only | `data.share_links` (hashed) | See `20-…` §Sharing |
| **WS ticket** | SPA opening WebSocket | `?ticket=` on WS upgrade | Redis, single-use, 30 s | 30 s |
| **SCIM bearer** | IdP | `/scim/v2/*` only | `core.scim_directories` (hashed) | Until rotated |

### 5.2 Token format

Tokens are **opaque**, high-entropy, prefixed for secret scanning (GitHub secret-scanning partner program) and for fast routing:

```
tpat_<tokenId:22 base62>_<secret:43 base62 (256 bits)>       personal access token
tsvc_<tokenId>_<secret>                                       service account token
toat_<tokenId>_<secret>                                       OAuth access token
tort_<tokenId>_<secret>                                       OAuth refresh token (never accepted as Bearer)
```

* `tokenId` is the base62 of the `api_tokens.id` UUID — shown in UI as `tok_…` (Spine §3); lookup is by primary key, then **constant-time compare** of `SHA-256(secret)` with stored hash. (Secrets are 256-bit random, so a fast hash is appropriate; Argon2 is reserved for low-entropy human passwords and share-link passwords.)
* Why not JWT access tokens? Revocation must be instant (org admin removes a user → all tokens dead). An opaque token + Redis cache (`tok:{tokenId}` → principal, scopes, restrictions, `revokedAt`, 60 s TTL, invalidated on revoke via pub/sub) gives ~0.2 ms lookups and instant revocation. JWTs would need a denylist anyway.
* Last-used timestamp/IP are updated **asynchronously and coarsely** (at most once per 5 min per token) to avoid write amplification.

### 5.3 Session cookie + CSRF (first-party)

* Cookie: `tabula_sid`, `HttpOnly; Secure; SameSite=Lax; Domain=.tabula.example; Path=/`.
* CSRF: **double-submit token bound to the session** — `X-CSRF-Token` header must equal `HMAC(sessionSecret, "csrf")` (delivered in the `/v1/auth/session` bootstrap response and stored in memory by the SPA). Required on every non-GET request authenticated by cookie. Additionally the API enforces `Origin`/`Sec-Fetch-Site` allow-list for cookie-authenticated mutations (defense in depth).
* **Bearer-authenticated requests ignore cookies entirely** (prevents confused-deputy when a browser sends both). A request with both `Authorization` and a session cookie is authenticated by the Bearer token only.
* CORS: `api.tabula.example` allows credentialed CORS only from first-party origins. Bearer requests allow `*` origins without credentials (enables browser-based integrations using OAuth PKCE tokens).

### 5.4 OAuth 2.1 for third-party apps (D19)

* Authorization Code + **PKCE (S256) mandatory**, no implicit, no password grant. Confidential and public clients.
* Consent screen: scopes (§6) **and** resource selection (which workspaces/bases the app may access). The grant stores `{scopes, resources}`; access tokens inherit both.
* Refresh token rotation with **reuse detection**: a reused refresh token revokes the whole family (`oauth_grants.family_id`).
* Endpoints: `GET /v1/auth/oauth/authorize`, `POST /v1/auth/oauth/token`, `POST /v1/auth/oauth/revoke` (RFC 7009), `POST /v1/auth/oauth/introspect` (RFC 7662, confidential clients only), metadata at `/.well-known/oauth-authorization-server` (RFC 8414).
* Org policy can restrict OAuth apps to an allow-list (`organization_policies.oauth_app_policy`).

### 5.5 Service accounts

Service accounts (`svc_…`) are org-owned principals that receive **grants like a user** (`access_grants.principal_type='service_account'`). They do not consume seats (plan dependent), cannot log into the UI, and survive employee offboarding — the recommended principal for production integrations. Their tokens are created by org admins (`org.manage`) or delegated workspace owners.

### 5.6 Authentication failure semantics

| Situation | Status | Code |
|---|---|---|
| No credentials on a protected route | 401 | `UNAUTHENTICATED` (+ `WWW-Authenticate: Bearer realm="tabula"`) |
| Malformed/unknown token | 401 | `INVALID_TOKEN` |
| Expired token | 401 | `TOKEN_EXPIRED` |
| Revoked token / deactivated user | 401 | `TOKEN_REVOKED` |
| Session needs step-up MFA for this action (e.g. creating a PAT) | 401 | `MFA_REQUIRED` (with `mfaChallengeUrl`) |
| IP not in org allow-list | 403 | `IP_NOT_ALLOWED` |
| Org requires SSO; password session used | 403 | `SSO_REQUIRED` |

---

## 6. OAuth / token scopes catalogue

Scopes **cap** what a token can do; they never grant anything the principal's roles don't already allow (§7). PATs and service-account tokens use the same scope strings.

| Scope | Grants API capability | Maps to permission actions (Spine §9) |
|---|---|---|
| `records:read` | Read records, record history, view records, search within bases | `record.read`, `view.read` |
| `records:write` | Create/update/delete/restore records, link add/remove, form submit as user | `record.create`, `record.update`, `record.delete` |
| `schema:read` | Read bases, tables, fields, views, interfaces metadata (`/schema`) | `base.read`, `view.read`, `interface.read` |
| `schema:write` | Create/update/delete tables, fields, views; type changes; duplicate | `table.*`, `field.*`, `view.create_*`, `view.update`, `base.manage_schema` |
| `comments:read` | Read comments & reactions | `record.read` |
| `comments:write` | Create/edit/delete own comments, reactions | `record.comment` |
| `webhooks:manage` | Create/list/delete webhook subscriptions, pull payloads | `base.read` + (`records:read` and/or `schema:read` matching the spec's data types) |
| `automations:read` | Read automations, versions, runs | `automation.read` |
| `automations:write` | Create/update/publish/enable/disable/test automations | `automation.edit`, `automation.run` |
| `interfaces:read` / `interfaces:write` | Interfaces, pages, elements, publish | `interface.read` / `interface.edit`, `interface.publish` |
| `attachments:write` | Upload files (init/complete) | `record.update` on target cell |
| `contacts:read` / `contacts:write` | Contact directory, identifiers, timeline, merge | `record.read` / `record.update` on contacts table |
| `users:read` | Read org members, teams, user profiles (email visibility per org policy) | `org` member visibility |
| `workspaces:read` / `workspaces:write` | Workspaces, members, invitations, base creation | `workspace.*` |
| `bases:manage` | Base members/grants, share links, snapshots, trash | `base.manage_members`, `base.share` |
| `imports:write` / `exports:read` | Import jobs / export jobs | `record.create` / `export.data` |
| `integrations:manage` | Integration connections, sync sources | `integration.manage` |
| `audit:read` | Audit log query & export (Enterprise) | `audit.read` |
| `org:admin` | Org policies, domains, SSO config, SCIM info (service accounts/admin PATs only; not grantable to third-party OAuth apps without Enterprise approval) | `org.manage` |
| `ai:use` | Invoke AI endpoints (AI field generation trigger, summarize) | `ai.use` |
| `offline_access` | OAuth only: issue refresh token | — |

Scope hierarchy: `*:write` implies the matching `*:read`. `org:admin` implies nothing else (explicit is better). Unknown scopes at token creation → `400 INVALID_SCOPE`.

**Resource restrictions** on tokens (stored in `api_tokens.resource_restrictions jsonb`):

```json
{ "workspaceIds": ["wsp_…"], "baseIds": ["bas_…"], "allowAllBasesInWorkspaces": false, "ipAllowList": ["203.0.113.0/24"] }
```

Empty = all resources the principal can access (PAT default "all current and future bases" is opt-in in the UI; recommended default is explicit bases).

---

## 7. Authorization middleware pipeline

Every request passes the same ordered Fastify hook chain. Handlers never perform raw auth; they receive a typed `RequestContext` and call `ctx.authz.require(action, resource)`.

```
 ┌──────────────┐  ┌───────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐
 │ 1 edge guard │→ │ 2 authenticate│→ │ 3 principal  │→ │ 4 rate limit │→ │ 5 version resolve│
 │ size, CT, IP │  │ cookie|bearer │  │ + org policy │  │ (token, IP)  │  │ Tabula-Version   │
 └──────────────┘  └───────────────┘  └──────────────┘  └──────────────┘  └──────────────────┘
        ↓
 ┌──────────────┐  ┌───────────────┐  ┌───────────────────┐  ┌──────────────┐  ┌───────────────┐
 │ 6 validate   │→ │ 7 route base  │→ │ 8 PermissionSnap- │→ │ 9 action     │→ │ 10 handler +  │
 │ TypeBox      │  │ → shard, tx   │  │ shot load (cache) │  │ check (scope │  │ field masking │
 │ (params/body)│  │ SET LOCAL ws  │  │ perm_epoch keyed  │  │ ∩ role ∩ res)│  │ + response    │
 └──────────────┘  └───────────────┘  └───────────────────┘  └──────────────┘  └───────────────┘
        ↓
 11 rate-limit (base/records cost, post-validation) · 12 idempotency wrap · 13 audit/usage emit (async)
```

### 7.1 Steps in detail

| # | Step | Detail | Failure |
|---|---|---|---|
| 1 | Edge guard | Max body 10 MB JSON (attachments never go through API bodies), `Content-Type: application/json` for bodies, request-ID assignment (`X-Request-Id` accepted if UUID, else generated), IP extraction from trusted proxy header | `413 PAYLOAD_TOO_LARGE`, `415 UNSUPPORTED_MEDIA_TYPE` |
| 2 | Authenticate | Bearer → token lookup (§5.2). Else cookie → session lookup + CSRF check on unsafe methods. Else anonymous (allowed only on routes declaring `auth: none` or `auth: share`) | 401 family |
| 3 | Principal | Build `Principal { type: user/service_account/oauth_app_user/share, userId?, serviceAccountId?, orgIds, scopes, resourceRestrictions, mfaLevel, sessionId?, tokenId? }`. Apply org policies relevant at principal level: IP allow-list, SSO-required, API access disabled for guests (`api.access`) | `403 IP_NOT_ALLOWED`, `403 SSO_REQUIRED`, `403 API_ACCESS_DISABLED` |
| 4 | Coarse rate limit | Per token / per session user / per IP (anonymous) buckets — cheap check before any DB I/O | `429 RATE_LIMITED` |
| 5 | Version | §4 | `400 UNSUPPORTED_API_VERSION` |
| 6 | Validate | Compiled TypeBox validators (ajv) for path/query/headers/body; public ID decoding with prefix check | `400 INVALID_REQUEST` (+ `errors[]` with JSON pointers) |
| 7 | Base routing | `baseId` → `base_directory` (Redis `basedir:{baseId}` 5 min TTL; invalidated on move) → shard pool → open transaction (read-only for safe methods; routed to a replica only for endpoints flagged replica-safe and when the caller sent `Tabula-Consistency: eventual`) → `SET LOCAL app.workspace_id = …` (RLS, D4). Checks token resource restrictions (base/workspace allow-list) | `404 BASE_NOT_FOUND` (also when restricted — no existence oracle), `503 BASE_UNAVAILABLE` (shard migration write-freeze) |
| 8 | PermissionSnapshot | `perm:{principalId}:{baseId}:{permEpoch}` from Redis; on miss compiled from `access_grants` (org → workspace → base, max role wins) + restrictions (`tables.restrictions`, `fields.restrictions`, view locks, row policies) — see `19-permissions-and-multitenancy.md`. `permEpoch` read from `base_runtime` in the same tx (1-row PK read) to avoid stale snapshots | `404 BASE_NOT_FOUND` if no access at all |
| 9 | Action check | `allowed = scopeAllows(action) ∧ snapshot.allows(action, resource)`. Resource may be table/field/view. For record-level row policies, the check yields a **predicate** (filter AST) that is ANDed into the query plan rather than a boolean | `403 INSUFFICIENT_SCOPE` (scope missing — tells the developer which scope) vs `403 PERMISSION_DENIED` (role/restriction) |
| 10 | Handler + masking | Reads: response projector drops fields not in `snapshot.readableFields(tableId)`; writes: `snapshot.writableFields(tableId)` checked per cell → `403 FIELD_NOT_EDITABLE` with pointer. Linked-record includes re-evaluate the snapshot for the target table | — |
| 11 | Cost rate limit | Base-level and records-written budgets need the parsed body (record counts), so they run after validation (§15) | `429 RATE_LIMITED` |
| 12 | Idempotency | Wraps the handler for unsafe methods with an `Idempotency-Key` (§10) | `409` / `422` |
| 13 | Emit | Audit (security-relevant routes only), usage counters (`api_requests` metric), per-token analytics, OTel span attributes (`tabula.base_id`, `tabula.token_id`, `tabula.route`, `tabula.cost`) | — |

### 7.2 Existence hiding (404 vs 403)

* If the principal has **no** access to a base → `404 BASE_NOT_FOUND` (same as nonexistent).
* If the principal can read the base but a specific table/field is hidden from them (Enterprise field hiding, interface-only access) → `404 TABLE_NOT_FOUND` / `404 FIELD_NOT_FOUND`.
* If the principal can **see** the resource but not perform the action → `403 PERMISSION_DENIED`. Seeing something you cannot edit is not secret; the 403 lets UIs offer "request access".

### 7.3 Code sketch

```ts
// apps/server/src/http/routes/records.update.ts
export const recordsUpdate = defineRoute({
  method: 'PATCH',
  url: '/v1/bases/:baseId/tables/:tableId/records/:recordId',
  operationId: 'records.update',
  tags: ['Records'],
  auth: 'principal',                         // 'none' | 'share' | 'principal' | 'scim'
  scopes: ['records:write'],
  action: 'record.update',                   // Spine §9 vocabulary
  resource: (req) => ({ type: 'table', baseId: req.params.baseId, tableId: req.params.tableId }),
  cost: { tokenUnits: 1, baseUnits: 1, recordsWritten: 1 },
  idempotency: 'header',                     // honors Idempotency-Key
  concurrency: 'if-match-optional',
  schema: {
    params: RecordPath, querystring: RecordWriteQuery, body: RecordPatchBody,
    response: { 200: RecordSchema },
  },
  async handler(ctx, req) {
    return ctx.records.update(req.params, req.body, { ifMatch: req.headers['if-match'] });
  },
});
```

`defineRoute` registers Fastify `onRequest` / `preValidation` / `preHandler` hooks and contributes the operation to the OpenAPI document (scopes → `security`, action → `x-tabula-permission`, cost → `x-tabula-cost`). A CI lint fails if a route lacks `scopes`, `action` or `auth`.

---

## 8. Request validation, TypeBox and OpenAPI generation

* **Contract package** `packages/api-contract` holds TypeBox schemas for every request/response. TypeBox produces JSON Schema (draft 2020-12, which OpenAPI 3.1 uses natively) **and** static TS types from one source.
* Fastify uses ajv with `removeAdditional: false` and `coerceTypes: false` for bodies (strict: unknown properties → `400 INVALID_REQUEST` with `UNKNOWN_PROPERTY` detail), but `coerceTypes: 'array'` for query strings (`fields[]=a` vs `fields=a`).
* **Cell values cannot be fully validated statically** (fields are user-defined). The static schema validates the envelope (`values: Record<string, unknown>`); the **field engine** (`07-field-engine.md`) validates each cell (`FieldTypeDefinition.validateInput`, or `coerce` when `typecast=true`) and returns `422 FIELD_VALIDATION_FAILED` with pointers such as `/operations/3/values/fld_8Hq…`.
* Zod remains for internal module boundaries (D17); TypeBox is the API boundary. A lint rule forbids importing Zod into `apps/server/src/http/**`.
* **OpenAPI build:** `pnpm api:openapi` walks the route registry → `openapi.public.json` (excludes `x-internal`) and `openapi.internal.json`. CI runs:
  1. **oasdiff** against the last released spec → fails on breaking changes not accompanied by a `VersionTransform` (§4).
  2. A **Spectral** ruleset (our style guide: camelCase, `object` discriminator, problem responses on every operation, `operationId` present, every op has `x-tabula-permission`).
  3. SDK generation smoke test (§20).
* **Per-base dynamic OpenAPI:** `GET /v1/bases/{baseId}/openapi.json` (scope `schema:read`) produces a spec in which `values` is a concrete object schema with one property per field ID (with `x-field-name`, JSON types per Spine §4). Powers the developer portal "base API docs" and lets users generate a typed client for one base. Cached by `schemaVersion`; respects the caller's field visibility.

---

## 9. Record representation: `cellFormat`, `fieldKey`, `typecast`

### 9.1 Record object

```json
{
  "object": "record",
  "id": "rec_3J9xVb0kq2PZr8Lw1mNc7Y",
  "tableId": "tbl_1sY2b7XcK9w0Q4mT6eRz3A",
  "createdAt": "2026-10-01T09:12:44.120Z",
  "updatedAt": "2026-10-03T14:05:00.123Z",
  "version": 17,
  "values": {
    "fld_Name0000000000000001": "Acme Corp",
    "fld_Status00000000000001": { "id": "opt_7kQ2…", "name": "Open", "color": "blue" },
    "fld_Amount00000000000001": "1250.00",
    "fld_Owner000000000000001": { "id": "usr_2bF…", "name": "Dana Ruiz", "email": "dana@example.com" },
    "fld_Company0000000000001": [ { "id": "rec_9Pq…", "displayValue": "Acme Holdings" } ],
    "fld_Files000000000000001": [
      { "id": "att_4Lm…", "filename": "contract.pdf", "mimeType": "application/pdf", "size": 482113,
        "url": "https://files.tabula.example/…?Expires=…&Signature=…", "urlExpiresAt": "2026-10-03T16:05:00Z",
        "thumbnails": { "small": { "url": "https://…", "width": 64, "height": 64 } } }
    ],
    "fld_Total000000000000001": 1350.5
  },
  "computedStatus": { "fld_Rollup00000000000001": "stale" }
}
```

* `values` omits empty cells (Spine §4: empty ⇒ absent). Clients treat a missing key as empty.
* `version` = `records.version` (monotonic per record; ETag §11).
* `computedStatus` appears only when some computed values are stale (D7 deferred propagation) or AI fields are pending.
* Hidden/masked fields are **absent**, never `null` — indistinguishable from empty for principals without visibility (no oracle).

### 9.2 `cellFormat=json|string`

| Field type | `json` (default) | `string` (requires `timeZone`, `locale`) |
|---|---|---|
| `text`, `long_text` | string (rich: `{ doc, plain }` only with `richText=true`, else plain) | string |
| `number`, `percent` | number | `"1,250.5"` / `"25%"` per field precision & locale |
| `currency` | decimal string | `"$1,250.00"` |
| `date` / `datetime` | `"2026-10-03"` / ISO UTC | formatted per field display options and `timeZone` |
| `single_select` | `{id,name,color}` | `"Open"` |
| `multi_select` | `[{id,name,color}]` | `"Open, Urgent"` |
| `collaborator` | `{id,name,email?}` (email only if org policy exposes member emails to the caller) | `"Dana Ruiz"` |
| `link`, `contact` | `[{id, displayValue}]` | `"Acme Holdings, Beta LLC"` |
| `attachment` | objects with signed URLs (TTL 2 h) | `"contract.pdf (https://…)"` |
| `lookup` / `rollup` / `formula` | typed by result type | display string |
| `ai_generated` | `{ value, status }` | value as string, `""` if pending |

`string` exists for spreadsheet-like consumers (exports, low-code tools). It is **lossy and read-only**; writes always take `json` semantics. `cellFormat=string` without `timeZone` and `locale` → `400 INVALID_REQUEST` (silent server-default formatting is a classic integration bug).

### 9.3 `fieldKey=id|name`

* Governs **both output keys and input resolution**. Default `id`.
* `fieldKey=name`: output `values` keyed by current field name; input keys resolved by exact (case-sensitive) name; unknown name → `422 UNKNOWN_FIELD`.
* With `fieldKey=id`, input keys **must** be field IDs. We do **not** offer a mixed auto-detect mode: a field literally named like an ID would be ambiguous.
* **Why one parameter instead of a separate `returnFieldsByFieldId` flag:** two knobs (one for input, one for output) create four combinations, three of which surprise people. One knob means the same keys for reading and writing, and a record read can be written back unchanged. Name-keyed mode is documented as "convenience for scripts"; production integrations should use IDs, since renames break name-keyed integrations.
* `fields` in GET params and query bodies accept IDs or names consistent with `fieldKey`.

### 9.4 `typecast`

`typecast: true` (query parameter on single writes, body property in batch) asks the field engine to **coerce** loosely typed input instead of rejecting it:

| Target type | With `typecast=true` | Without |
|---|---|---|
| `single_select` / `multi_select` | Accept option **name** strings; unknown names **create** an option (requires `field.update` permission and `schema:write` scope — else `422 INVALID_SELECT_OPTION`); multi accepts comma-separated string | `opt_…` ID, `{id}`, or an **existing** exact name |
| `number`, `percent`, `currency` | `"1,250.50"`, `"$1,250"`, `"25%"` parsed per `locale` param | JSON number (currency: number or decimal string) |
| `date`, `datetime` | Many formats (ISO, locale-specific `MM/DD/YYYY` vs `DD/MM/YYYY` by `locale`, epoch ms); `timeZone` applied to naive datetimes | ISO only |
| `checkbox` | `"yes"`, `"true"`, `"1"`, `"x"`, `"✓"` → true; `"no"`, `"false"`, `"0"`, `""` → false | boolean |
| `collaborator` | email → user (must be a base collaborator) | `usr_…`, `{id}` or `{email}` |
| `link` | primary-field display value → matching record (exact, ambiguity → error); `createMissingLinks: true` creates targets | `rec_…` IDs or `{id}` |
| `attachment` | `{ url }` objects → server fetches asynchronously (SSRF-protected egress, size-limited) | `{ id: "att_…" }` of uploaded attachments, or `{ url }` |
| `text` | numbers/booleans stringified | string |

The same coercion functions power imports (`20-…` §Import), so CSV import and API typecast behave identically.

---

## 10. Idempotency

### 10.1 Contract

* Header `Idempotency-Key: <1–255 printable ASCII>`; clients should use UUIDv4/v7.
* Honored on all `POST`, `PATCH`, `PUT`, `DELETE` (except `:query`, which is safe by contract).
* Key scope: `(principal — token id or session user id, method, route template)`. Two tokens may use the same key independently.
* Retention: **24 hours** from first request.
* Request fingerprint: `SHA-256(method ‖ concrete path ‖ canonical JSON body ‖ Tabula-Version ‖ If-Match)`. Canonical JSON = recursively sorted keys, no insignificant whitespace.

| Situation | Response |
|---|---|
| First request | Execute; store `{fingerprint, status, selected headers, body}` atomically with the business transaction |
| Replay, same fingerprint, original completed | Stored status + body; header `Idempotent-Replayed: true` |
| Replay while original still in progress | `409 IDEMPOTENCY_IN_PROGRESS` + `Retry-After: 1` |
| Same key, **different** fingerprint | `422 IDEMPOTENCY_KEY_REUSED` |
| Original failed with 5xx / 429 / 503 before commit | Nothing stored → re-execution allowed |
| Original failed with deterministic 4xx (validation, permission) | Stored → replay returns same 4xx (prevents "retry until it works" confusion) |

### 10.2 Storage design

* **Base-scoped endpoints:** a row in `data.idempotency_keys` on the **same shard, inside the same transaction** as the mutation — exactly-once without 2PC: if the business tx commits, the key commits with its response.
  ```
  idempotency_keys(workspace_id, scope_hash bytea, key text, fingerprint bytea,
                   response_status smallint, response_body jsonb, response_headers jsonb,
                   created_at timestamptz, expires_at timestamptz)
  PRIMARY KEY (scope_hash, key)
  ```
* **Concurrency:** first statement of the business tx is `INSERT … ON CONFLICT (scope_hash, key) DO NOTHING RETURNING …`. A concurrent duplicate blocks on the uncommitted unique-index entry until the first tx finishes (`lock_timeout = 2s`); if the first commits, the second sees the row and replays; if the first rolls back, the second proceeds. Lock timeout → `409 IDEMPOTENCY_IN_PROGRESS`.
* **Fast path:** completed responses ≤ 64 KB are also cached at `idem:{scope}:{key}` (Redis, 24 h) for replay without touching the shard; Postgres stays authoritative.
* **Async (202) operations:** the stored response is the `202` + `long_operation` body; replays return the same operation ID.
* **Control-plane endpoints** (orgs, users, tokens, workspaces): same pattern in a control-plane table (see Proposed additions).
* **Purge:** `purge` queue deletes rows with `expires_at < now()` in 10k-row loops hourly (or the table is range-partitioned by day and partitions dropped).

---

## 11. Optimistic concurrency (`ETag` / `If-Match`)

| Resource | ETag | Notes |
|---|---|---|
| Record | `"r{version}"` (`records.version`) | Strong ETag |
| View | `"v{views.version}"` | Config patches |
| Interface (draft) | `"i{draftVersion}"` | |
| Automation (draft) | `"a{draftVersion}"` | |
| Table / Field | `"s{schemaVersion}"` of the base | Coarse: any schema change invalidates |
| `/schema` | `"s{schemaVersion}"` | Also `If-None-Match` → `304 Not Modified` |

* `If-Match` is **optional** for record writes by default (D9: cell-level LWW is the product semantics for collaborative editing). Strict integrations send it; mismatch → `412 VERSION_CONFLICT` with the current record in `currentResource` so the client can merge.
* Base setting `requireIfMatchForApiWrites` (or org policy) makes it mandatory for token-authenticated writes; missing header → `428 PRECONDITION_REQUIRED`.
* Batch requests use per-item `ifMatchVersion` (headers cannot express per-item preconditions).
* `PATCH` = *merge* (only provided cells change). Under LWW, concurrent PATCHes touching different cells both win — what users expect in a grid. `PUT` = *replace* (unspecified writable cells cleared). `PUT` without `If-Match` is allowed but documented as a footgun; SDKs send `If-Match` automatically for `replace`.
* Schema-level writes accept `If-Match: "s{schemaVersion}"`, recommended for schema-as-code tools.

---

## 12. Batch semantics

`POST /v1/bases/{baseId}/tables/{tableId}/records:batch`

```json
{
  "atomic": true,
  "typecast": false,
  "operations": [
    { "op": "create",  "clientRef": "row-1", "values": { "fld_Name…": "Acme", "fld_Amount…": "1250.00" } },
    { "op": "update",  "id": "rec_3J9…", "ifMatchVersion": 17, "values": { "fld_Status…": "opt_7kQ2…" } },
    { "op": "replace", "id": "rec_8Hk…", "values": { "fld_Name…": "Beta" } },
    { "op": "upsert",  "matchOn": ["fld_Email…"], "values": { "fld_Email…": "a@b.com", "fld_Name…": "A" } },
    { "op": "delete",  "id": "rec_0Zz…" }
  ]
}
```

Rules:

* ≤ **1000 operations** per request (Spine §8) and ≤ 10 MB body. Mixed kinds allowed. Same record ID twice → `422 DUPLICATE_RECORD_IN_BATCH`.
* `atomic: true` (default): one DB transaction. We **validate every item before writing**, so a failure returns `422 BATCH_VALIDATION_FAILED` listing **all** item errors in one round trip.
* `atomic: false`: items committed in **chunks of 100 per transaction**; HTTP `200` with per-item results (we avoid literal `207 Multi-Status` because many HTTP clients mishandle it):

```json
{
  "object": "batch_result",
  "atomic": false,
  "results": [
    { "index": 0, "clientRef": "row-1", "status": 201, "record": { "object": "record", "id": "rec_…", "version": 1, "values": { } } },
    { "index": 1, "status": 412, "error": { "code": "VERSION_CONFLICT", "detail": "Record version is 18, expected 17." } },
    { "index": 2, "status": 200, "record": { "object": "record", "id": "rec_8Hk…", "version": 4, "values": { } } },
    { "index": 3, "status": 200, "upsertResult": "updated", "record": { "object": "record", "id": "rec_…" } },
    { "index": 4, "status": 200, "deleted": true, "id": "rec_0Zz…" }
  ],
  "summary": { "succeeded": 4, "failed": 1 }
}
```

* **Upsert:** `matchOn` = 1–3 field IDs of matchable types (`text`, `email`, `phone`, `url`, `number`, `autonumber`, `single_select`). 0 matches → create, 1 → update, > 1 → item error `UPSERT_AMBIGUOUS_MATCH`. Matching uses normalized values (case-insensitive email, E.164 phone) and typed index sidecars when present (D6). Concurrent upserts on the same key are serialized with `pg_advisory_xact_lock(hash(tableId, matchValues))` to avoid duplicate creates.
* **Events:** a batch touching > 50 records emits one `records.bulk_changed` domain event (per-record `base_changes` rows still feed realtime and webhooks); ≤ 50 emits per-record events. Automations see `actor.via = "api"`.
* **Cost:** `recordsWritten = operations.length` against the per-base 5,000 records/min budget (§15).
* **Computed fields:** same-tx for same-record formulas; cross-record via D7 (may mark stale). Response `computedStatus` reflects staleness.
* **Ordering:** results in request order; `clientRef` (≤ 64 chars) echoed for correlation (crucial for creates).
* **Large batches:** `"async": true` accepts up to 10,000 operations and returns `202` + long operation (§13); always `atomic: false` semantics per chunk.

---

## 13. Asynchronous operations

Operations that may exceed ~2 s are asynchronous: field type change (rewrites all cells), table/base duplicate, bulk delete by filter, import, export, snapshot restore, workspace move, `records:batch` with `async: true`, audit export, interface publish of very large interfaces.

**Request:**

```http
PATCH /v1/bases/bas_…/tables/tbl_…/fields/fld_Amount… HTTP/1.1
Authorization: Bearer tpat_…
Idempotency-Key: 0192a6f0-6e36-7c1e-9c41-1f6e3b2d7a10
If-Match: "s412"
Content-Type: application/json

{ "type": "currency", "config": { "currencyCode": "USD", "precision": 2 } }
```

**Response:**

```http
HTTP/1.1 202 Accepted
Location: /v1/bases/bas_…/long-operations/lop_6Tz…
Retry-After: 2
Content-Type: application/json

{
  "object": "long_operation",
  "id": "lop_6Tz…",
  "kind": "field.type_change",
  "status": "queued",
  "progress": { "completed": 0, "total": 84213, "unit": "records" },
  "resource": { "object": "field", "id": "fld_Amount…" },
  "cancellable": true,
  "createdAt": "2026-10-03T14:05:01.002Z",
  "links": {
    "self": "/v1/bases/bas_…/long-operations/lop_6Tz…",
    "cancel": "/v1/bases/bas_…/long-operations/lop_6Tz…:cancel"
  }
}
```

**Polling:** `GET …/long-operations/{id}` → `status ∈ queued | running | succeeded | failed | cancelling | cancelled`. Terminal states include `result` (e.g. the updated field; `{ "downloadUrl": … }` for exports) or `error` (a problem object, §14). Server sends `Retry-After` hints (1 s → 10 s backoff). The SPA receives `long_operation.progressed` over WebSocket (`16-realtime.md`) and never polls.

**Semantics:** the `long_operations` row (Spine §5.2) is durable state; the BullMQ job references it; the reconciler (D12) re-enqueues stuck operations. Operations are **resumable** (checkpoint = last processed record ID / batch number) and **cancellable** where safe (field type change works into a shadow slot and swaps at the end, so cancel = discard shadow; see `07-field-engine.md`). Retention: 7 days after completion. Optional `notifyWebhook: true` emits `long_operation.completed` into the base's webhook stream.

---

## 14. Error model and stable error-code catalogue

### 14.1 Shape (RFC 9457 `application/problem+json`)

```http
HTTP/1.1 422 Unprocessable Content
Content-Type: application/problem+json
X-Request-Id: 0192a6f2-11aa-7d3e-b1c8-5a0c7e9f2b31

{
  "type": "https://developers.tabula.example/errors/FIELD_VALIDATION_FAILED",
  "title": "One or more cell values are invalid.",
  "status": 422,
  "code": "FIELD_VALIDATION_FAILED",
  "detail": "2 cell values failed validation.",
  "instance": "/v1/bases/bas_…/tables/tbl_…/records:batch",
  "requestId": "0192a6f2-11aa-7d3e-b1c8-5a0c7e9f2b31",
  "errors": [
    { "pointer": "/operations/0/values/fld_Amount…", "code": "INVALID_NUMBER",
      "detail": "Expected a decimal string or number, got \"twelve\".", "fieldId": "fld_Amount…" },
    { "pointer": "/operations/3/values/fld_Status…", "code": "INVALID_SELECT_OPTION",
      "detail": "Option \"Urgentt\" does not exist. Use typecast=true to create it.", "fieldId": "fld_Status…" }
  ],
  "docs": "https://developers.tabula.example/errors/FIELD_VALIDATION_FAILED"
}
```

Rules:

* `code` is the **contract**; `title`/`detail` are human text (localized via `Accept-Language` for first-party; English default for tokens) and may change.
* `errors[].pointer` is an RFC 6901 JSON pointer into the **request** (body or `/query/<param>`).
* Sub-codes in `errors[].code` come from the field-engine validation catalogue (`07-field-engine.md`): `INVALID_NUMBER`, `INVALID_DATE`, `VALUE_TOO_LONG`, `INVALID_EMAIL`, `INVALID_SELECT_OPTION`, `INVALID_RECORD_REFERENCE`, `NOT_ALLOWED_MULTIPLE`, `REQUIRED`, `READ_ONLY_FIELD`, …
* Extension members per code are documented (e.g. `retryAfterMs`, `currentResource`, `limit`, `requiredScopes`).
* **5xx bodies never contain internals** (no stack, SQL, shard names). `requestId` links to traces.

### 14.2 Catalogue (stable; additions allowed, removals only by major version)

| # | Code | HTTP | Meaning / extension members |
|---|---|---|---|
| **Authentication** ||||
| 1 | `UNAUTHENTICATED` | 401 | No credentials |
| 2 | `INVALID_TOKEN` | 401 | Unknown/malformed token or session |
| 3 | `TOKEN_EXPIRED` | 401 | Expired token/session |
| 4 | `TOKEN_REVOKED` | 401 | Revoked token, deactivated user/service account |
| 5 | `MFA_REQUIRED` | 401 | Step-up needed; `mfaChallengeUrl` |
| 6 | `CSRF_TOKEN_INVALID` | 403 | Cookie auth without valid `X-CSRF-Token` / bad Origin |
| **Authorization / policy** ||||
| 7 | `INSUFFICIENT_SCOPE` | 403 | `requiredScopes[]`, `grantedScopes[]` |
| 8 | `PERMISSION_DENIED` | 403 | Role/restriction denies `action`; `action` |
| 9 | `FIELD_NOT_EDITABLE` | 403 | Field restriction (`fields.restrictions`) or computed field; pointer |
| 10 | `VIEW_LOCKED` | 403 | View config locked |
| 11 | `TOKEN_RESOURCE_RESTRICTED` | 403 | Token resource allow-list excludes this workspace (bases → 404) |
| 12 | `IP_NOT_ALLOWED` | 403 | Org IP allow-list |
| 13 | `SSO_REQUIRED` | 403 | Org enforces SSO |
| 14 | `API_ACCESS_DISABLED` | 403 | Org policy disables API for role/plan |
| 15 | `ORG_POLICY_VIOLATION` | 403 | e.g. public sharing disabled, external domain invite blocked; `policy` |
| 16 | `PLAN_LIMIT_EXCEEDED` | 403 | Hard plan limit (records per base, tables, storage); `limit`, `current`, `max`, `upgradeUrl` |
| **Request shape** ||||
| 17 | `INVALID_REQUEST` | 400 | Schema validation failure; `errors[]` |
| 18 | `MALFORMED_JSON` | 400 | Body not parseable |
| 19 | `INVALID_ID` | 400 | Bad public ID or wrong prefix for parameter |
| 20 | `UNSUPPORTED_API_VERSION` | 400 | Unknown `Tabula-Version` |
| 21 | `INVALID_SCOPE` | 400 | Unknown scope at token creation / OAuth |
| 22 | `PAYLOAD_TOO_LARGE` | 413 | Body > limit; `maxBytes` |
| 23 | `BATCH_TOO_LARGE` | 413 | > 1000 ops (or > 10,000 async); `max` |
| 24 | `UNSUPPORTED_MEDIA_TYPE` | 415 | Non-JSON body |
| **Not found** ||||
| 25 | `NOT_FOUND` | 404 | Generic (route or non-base resource) |
| 26 | `BASE_NOT_FOUND` | 404 | Also returned when caller has no access |
| 27 | `TABLE_NOT_FOUND` | 404 | |
| 28 | `FIELD_NOT_FOUND` | 404 | |
| 29 | `VIEW_NOT_FOUND` | 404 | |
| 30 | `RECORD_NOT_FOUND` | 404 | Includes soft-deleted unless `includeDeleted=true`; `deleted: true` hint only if caller may restore |
| 31 | `ENDPOINT_REMOVED` | 410 | Sunset endpoint; `sunsetAt`, `migrationGuide` |
| **Domain validation** ||||
| 32 | `FIELD_VALIDATION_FAILED` | 422 | One or more cells invalid; `errors[]` |
| 33 | `UNKNOWN_FIELD` | 422 | Field key not in table (or hidden) |
| 34 | `BATCH_VALIDATION_FAILED` | 422 | Atomic batch rejected; `errors[]` with `/operations/i/…` pointers |
| 35 | `DUPLICATE_RECORD_IN_BATCH` | 422 | |
| 36 | `UPSERT_AMBIGUOUS_MATCH` | 422 | `matchedRecordIds[]` (≤ 10) |
| 37 | `INVALID_FILTER` | 422 | Filter AST invalid (operator incompatible with field type, depth/size limits); pointer into `filter` |
| 38 | `INVALID_SORT` | 422 | Unsortable field (e.g. attachment) or > 10 sort keys |
| 39 | `INVALID_FORMULA` | 422 | Formula parse/type errors; `formulaErrors[]` with positions |
| 40 | `FIELD_TYPE_CHANGE_UNSUPPORTED` | 422 | Conversion not supported (e.g. formula → link); `from`, `to` |
| 41 | `SCHEMA_CONSTRAINT_VIOLATION` | 422 | Dependency cycle, max dependency chain (32), primary field rules, deleting a field others depend on without `force` |
| 42 | `QUERY_TOO_COMPLEX` | 422 | Exceeds query limits (§17.9); `limit` |
| 43 | `IDEMPOTENCY_KEY_REUSED` | 422 | Same key, different body |
| 44 | `ATTACHMENT_REJECTED` | 422 | Malware/blocked type |
| 45 | `WEBHOOK_URL_NOT_ALLOWED` | 422 | Non-HTTPS, private IP, blocked domain |
| **Conflict / precondition** ||||
| 46 | `VERSION_CONFLICT` | 412 | `If-Match` mismatch; `currentVersion`, `currentResource` |
| 47 | `PRECONDITION_REQUIRED` | 428 | `If-Match` required by base/org policy |
| 48 | `CONFLICT` | 409 | Uniqueness (duplicate field/table name), state conflict (publish while publishing) |
| 49 | `IDEMPOTENCY_IN_PROGRESS` | 409 | Concurrent duplicate; `Retry-After` |
| 50 | `ATTACHMENT_NOT_READY` | 409 | Referenced attachment still scanning |
| 51 | `INVALID_CURSOR` | 400 | Signature/format invalid, or cursor used with different query |
| 52 | `CURSOR_EXPIRED` | 410 | Cursor older than TTL or beyond change-log retention (webhooks); `restartFrom` hint |
| **Rate / quota** ||||
| 53 | `RATE_LIMITED` | 429 | `Retry-After`, `retryAfterMs`, `limitScope` (`token`/`base`/`org`/`ip`/`records_written`) |
| 54 | `CONCURRENCY_LIMITED` | 429 | Too many in-flight expensive requests (aggregations, exports) |
| 55 | `QUOTA_EXCEEDED` | 429 | Monthly quota (API calls on Free, automation runs, AI credits); `resetsAt` |
| **Async** ||||
| 56 | `OPERATION_FAILED` | (in long op body) | Long operation failed; `cause` problem nested |
| 57 | `OPERATION_CANCELLED` | (in long op body) | |
| **Server** ||||
| 58 | `INTERNAL_ERROR` | 500 | Unexpected; safe to retry with idempotency key |
| 59 | `SERVICE_UNAVAILABLE` | 503 | Overload/maintenance; `Retry-After` |
| 60 | `BASE_UNAVAILABLE` | 503 | Base frozen during shard move/restore; `Retry-After` |
| 61 | `QUERY_TIMEOUT` | 504 | Statement timeout (default 10 s API, 30 s exports); suggest narrower filter or sidecar-indexed field |
| 62 | `UPSTREAM_ERROR` | 502 | Integration/provider call failed (connection test, OAuth connect); `provider`, `providerStatus` |

### 14.3 Codes contributed by subsystem documents (reconciled)

The engine documents (06–22, 28) define error conditions specific to their subsystem. They are part of the same stable catalogue; synonyms were normalized to the names in §14.2 (e.g. `FILTER_TOO_COMPLEX` → `QUERY_TOO_COMPLEX`, `RECORD_VERSION_MISMATCH` → `VERSION_CONFLICT`, `LIMIT_EXCEEDED` → `PLAN_LIMIT_EXCEEDED`).

| # | Code | HTTP | Meaning | Owner doc |
|---|---|---|---|---|
| **Records & fields** |||||
| 63 | `RECORD_DELETED` | 409 | Write targets a record deleted concurrently (delete wins) | [16](16-realtime.md) |
| 64 | `RECORD_TOO_LARGE` | 413 | Record exceeds 1 MB compressed | [06](06-record-storage.md) |
| 65 | `RECORD_LIMIT_EXCEEDED` | 403 | Records-per-base plan limit; `limit`, `current` | [06](06-record-storage.md) |
| 66 | `FIELD_LIMIT_REACHED` | 422 | 500 fields/table hard limit | [07](07-field-engine.md) |
| 67 | `FIELD_NAME_TAKEN` | 409 | Field name collides within table | [07](07-field-engine.md) |
| 68 | `FIELD_SLOT_SPACE_EXHAUSTED` | 422 | No free slots until tombstone sweep completes | [06](06-record-storage.md) |
| 69 | `FIELD_CONVERSION_IN_PROGRESS` | 409 | Field is mid type-change; schema edits blocked | [06](06-record-storage.md) |
| 70 | `FIELD_DELETED` | 409 | Referenced field is in trash (`FIELD_REF_DELETED` in formula validation) | [08](08-formula-engine.md) |
| 71 | `FIELD_NOT_ACCESSIBLE` | 403 | Field hidden from principal by restriction | [19](19-permissions-and-multitenancy.md) |
| 72 | `PRIMARY_FIELD_REQUIRED` | 422 | Operation would leave table without a primary field | [07](07-field-engine.md) |
| **Links** |||||
| 73 | `LINK_TARGET_NOT_FOUND` | 422 | Linked record id missing/deleted/other table | [09](09-linked-record-engine.md) |
| 74 | `LINK_CARDINALITY_CONFLICT` | 409 | Single-link side already linked | [09](09-linked-record-engine.md) |
| 75 | `LINK_LIMIT_EXCEEDED` | 422 | > 100,000 links per record side | [09](09-linked-record-engine.md) |
| 76 | `LINK_AMBIGUOUS` | 422 | `typecast` text→link matched multiple primary values | [09](09-linked-record-engine.md) |
| **Views, filters, forms** |||||
| 77 | `FILTER_OPERATOR_NOT_SUPPORTED` | 422 | Operator incompatible with field type | [11](11-filter-sort-group.md) |
| 78 | `GROUP_LIMIT_EXCEEDED` | 422 | > 3 group levels | [11](11-filter-sort-group.md) |
| 79 | `VIEW_CONFIG_INVALID` | 422 | Config fails schema validation | [10](10-view-engine.md) |
| 80 | `VIEW_CONFIG_CONFLICT` | 409 | Config patch touches a path changed since base version | [10](10-view-engine.md) |
| 81 | `VIEW_CONFIG_FROM_FUTURE` | 409 | Client sent config schemaVersion newer than server | [10](10-view-engine.md) |
| 82 | `VIEW_IN_USE` | 409 | Operation blocked because automations/interfaces/shares reference the view; `referrers[]` | [10](10-view-engine.md) |
| 83 | `VIEW_IS_DEFAULT` | 409 | Cannot delete the table's default view; choose another default first | [10](10-view-engine.md) |
| 84 | `FORM_CLOSED` | 410 | Form not accepting submissions | [10](10-view-engine.md) |
| 85 | `FORM_OPTION_NOT_ALLOWED` | 422 | Submitted option not offered by form | [10](10-view-engine.md) |
| 86 | `FORM_OWNER_ACCESS_LOST` | 403 | Form creator lost write access; submissions paused | [10](10-view-engine.md) |
| 87 | `CAPTCHA_REQUIRED` | 400 | Abuse heuristics require a captcha token | [20](20-import-export-sharing-integrations.md) |
| 88 | `CAPTCHA_FAILED` | 400 | Captcha verification failed | [20](20-import-export-sharing-integrations.md) |
| 89 | `SHARE_TARGET_DELETED` | 410 | Share link points at trashed view/interface/base | [20](20-import-export-sharing-integrations.md) |
| **Interfaces** |||||
| 90 | `INTERFACE_UNPUBLISHED` | 404 | No published version | [13](13-interface-builder.md) |
| 91 | `INTERFACE_VERSION_CHANGED` | 409 | Client pinned an older published version | [13](13-interface-builder.md) |
| 92 | `ELEMENT_NOT_FOUND` | 404 | Element id not in pinned version | [13](13-interface-builder.md) |
| 93 | `ELEMENT_CONFIG_INVALID` | 422 | Element config invalid (builder/publish) | [13](13-interface-builder.md) |
| 94 | `RECORD_NOT_IN_SCOPE` | 404 | Record not visible through element's effective query | [13](13-interface-builder.md) |
| 95 | `WRITE_WOULD_LEAVE_SCOPE` | 422 | Write would move record out of the element scope and element forbids it | [13](13-interface-builder.md) |
| **Collaboration, contacts, files, imports** |||||
| 96 | `MENTION_TARGET_NOT_FOUND` | 422 | Mentioned principal/record not resolvable | [18](18-search-attachments-collaboration.md) |
| 97 | `MENTION_LIMIT_EXCEEDED` | 422 | > 50 mentions per comment | [18](18-search-attachments-collaboration.md) |
| 98 | `ATTACHMENT_QUOTA_EXCEEDED` | 403 | Storage plan limit | [18](18-search-attachments-collaboration.md) |
| 99 | `ATTACHMENT_FETCH_FAILED` | 422 | URL-based attachment could not be fetched | [18](18-search-attachments-collaboration.md) |
| 100 | `CONTACT_IDENTIFIER_CONFLICT` | 409 | Identifier already owned by another contact | [12](12-contacts.md) |
| 101 | `CONTACT_MERGE_INVALID` | 422 | Invalid merge set (kinds differ, self-merge, trashed) | [12](12-contacts.md) |
| 102 | `CONTACT_UNMERGE_NOT_ALLOWED` | 409 | Merge too old or survivor changed incompatibly | [12](12-contacts.md) |
| 103 | `IMPORT_FILE_REJECTED` | 422 | Unparseable/oversized/infected import file | [20](20-import-export-sharing-integrations.md) |
| **History & sync** |||||
| 104 | `UNDO_CONFLICT` | 409 | Cells changed by others since the change; per-cell detail | [22](22-audit-history-undo-trash.md) |
| 105 | `UNDO_PARTIAL` | 409 | Undo applied to a subset; `applied[]`, `skipped[]` | [22](22-audit-history-undo-trash.md) |
| 106 | `UNDO_EXPIRED` | 410 | Change older than `BASE_CHANGES_RETENTION` | [22](22-audit-history-undo-trash.md) |
| 107 | `UNDO_NOT_OWN_CHANGE` | 403 | Users may only undo their own changes | [22](22-audit-history-undo-trash.md) |
| 108 | `UNDO_NOT_SUPPORTED` | 422 | Change kind has no inverse (e.g. purge) | [22](22-audit-history-undo-trash.md) |
| 109 | `RESYNC_REQUIRED` | 410 | `sinceSeq` older than retained change log; client must reload | [16](16-realtime.md) |
| 110 | `BASE_DELETED` | 410 | Base in trash | [22](22-audit-history-undo-trash.md) |
| **Automations, integrations, AI** |||||
| 111 | `EGRESS_DESTINATION_BLOCKED` | 422 | Outbound URL resolves to a blocked range | [25](25-security-observability-infrastructure.md) |
| 112 | `SECRET_NOT_FOUND` | 422 | Automation references missing secret | [14](14-automation-engine.md) |
| 113 | `INTEGRATION_AUTH_FAILED` | 409 | Connection needs re-authorization | [20](20-import-export-sharing-integrations.md) |
| 114 | `AI_POLICY_DENIED` | 403 | Org AI policy forbids this use/data | [21](21-ai-architecture.md) |
| 115 | `AI_BUDGET_EXCEEDED` | 429 | Org AI budget/hard cap reached | [21](21-ai-architecture.md) |
| 116 | `TOKEN_TYPE_MISMATCH` | 401 | Token kind not valid for this endpoint (e.g. ws ticket on REST) | [25](25-security-observability-infrastructure.md) |
| 117 | `CROSS_BASE_LINK_NOT_ALLOWED` | 422 | Link target outside base (only the contact directory is cross-base) | [12](12-contacts.md) |
| 118 | `SORT_FIELD_NOT_SORTABLE` | 422 | Field type cannot be sorted (e.g. button, attachment) | [11](11-filter-sort-group.md) |

**Not HTTP status codes** (appear inside `errors[]`, run/step logs, realtime frames or cell metadata only): cell sub-codes `TYPE_MISMATCH`, `INVALID_FORMAT`, `PRECISION_EXCEEDED`, `CURRENCY_MISMATCH`, `INVALID_NUMBER`, `INVALID_SELECT_OPTION`, `FILTER_INCOMPLETE_CONDITION`; realtime frame `ACCESS_REVOKED`; step errors `AI_REFUSED`, `AI_OUTPUT_INVALID`, `AI_OUTPUT_TRUNCATED`, `AI_RATE_LIMITED`, `AI_INVALID_REQUEST`, `STEP_BUDGET_EXCEEDED`, `LEASE_EXPIRED`, `SOURCE_EXPIRED`; formula error values `#ERR_*` ([08](08-formula-engine.md)).

The catalogue lives in `packages/api-contract/src/errors.ts` as a `const` map (code → status, title, docs slug, extension schema); OpenAPI lists per-operation possible codes via `x-tabula-error-codes`. SDKs generate typed error classes (`TabulaVersionConflictError`, …).

**Retry guidance (documented, implemented in SDKs):** retry with backoff on `429`, `502`, `503`, `504`, `409 IDEMPOTENCY_IN_PROGRESS`, `500` (only if an `Idempotency-Key` was sent or the method is safe). Never retry other 4xx.

---

## 15. Rate limiting and quotas

### 15.1 Algorithm

**GCRA** (generic cell rate algorithm — a token bucket expressed as a single "theoretical arrival time" per key) implemented as a Redis Lua script:

* One Redis key per bucket: `rl:{scope}:{id}:{policy}` → TAT (ms). O(1) memory, no window boundary bursts (fixed-window problem), atomic, supports **cost** (`increment = cost × emissionInterval`).
* Burst tolerance = `burst × emissionInterval`.
* Redis Cluster: keys hash-tagged by `{scope:id}` so multi-policy checks for one principal hit one slot; the script checks all applicable policies and **only commits if all pass** (no partial consumption).
* **Failure mode:** if Redis is unavailable, fall back to an in-process GCRA per API pod with limits divided by pod count (approximate, fail-open-ish) and emit an alert. We do not fail closed — an outage of a cache must not take down the API.

```lua
-- KEYS[i] = bucket key, ARGV: now_ms, then per key: emission_ms, burst_ms, cost
-- returns {allowed(0/1), retry_after_ms, remaining_min, reset_ms_max}
local now = tonumber(ARGV[1]); local n = #KEYS; local newTat = {}
local retry, remaining, reset = 0, math.huge, 0
for i = 1, n do
  local em, burst, cost = tonumber(ARGV[3*i-1]), tonumber(ARGV[3*i]), tonumber(ARGV[3*i+1])
  local tat = tonumber(redis.call('GET', KEYS[i]) or now); if tat < now then tat = now end
  local nt = tat + em * cost; local allowAt = nt - burst
  if allowAt > now then retry = math.max(retry, allowAt - now) end
  newTat[i] = nt; remaining = math.min(remaining, math.floor((burst - (nt - now)) / em))
  reset = math.max(reset, nt - now)
end
if retry > 0 then return {0, retry, 0, reset} end
for i = 1, n do redis.call('SET', KEYS[i], newTat[i], 'PX', math.ceil(newTat[i] - now) + 1000) end
return {1, 0, remaining, reset}
```

### 15.2 Scopes and default policies

| Scope key | Default (plan-adjustable via `core.plans.limits`, per-customer via `core.rate_limit_overrides`) | Purpose |
|---|---|---|
| `token:{tokenId}` | 5 / 20 / 20 / 50 rps (Free/Team/Business/Enterprise), burst 2× | Fair use per integration (Spine §12) |
| `user:{userId}` (session) | 50 rps burst 100 | SPA; generous — the grid fetches windows |
| `base:{baseId}` | 50 rps burst 100 (all API tokens combined; SPA traffic excluded but metered separately) | Protects shard & noisy bases |
| `records_written:{baseId}` | 5,000 records/min (cost = records in request) | Write amplification guard (compute, events, webhooks) |
| `org:{orgId}` | 10× token limit × min(active tokens, 10) — a ceiling against token sprawl | Prevents bypass via many tokens |
| `ip:{ip}` | 10 rps for unauthenticated (login, share links, forms) ; login has its own stricter policy in `25-security-observability-infrastructure.md` | Abuse |
| `share:{shareId}` | 20 rps per share link + per-IP 5 rps | Public views/forms |
| `concurrency:{tokenId}` | ≤ 4 in-flight "heavy" requests (aggregations, exports init, `includes` with depth) — implemented as Redis semaphore with lease | Expensive queries |

### 15.3 Cost weights

| Operation | Token units | Base units |
|---|---|---|
| Simple GET (record, field, view metadata) | 1 | 1 |
| List / `records:query`, `pageSize ≤ 100` | 1 | 1 |
| … per additional 100 records requested | +1 | +1 |
| `includes` | +1 per include path | +1 |
| `aggregations` | +2 (+1 per `groupBy` field) | +2 |
| `search` (full-text) | +2 | +2 |
| Single write | 1 | 1 (+1 record written) |
| `records:batch` | 1 + ⌈ops / 100⌉ | same (+ ops records written) |
| Schema write | 5 | 5 |
| Async operation start (duplicate, type change, export) | 10 | 10 |

### 15.4 Response headers (IETF `RateLimit` header fields draft)

```http
RateLimit-Policy: "token";q=20;w=1, "base";q=50;w=1, "records_written";q=5000;w=60
RateLimit: "token";r=13;t=0, "records_written";r=4120;t=12
```

On rejection:

```http
HTTP/1.1 429 Too Many Requests
Retry-After: 1
Content-Type: application/problem+json

{ "type": "https://developers.tabula.example/errors/RATE_LIMITED", "status": 429, "code": "RATE_LIMITED",
  "title": "Rate limit exceeded.", "detail": "Base bas_… exceeded 5000 records written per minute.",
  "limitScope": "records_written", "retryAfterMs": 840, "requestId": "…" }
```

### 15.5 Quotas (monthly)

Separate from rate limits: `usage_counters` track monthly API calls (Free plan only: 1,000/month), automation runs, AI credits. Exhaustion → `429 QUOTA_EXCEEDED` with `resetsAt`. Quotas are checked against a Redis counter mirrored to `usage_counters` every minute (slight overshoot accepted).

### 15.6 Internal traffic

Automations' "update record" actions and integrations run under the **automation principal** and use `base:` + `records_written:` budgets (to protect the shard) but not token buckets; they're governed by automation budgets (`ratebudget:automation:{id}:{hour}`, `14-automation-engine.md`).

---

## 16. Pagination and cursor encoding

### 16.1 Model

* **Keyset (seek) pagination only** — no `offset` (O(n) and unstable under concurrent writes). Exception: `offset`-free "jump to row N" for the grid uses the internal windowed fetch (`16-realtime.md` / grid docs), not the public API.
* Response: `{ "object": "list", "data": [...], "nextCursor": "…" | null, "hasMore": true|false }`. `nextCursor = null` ⇔ end.
* `pageSize` default 100, max 1000 (Spine §8). The server may return fewer than `pageSize` items without being at the end (e.g. when row policies filter post-index); clients must rely on `hasMore`, never on count.

### 16.2 Cursor payload

```ts
interface RecordCursorV1 {
  v: 1;
  q: string;            // viewQueryHash: base64url(SHA-256(canonical {tableId, filter, sort, search, viewId, viewConfigVersion, fieldKey, principal row-policy hash}))[0..16]
  k: Array<JsonScalar | null>; // lastSortKey: values of the sort keys of the last row (normalized sort representation, e.g. text collation key prefix, number, null-marker)
  id: string;           // lastId: record UUID (tiebreaker → total order)
  s: number;            // snapshotSeq: base change_seq when page 1 was served
  sv: number;           // schemaVersion at page 1
  iat: number;          // issued at (epoch s)
}
```

Wire format: `base64url( kid(1 byte) ‖ msgpack(payload) ‖ HMAC-SHA256(key[kid], kid ‖ msgpack)[0..16] )`.

* **Why signed:** the cursor embeds sort key values; an unsigned cursor lets a client forge `k`/`id` to probe ordering of rows they cannot see (row policies) or inject odd values into SQL params. HMAC makes it tamper-evident; verification is ~1 µs.
* **Why not encrypted:** sort values are values the caller already received on the previous page; confidentiality adds nothing. Cursors are still documented as **opaque**.
* **Key rotation:** `kid` byte selects key; keys from the KMS-backed secret store, rotated quarterly; previous key accepted for 7 days.
* **Validation on use:** signature → `iat` within **24 h** (else `410 CURSOR_EXPIRED`) → recompute `q` from the current request (filter/sort/fields must equal the original; `pageSize` may change) else `400 INVALID_CURSOR` → if `schemaVersion` changed and any sort/filter field was deleted or retyped → `410 CURSOR_EXPIRED` with `restartFrom: "beginning"`.

### 16.3 Consistency semantics

We do **not** hold a database snapshot across pages (would require long-lived transactions). Keyset pagination guarantees: no record appears twice and no record that existed unchanged during the whole scan is skipped. Records inserted/updated mid-scan may or may not appear. The `snapshotSeq` lets a client achieve full consistency by afterwards calling `GET /v1/bases/{baseId}/changes?sinceSeq={s}` (or a webhook cursor) and applying deltas — the recommended pattern for sync tools, documented in the portal ("full sync = paginated scan + change catch-up").

### 16.4 SQL shape

```sql
-- sort: fld_Amount DESC NULLS LAST, then id ASC tiebreaker
SELECT r.id, r.version, r.cells, r.computed, r.created_at, r.updated_at
FROM data.records r
JOIN data.record_index_num ix ON ix.record_id = r.id AND ix.field_id = $amountField   -- sidecar if enabled (D6)
WHERE r.table_id = $table AND r.deleted_at IS NULL
  AND (<compiled filter AST>) AND (<row policy predicate>)
  AND ( (ix.value < $lastAmount) OR (ix.value = $lastAmount AND r.id > $lastId) )      -- seek predicate
ORDER BY ix.value DESC NULLS LAST, r.id ASC
LIMIT $pageSize + 1;                                                                    -- +1 to compute hasMore
```

The seek predicate is generated by `@tabula/query` from the sort spec (handles mixed directions & null ordering by expanding to an OR-chain). Details in `11-filter-sort-group.md`.

Non-record collections (comments, runs, notifications, audit) use the same cursor envelope with `k = [createdAt]`, `id` tiebreaker.

---

## 17. API Query System (Part 16)

### 17.1 Critique of the naive GET style

A common first design is `GET /records?filter[status]=open&filter[amount][gt]=1000&sort=-createdAt&page=3`. For a product whose tables are **user-defined** this fails in several ways:

| Problem | Why it bites us |
|---|---|
| Field names in parameter names | Names contain spaces, brackets, `=`, `&`, Unicode, and change on rename. `filter[Deal Stage (new)]` is unparseable or silently wrong. |
| Only implicit AND | No OR, no nesting, no "is empty", no "has any of" for multi-selects, no relative dates ("within past 7 days"). Every real view filter in our product needs these. |
| Untyped values | `filter[amount]=1000` — number? string? currency decimal? select option name or ID? Bracket syntaxes push type inference to the server, producing inconsistent behavior across field types. |
| Divergence from views | The UI's views use a filter AST (`11-filter-sort-group.md`). A second, weaker query language means "this view can't be reproduced via API" bugs and two compilers to secure. |
| Offset pagination (`page=3`) | O(n) and unstable under concurrent edits (duplicates/skips). |
| URL length | Complex filters exceed proxy/CDN limits (~8 KB) and leak into access logs (PII in URLs — violates our privacy rule of no personal data in query strings where avoidable). |
| No room for expansion/aggregation | Includes and aggregations in query strings become unreadable mini-languages. |

### 17.2 Decision **[Ours]**: two tiers, one engine

1. **Tier A — simple `GET …/records`** for the 80% case (scripts, quick lookups, low-code tools):
   * `fields=fld_a,fld_b` (or repeated `fields[]=`), `sort=-fld_Amount,fld_Name` (`-` = descending; max 3 keys), `pageSize`, `cursor`, `viewId`, `cellFormat`, `fieldKey`, `timeZone`, `locale`, `recordIds=rec_a,rec_b` (≤ 100).
   * `filter=` uses a **compact, AND-only condition list**: `<fieldRef>:<operator>[:<value>]` separated by `,`. Values are JSON literals when quoted or typed (`1000`, `true`, `"Acme, Inc"`, `opt_7kQ2`), bare tokens otherwise. Max 10 conditions, no OR, no nesting, no relative-date operators.
     ```
     GET /v1/bases/bas_…/tables/tbl_…/records?filter=fld_Status:eq:opt_7kQ2,fld_Amount:gte:1000,fld_Owner:is_not_empty&sort=-fld_Amount&pageSize=50
     ```
   * The server **parses it into the exact same filter AST** (`{type:"group",op:"and",children:[…]}`) and executes through the same planner. Operators use the AST operator names from `11-filter-sort-group.md`.
   * Rejected alternatives: (a) URL-encoded JSON `filter={"type":"group"…}` — lossless but unreadable and still has URL-length/log issues; (b) a formula-expression filter string (spreadsheet-formula-style) — powerful but means exposing the formula engine as a query language, with per-row evaluation that cannot use indexes; (c) bracket syntax — critiqued above.
   * **Escalation rule (documented):** anything needing OR, nesting, > 10 conditions, search, includes, aggregations or relative dates → Tier B.
2. **Tier B — canonical `POST …/records:query`** with a JSON body. Safe & idempotent by contract (cacheable by request hash internally; no `Idempotency-Key`). SDKs use Tier B exclusively.

Both tiers produce a `RecordQuery` object → `QueryPlanner` (`@tabula/query`) → SQL. One security-reviewed compiler.

### 17.3 Tier B request body

```json
{
  "viewId": "viw_5Gh…",
  "filter": {
    "type": "group", "op": "and",
    "children": [
      { "type": "condition", "fieldId": "fld_Amount…", "operator": "gt", "value": 1000 },
      { "type": "group", "op": "or", "children": [
        { "type": "condition", "fieldId": "fld_Status…", "operator": "eq", "value": "opt_7kQ2…" },
        { "type": "condition", "fieldId": "fld_Owner…", "operator": "is_empty" }
      ] },
      { "type": "condition", "fieldId": "fld_Close…", "operator": "is_within", "value": { "mode": "past_days", "days": 30 } }
    ]
  },
  "sort": [ { "fieldId": "fld_Amount…", "direction": "desc" }, { "fieldId": "fld_Name…", "direction": "asc" } ],
  "fields": ["fld_Name…", "fld_Amount…", "fld_Status…", "fld_Company…"],
  "search": { "query": "acme", "fieldIds": ["fld_Name…", "fld_Notes…"], "mode": "prefix" },
  "includes": [
    { "fieldId": "fld_Company…", "fields": ["fld_CoName…", "fld_Industry…"], "limit": 20 }
  ],
  "aggregations": [
    { "id": "total", "function": "sum", "fieldId": "fld_Amount…" },
    { "id": "n", "function": "count" },
    { "id": "byStatus", "function": "sum", "fieldId": "fld_Amount…", "groupBy": ["fld_Status…"] }
  ],
  "aggregationsOnly": false,
  "pageSize": 100,
  "cursor": null,
  "cellFormat": "json",
  "fieldKey": "id",
  "timeZone": "America/New_York",
  "locale": "en-US",
  "includeDeleted": false
}
```

### 17.4 Semantics

| Element | Semantics |
|---|---|
| `viewId` | Inherit the view's query. **Filter:** `effective = view.filter AND request.filter`. **Sort:** request `sort` (if non-empty) **replaces** view sort; otherwise view sort. **Fields:** default = view's visible fields in view order; explicit `fields` may include fields hidden in the view (hidden ≠ forbidden) — **except** for principals whose access is bounded by the view/share (interface-only users, share links), where `fields` is intersected with the view's visible set. **Group-by** of the view is ignored for record listing (use `aggregations.groupBy`). Personal view state (`view_user_state`) is never applied to API calls. |
| `filter` | AST from `11-filter-sort-group.md`; validated against field types (`INVALID_FILTER` with pointer `/filter/children/1/children/0`). Option values must be option IDs (names allowed with `fieldKey=name`). |
| `sort` | ≤ 10 keys (Tier A ≤ 3). Unsortable types (attachment, button) → `INVALID_SORT`. Implicit final tiebreaker: record `id` ascending (UUIDv7 ⇒ ≈ creation order). Without any sort and without view: manual order key of the table, then id. |
| `fields` | Projection. Computed fields are read from `records.computed` (no recomputation in read path). Unknown → `UNKNOWN_FIELD`. Fields hidden by permission: **explicitly** requested-but-forbidden → `404 FIELD_NOT_FOUND` (explicit requests fail loudly; implicit projections mask silently). |
| `search` | Full-text search restricted to the filtered set. MVP: Postgres FTS over `search_documents` joined by record id + trigram for `prefix`/`substring`; V1: OpenSearch returns candidate IDs (≤ 10k) that are then intersected in SQL. `mode`: `prefix` (default), `substring`, `fulltext`. Results ordered by `sort` if present, else relevance (`relevance` included in each record's `meta`). |
| `includes` | Depth-1 expansion of link/contact fields. Linked records appear once each in a top-level `included` map (deduplicated, like JSON:API compound documents), not nested (avoids exponential payloads). `fields` selects target fields (default: primary field only). `limit` per source record (default 20, max 100); truncated sets flagged. Permission snapshot for the **target table** is applied: unreadable target table → linked IDs + `displayValue` only (what the link cell already exposes), no `included` entries. |
| `aggregations` | Computed over the **entire filtered set**, not the page. Functions: `count`, `count_empty`, `count_filled`, `count_distinct`, `sum`, `avg`, `min`, `max`, `median` (V1), `percent_filled`. `groupBy` ≤ 3 fields (select, collaborator, link — first linked —, date with `granularity`, checkbox, text exact); max 1,000 groups (+ `"truncated": true`). Returned on **first page only** (cursor requests omit them) for cost and consistency reasons. `aggregationsOnly: true` → no records, only aggregations (dashboards, interface charts). |
| `pageSize` / `cursor` | §16. A cursor carries `q`; changing `filter`/`sort`/`fields`/`search` with a cursor → `INVALID_CURSOR`. |
| `includeDeleted` | Requires `record.delete` permission (trash viewers); returns soft-deleted records with `deletedAt`. |

### 17.5 Response

```json
{
  "object": "list",
  "data": [
    {
      "object": "record",
      "id": "rec_3J9…",
      "version": 17,
      "createdAt": "2026-10-01T09:12:44.120Z",
      "updatedAt": "2026-10-03T14:05:00.123Z",
      "values": {
        "fld_Name…": "Acme Corp",
        "fld_Amount…": "125000.00",
        "fld_Status…": { "id": "opt_7kQ2…", "name": "Open", "color": "blue" },
        "fld_Company…": [ { "id": "rec_9Pq…", "displayValue": "Acme Holdings" } ]
      },
      "meta": { "relevance": 0.82, "truncatedIncludes": [] }
    }
  ],
  "included": {
    "rec_9Pq…": {
      "object": "record", "id": "rec_9Pq…", "tableId": "tbl_Companies…", "version": 4,
      "values": { "fld_CoName…": "Acme Holdings", "fld_Industry…": { "id": "opt_x…", "name": "Manufacturing" } }
    }
  },
  "aggregations": {
    "total": { "value": "1843250.00", "fieldId": "fld_Amount…", "function": "sum" },
    "n":     { "value": 214, "function": "count" },
    "byStatus": {
      "function": "sum", "fieldId": "fld_Amount…", "groupBy": ["fld_Status…"],
      "groups": [
        { "key": [ { "id": "opt_7kQ2…", "name": "Open" } ], "value": "1203000.00", "count": 120 },
        { "key": [ { "id": "opt_9aa…",  "name": "Won" } ],  "value": "640250.00",  "count": 94 },
        { "key": [ null ], "value": "0.00", "count": 0 }
      ],
      "truncated": false
    }
  },
  "nextCursor": "AQx3k2…",
  "hasMore": true,
  "meta": { "snapshotSeq": 182331, "schemaVersion": 412, "effectiveViewId": "viw_5Gh…", "computedStale": false }
}
```

Note: aggregate of `currency` is returned as a decimal string; `avg` of currency uses decimal arithmetic (`numeric` in SQL), returned with field precision + 2.

### 17.6 Interface element and view-specific record endpoints

* `GET /v1/bases/{baseId}/views/{viewId}/records` = Tier A with `viewId` implicit (handy for share links and low-code tools).
* `POST /v1/bases/{baseId}/interfaces/{interfaceId}/elements/{elementId}:query` — same body minus `viewId`/`filter` overrides that would widen access: the element's source filter + the interface user's record-scoping (e.g. "records where Owner = current user") are **mandatory** ANDed predicates; caller filters can only narrow (`19-permissions-and-multitenancy.md`).

### 17.7 Query planning notes

* The planner chooses between: (1) **sidecar-indexed** filter/sort (`record_index_*`) when the table exceeds `INDEX_SIDECAR_THRESHOLD` and the field has a sidecar; (2) **JSONB expression** evaluation on `cells`/`computed` with GIN where applicable; (3) **search-first** (FTS candidates then filter).
* Statement timeout 10 s (`QUERY_TIMEOUT`); `EXPLAIN`-based cost guard for `aggregations` on > 500k-record tables triggers `202` + long operation if estimated cost exceeds threshold (with `asyncIfSlow: true`) or `422 QUERY_TOO_COMPLEX` otherwise.
* Results for identical `(principalPermHash, queryHash, baseChangeSeq)` may be served from a short-lived Redis cache (5 s) — useful for dashboards hammering the same aggregation.

### 17.8 Tier A ↔ Tier B equivalence example

```
GET …/records?filter=fld_Status:eq:opt_7kQ2,fld_Amount:gt:1000&sort=-fld_Amount&fields=fld_Name,fld_Amount&pageSize=50
```
≡
```json
{ "filter": { "type": "group", "op": "and", "children": [
    { "type": "condition", "fieldId": "fld_Status", "operator": "eq", "value": "opt_7kQ2" },
    { "type": "condition", "fieldId": "fld_Amount", "operator": "gt", "value": 1000 } ] },
  "sort": [ { "fieldId": "fld_Amount", "direction": "desc" } ],
  "fields": ["fld_Name", "fld_Amount"], "pageSize": 50 }
```

Cursors are interchangeable between tiers for the same logical query (same `q` hash).

### 17.9 Limits

| Limit | Value | Error |
|---|---|---|
| Filter AST depth | 8 | `QUERY_TOO_COMPLEX` |
| Filter nodes | 200 | `QUERY_TOO_COMPLEX` |
| `in` / `has_any_of` list length | 500 | `INVALID_FILTER` |
| Sort keys | 10 (Tier A: 3) | `INVALID_SORT` |
| Fields projected | 500 (all) | — |
| Includes | 5 paths, depth 1, 100 linked per source record, 5,000 included records per page | `QUERY_TOO_COMPLEX` |
| Aggregations | 20 per request, 3 `groupBy` fields, 1,000 groups | `QUERY_TOO_COMPLEX` |
| Search query | 256 chars | `INVALID_REQUEST` |
| Request body | 256 KB for `:query` | `PAYLOAD_TOO_LARGE` |

---

## 18. Outbound webhooks API

### 18.1 Delivery model decision

| Model | Pros | Cons |
|---|---|---|
| **Full payload push** (POST full change data to customer URL) | Simplest for consumers | Large/bursty payloads; ordering hard under retries; PII pushed to endpoints whose permissions may have changed since; retries resend big bodies; one slow endpoint backs up queues |
| **Notification ping + cursor pull** | Ordered, gap-free (cursor = base seq); consumer pulls at own pace; payloads computed with *current* permissions of the subscription owner; pings are tiny & coalescible; easy replay ("reset cursor") | Two round trips; consumer must implement pull |
| Hybrid inline | Ping carries payloads when small; pull for the rest | Two code paths for consumers |

**Decision [Ours]: ping + cursor pull is the canonical model**, backed by `base_changes` (D10). Pings are **coalesced** (at most one in-flight ping per subscription; additional changes set a "dirty" flag and trigger another ping after the consumer's pull or 1 s). An optional `deliveryMode: "inline"` (V1) attaches up to 50 payloads / 256 KB to the ping for low-volume consumers, with the same cursor semantics — the consumer can ignore inline data and pull. Automation-style "push a JSON to a URL on record change" remains available as an **automation action** (`14-automation-engine.md`), which is the right tool for non-developers.

### 18.2 Subscription spec

`POST /v1/bases/{baseId}/webhooks` (scope `webhooks:manage`; requires `base.read` + read access to watched tables)

```json
{
  "notificationUrl": "https://hooks.example.com/tabula",
  "description": "CRM sync",
  "spec": {
    "dataTypes": ["record", "schema"],
    "tableIds": ["tbl_Deals…"],
    "changeTypes": ["created", "updated", "deleted"],
    "watchFieldIds": ["fld_Status…", "fld_Amount…"],
    "filter": { "type": "group", "op": "and", "children": [
      { "type": "condition", "fieldId": "fld_Amount…", "operator": "gt", "value": 1000 } ] },
    "sources": ["ui", "api", "automation", "form", "import", "sync"],
    "excludeOwnChanges": true,
    "includes": { "previousValues": true, "fieldIds": ["fld_Name…"], "cellFormat": "json" }
  },
  "deliveryMode": "ping"
}
```

* `watchFieldIds`: only changes touching these fields qualify (updates); `fieldIds` under `includes` are always included for context (e.g. primary field).
* `filter`: record must match **after** (or before, for "left the filter") the change — payload `matchState: entered|stayed|left`. Evaluated in the dispatcher against post-change values from the change op; for deferred computed values evaluated when `record.computed_updated` arrives.
* `excludeOwnChanges`: skip changes made by the same token (loop prevention for 2-way syncs).
* Limits: 10 subscriptions per base per token-owner (Business), 50 per base total.

**Response `201`:**

```json
{
  "object": "webhook", "id": "whk_2Qa…", "baseId": "bas_…", "status": "active",
  "notificationUrl": "https://hooks.example.com/tabula",
  "secret": "whsec_7tQ…",                 
  "cursor": 182331,
  "createdAt": "2026-10-03T14:10:00Z", "expiresAt": null,
  "spec": { "…": "…" }
}
```

The `secret` is returned **only once** (stored envelope-encrypted in `webhook_subscriptions`; never retrievable — rotate instead).

### 18.3 Ping

```http
POST https://hooks.example.com/tabula
Content-Type: application/json
User-Agent: Tabula-Webhooks/1.0
Tabula-Webhook-Id: whk_2Qa…
Tabula-Delivery-Id: 0192a6f9-…
Tabula-Signature: t=1791036600,v1=5f2b…c9,v1=91aa…02

{ "object": "webhook_notification", "webhookId": "whk_2Qa…", "baseId": "bas_…", "latestSeq": 182340, "timestamp": "2026-10-03T14:10:00.021Z" }
```

Consumer responds `2xx` within 10 s (body ignored), then pulls.

### 18.4 Pull

`GET /v1/bases/{baseId}/webhooks/{webhookId}/payloads?cursor=182331&limit=50`

```json
{
  "object": "webhook_payload_list",
  "payloads": [
    {
      "seq": 182334,
      "timestamp": "2026-10-03T14:09:58.901Z",
      "actor": { "type": "user", "id": "usr_2bF…", "via": "ui" },
      "changeId": "chg_…",
      "correlationId": "…",
      "records": {
        "tbl_Deals…": {
          "created": [],
          "updated": [
            { "id": "rec_3J9…", "matchState": "stayed",
              "current": { "fld_Status…": "opt_9aa…", "fld_Name…": "Acme Corp" },
              "previous": { "fld_Status…": "opt_7kQ2…" },
              "changedFieldIds": ["fld_Status…"] }
          ],
          "deleted": []
        }
      },
      "schema": null
    }
  ],
  "cursor": 182341,
  "mightHaveMore": false
}
```

* Payloads are generated **on read** from `base_changes` filtered by the spec and **masked with the subscription owner's current PermissionSnapshot** (if the owner lost access → subscription moves to `status: "suspended_permission"`, pull returns `403 PERMISSION_DENIED`).
* Cursor = base `change_seq` (an integer; not secret, not signed — it only addresses the owner's own stream). Pass back `cursor` from the response; at-least-once — consumers dedupe on `seq`.
* Retention: guaranteed **7 days** of payloads (physically `BASE_CHANGES_RETENTION` = 30 days). Cursor older than retention → `410 CURSOR_EXPIRED` with `{ "restartFrom": <oldest seq> }` → consumer must full-resync (§16.3 pattern).
* The server tracks the **last pulled cursor** per subscription (`webhook_subscriptions.cursor`) for observability and auto-disable logic, but the client-provided cursor is authoritative (allows replay).

### 18.5 Signatures

* Header `Tabula-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, t + "." + rawBody)>` — multiple `v1=` during rotation.
* Consumers must verify within ±5 min tolerance (replay protection) and use constant-time compare. SDKs ship `verifyWebhookSignature(rawBody, header, secrets[])`.
* Rotation: `POST …/webhooks/{id}:rotate-secret` → new secret returned; old remains valid for 24 h (both signatures sent).

### 18.6 Retries, health, auto-disable

* Ping retries (BullMQ `webhook-out` queue; delivery attempts in `webhook_deliveries`): exponential backoff with full jitter — 10 s, 30 s, 1 m, 5 m, 15 m, 30 m, 1 h, then hourly up to **24 h**. Since pings are coalesced, retrying means "notify again"; no data is lost while the consumer is down (it's in the change log).
* Success = 2xx within 10 s. 410 from consumer → immediate disable (consumer opt-out). 3xx not followed.
* **Auto-disable:** subscription → `disabled_failing` when pings have failed continuously for **72 h** *and* no successful pull for 72 h. Owner notified (email + in-app) at 24 h and on disable. Re-enable via `PATCH {status: "active"}` (cursor preserved; if expired → client resyncs).
* **Inactivity:** subscriptions with no pulls for **30 days** are disabled (prevents zombie dispatch cost).
* **SSRF protections:** HTTPS only (except localhost in dev), DNS resolution checked against private/link-local/metadata ranges at send time (and re-checked after redirect disable), egress via dedicated NAT IPs (published for allow-listing).
* Delivery log: `GET …/webhooks/{id}/deliveries` (last 7 days: status code, latency, error class) for debugging in the developer portal.

### 18.7 Webhook events beyond records

`dataTypes`: `record` (record changes incl. links), `schema` (table/field/view created/updated/deleted), `comment` (requires `comments:read`), `form_submission` (V1). Org-level webhooks (member changes, audit) are **not** offered — those go via SIEM streaming (`audit_exports`, `25-security-observability-infrastructure.md`).

---

## 19. Relationship to realtime (WebSocket)

* The SPA uses REST for reads/writes and the WebSocket (`16-realtime.md`) for **push** of `base_changes`, presence and long-operation progress. Writes from the SPA go via REST (`PATCH` record, `records:batch`) with an `X-Tabula-Client-Op-Id` header so the realtime layer can ack the optimistic op to the originating client.
* WS auth: `POST /v1/auth/ws-ticket` (cookie or bearer) → single-use 30 s ticket; WS connection validates ticket and binds principal.
* Public realtime for third parties is **not** offered in V1; webhooks + `/changes` polling cover it. Reconsider (SSE `GET /v1/bases/{id}/changes:stream`) in V2.
* `GET /v1/bases/{baseId}/changes?sinceSeq=&tableIds=&limit=` (scope `records:read`/`schema:read`) exposes the masked change feed for polling sync clients — same payload format as webhook pulls, without a subscription.

---

## 20. SDKs

| SDK | Generation | Hand-written layer |
|---|---|---|
| TypeScript `@tabula/sdk` (Node 18+, browsers, Deno, Bun) | `openapi-typescript` types + our own thin generator for operation functions (fetch-based, no axios) | Auto-pagination async iterators (`for await (const r of t.records.list(...))`), automatic `Idempotency-Key` (UUIDv7) on mutations, retry with jitter honoring `Retry-After` and §14 rules, typed errors, webhook signature verification, OAuth PKCE helper, `Table<T>` typed facade generated from per-base OpenAPI (`npx tabula codegen --base bas_…`) |
| Python `tabula` (3.10+, sync + asyncio) | Our generator templates over the OpenAPI doc (httpx-based), Pydantic v2 models | Same features; `iter_records()`, `AsyncTabula` |
| Others (Go, Java, Ruby) | Community / OpenAPI Generator | Docs only |

Rules:

* SDKs are generated in CI from `openapi.public.json` on every release; semver-major SDK release only on API major or SDK API redesign. SDKs pin and send `Tabula-Version` (the version the SDK release was built against) — upgrading the SDK is how integrators adopt new dated versions.
* SDK telemetry: `User-Agent: tabula-sdk-ts/2.3.1 node/22.4` (no other telemetry).
* Contract tests: SDK suites run against a **mock server** generated from the spec (Prism) and a nightly run against staging.

---

## 21. Deprecation and change policy

| Change class | Process | Minimum notice |
|---|---|---|
| Additive (new endpoint/field/enum value in open enums) | Ship anytime; changelog | 0 |
| Behavior change | New dated `Tabula-Version`; old behavior preserved for pinned clients | Old version supported ≥ 18 months after the new date |
| Deprecate endpoint/param | `Deprecation: @<unix-ts>` (RFC 9745) + `Sunset: <HTTP-date>` (RFC 8594) + `Link: <migration guide>; rel="deprecation"` headers; changelog; developer-portal banner; **email to owners of tokens/apps that called it in the last 90 days** (from per-token analytics) | 12 months to sunset (6 for security-motivated) |
| Removal | **Brownouts** before sunset: 2 × 1 h at T-30 d, 2 × 4 h at T-14 d returning `410 ENDPOINT_REMOVED`; then removal | — |
| Major version (`/v2`) | RFC + beta + migration guide | `/v1` ≥ 24 months after `/v2` GA |
| Security emergency | May break immediately; post-incident notice | 0 |

Undocumented behavior is not covered, but any behavior we observe ≥ 5% of traffic relying on is treated as contract (Hyrum's-law check before changes, using request analytics).

---

## 22. Developer portal (`developers.tabula.example`)

* **Reference docs** generated from `openapi.public.json` (Scalar or Redocly renderer), with per-language samples from SDK snippets, error catalogue pages (the `type` URIs of §14 resolve here), changelog per dated version, and a version diff viewer.
* **Base-specific docs**: for a signed-in user, `/bases/{id}` renders docs from the per-base OpenAPI (field IDs, types, example values from the caller's own data are **not** shown — only synthetic examples, to avoid leaking data in screenshots).
* **API playground**: authenticated with a short-lived, read-only, base-restricted session token (never the user's PAT) unless the user explicitly selects a write-scoped token.
* **Token management** (PATs: create with scopes + base restrictions + expiry; MFA step-up required), **service accounts** (admins), **OAuth apps** (register client, redirect URIs, logo, scopes requested, publish to marketplace after review), **webhooks** console (subscriptions, delivery log, "send test ping", cursor reset).
* **Request log**: last 7 days of the caller's token requests (method, path template, status, latency, cost, request id; no bodies) — sourced from the API access log pipeline (Loki/ClickHouse-class store), filtered by token owner.
* **Usage & limits**: current rate-limit consumption, monthly quotas, deprecated-feature usage warnings.
* Status page link, SDK downloads, guides (sync pattern, upsert, webhooks, OAuth app tutorial, rate-limit best practices).

---

## 23. API observability and per-token analytics

* Every request emits a structured access log (pino → Loki/OTel logs): `requestId, traceId, route, operationId, status, durationMs, principalType, tokenId, orgId, baseId, cost, rateLimitScopeHit, tabulaVersion, sdk, deprecatedFeatures[]`.
* RED metrics per `operationId` (Prometheus), p50/p95/p99 SLOs: reads p95 < 300 ms (≤ 100 records), writes p95 < 500 ms (single), `:query` with aggregations p95 < 1.5 s on ≤ 100k-record tables.
* Per-token daily rollups (calls, errors, cost, deprecated usage, last used) feed the portal and deprecation emails; stored in `usage_events` (metric `api_request`, sampled 1:1 aggregated per minute) → `usage_counters`.
* Security analytics: spikes in `401/403` per token or IP feed the abuse detector (`25-security-observability-infrastructure.md`).

---

## 24. Implementation layout

```
packages/api-contract/          TypeBox schemas, error catalogue, scopes, VersionTransforms, cursor codec
packages/query/                 RecordQuery model, Tier A filter parser, AST validation, SQL compiler, seek predicates
apps/server/src/http/
  plugins/                      auth.ts, csrf.ts, ratelimit.ts, idempotency.ts, version.ts, problem.ts, base-routing.ts
  routes/<tag>/*.ts             defineRoute modules (one per operation)
  openapi/                      registry walker → openapi.{public,internal}.json
apps/server/src/modules/webhooks/  subscription service, dispatcher (worker queue webhook-out), payload builder
sdk/typescript/, sdk/python/    generators + hand-written layers
```

---

## 25. Proposed additions

| Item | Kind | Reason |
|---|---|---|
| `core.idempotency_keys` | New table (control plane) | Idempotency for control-plane mutations (orgs, users, tokens, workspaces), mirroring `data.idempotency_keys` |
| `core.api_tokens.kind` (`pat`/`service_account`/`oauth_access`) + `oauth_grant_id`, `pinned_api_version`, `last_used_at`, `last_used_ip` | Columns | Single opaque-token table for all bearer types (§5); version pinning (§4) |
| `core.oauth_clients.pinned_api_version` | Column | Default `Tabula-Version` for OAuth apps |
| `data.webhook_subscriptions` columns: `spec jsonb`, `delivery_mode`, `secret_enc`, `secret_prev_enc`, `secret_prev_expires_at`, `cursor bigint`, `last_pulled_at`, `failing_since`, `status` (`active`, `disabled_failing`, `disabled_inactive`, `suspended_permission`, `disabled_by_user`) | Columns | §18 |
| `bases.settings.requireIfMatchForApiWrites` | Setting key | §11 |
| `rl:*`, `idem:*`, `tok:{tokenId}`, `basedir:{baseId}`, `sem:heavy:{tokenId}` Redis keys | Redis namespaces | `tok:` and `basedir:` and `sem:` are new namespaces not in Spine §10 |
| `GET /v1/bases/{baseId}/changes` | Endpoint | Masked change feed for polling sync (§19) |
| ADR-016 "No public GraphQL; REST + WS" and ADR "Hybrid versioning (path major + dated header)" | ADRs | For `33-architecture-decision-records.md` |
