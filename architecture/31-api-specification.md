# 31 — API Specification (OpenAPI 3.1 Outline)

> **Status:** Proposed for architectural approval · **Owner:** API Platform · **Date:** 2026-10-03
> Conforms to [`00-canonical-decisions.md`](./00-canonical-decisions.md). Cross-cutting behavior (auth, scopes, idempotency, ETags, errors, rate limits, pagination, query system, webhooks) is defined normatively in [`17-api-architecture.md`](./17-api-architecture.md); this document is the **endpoint inventory and schema outline** from which `packages/api-contract` is implemented.

**Sections covered:** Section 57 (API Specification) · Part 54 (Endpoint catalogue & OpenAPI outline)

Related: [`11-filter-sort-group.md`](./11-filter-sort-group.md) (FilterNode), [`14-automation-engine.md`](./14-automation-engine.md), [`16-realtime.md`](./16-realtime.md), [`19-permissions-and-multitenancy.md`](./19-permissions-and-multitenancy.md), [`20-import-export-sharing-integrations.md`](./20-import-export-sharing-integrations.md), [`25-security-observability-infrastructure.md`](./25-security-observability-infrastructure.md).

---

## Table of contents

1. Document conventions
2. OpenAPI root, servers, security schemes, common parameters & headers
3. `components/schemas` (core)
4. Tag: Auth
5. Tag: Users
6. Tag: Organizations
7. Tag: Workspaces
8. Tag: Bases
9. Tag: Tables
10. Tag: Fields
11. Tag: Records
12. Tag: Views
13. Tag: Forms
14. Tag: Interfaces
15. Tag: Automations
16. Tag: Contacts
17. Tag: Attachments
18. Tag: Comments
19. Tag: Notifications
20. Tag: Integrations
21. Tag: Webhooks
22. Tag: Search
23. Tag: Audit
24. Tag: Imports / Exports
25. Tag: Long operations
26. Tag: SCIM v2
27. Operation count & coverage checklist
28. Proposed additions

---

## 1. Document conventions

* Paths are relative to `https://api.tabula.example` and (except `/scim/v2`, `/.well-known`) start with `/v1`.
* **Permission** column uses Spine §9 action strings; **Scope** uses `17-…` §6. `session` means first-party cookie only (not available to tokens). `public` means unauthenticated (rate-limited by IP/share).
* "Std errors" = `400 INVALID_REQUEST`, `401` family, `403 INSUFFICIENT_SCOPE|PERMISSION_DENIED`, `404 <RESOURCE>_NOT_FOUND`, `429 RATE_LIMITED`, `5xx`. Only **additional** codes are listed per operation.
* Every mutating operation accepts `Idempotency-Key` unless marked `no-idem`. Every list is cursor-paginated (`pageSize`, `cursor` → `CursorPage<T>`) unless marked otherwise.
* `operationId` = `<tag>.<verb>` (e.g. `records.query`) — used as SDK method names (`client.records.query()`).
* Bodies are shown as abbreviated JSON or YAML schemas; full TypeBox definitions live in `packages/api-contract/src/schemas/*`.

---

## 2. OpenAPI root

```yaml
openapi: 3.1.0
info:
  title: Tabula API
  version: "v1"                         # path major; dated minor via Tabula-Version
  x-tabula-current-version: "2026-10-01"
servers:
  - url: https://api.tabula.example
jsonSchemaDialect: https://json-schema.org/draft/2020-12/schema
security:
  - bearerAuth: []
  - oauth2: []
  - sessionCookie: []
tags:
  - { name: Auth } ; - { name: Users } ; - { name: Organizations } ; - { name: Workspaces }
  - { name: Bases } ; - { name: Tables } ; - { name: Fields } ; - { name: Records } ; - { name: Views }
  - { name: Forms } ; - { name: Interfaces } ; - { name: Automations } ; - { name: Contacts }
  - { name: Attachments } ; - { name: Comments } ; - { name: Notifications } ; - { name: Integrations }
  - { name: Webhooks } ; - { name: Search } ; - { name: Audit } ; - { name: Imports } ; - { name: Exports }
  - { name: LongOperations } ; - { name: SCIM }
components:
  securitySchemes:
    bearerAuth:
      type: http
      scheme: bearer
      description: PAT (tpat_…), service account (tsvc_…) or OAuth access token (toat_…)
    oauth2:
      type: oauth2
      flows:
        authorizationCode:
          authorizationUrl: https://api.tabula.example/v1/auth/oauth/authorize
          tokenUrl: https://api.tabula.example/v1/auth/oauth/token
          refreshUrl: https://api.tabula.example/v1/auth/oauth/token
          scopes:
            records:read: Read records
            records:write: Create, update, delete records
            schema:read: Read bases, tables, fields, views
            schema:write: Modify tables, fields, views
            webhooks:manage: Manage webhook subscriptions
            comments:read: Read comments
            comments:write: Write comments
            automations:read: Read automations and runs
            automations:write: Manage automations
            interfaces:read: Read interfaces
            interfaces:write: Manage interfaces
            attachments:write: Upload attachments
            contacts:read: Read contacts
            contacts:write: Manage contacts
            users:read: Read users and teams
            workspaces:read: Read workspaces
            workspaces:write: Manage workspaces
            bases:manage: Manage base members, share links, snapshots, trash
            imports:write: Run imports
            exports:read: Run exports
            integrations:manage: Manage integration connections and sync sources
            audit:read: Read audit logs
            ai:use: Use AI features
            offline_access: Refresh tokens
    sessionCookie:
      type: apiKey
      in: cookie
      name: tabula_sid
      description: First-party only; requires X-CSRF-Token on unsafe methods
    scimBearer:
      type: http
      scheme: bearer
  parameters:
    BaseId:      { name: baseId,      in: path, required: true, schema: { $ref: '#/components/schemas/BaseId' } }
    TableId:     { name: tableId,     in: path, required: true, schema: { $ref: '#/components/schemas/TableId' } }
    FieldId:     { name: fieldId,     in: path, required: true, schema: { $ref: '#/components/schemas/FieldId' } }
    RecordId:    { name: recordId,    in: path, required: true, schema: { $ref: '#/components/schemas/RecordId' } }
    ViewId:      { name: viewId,      in: path, required: true, schema: { $ref: '#/components/schemas/ViewId' } }
    PageSize:    { name: pageSize,    in: query, schema: { type: integer, minimum: 1, maximum: 1000, default: 100 } }
    Cursor:      { name: cursor,      in: query, schema: { type: string, maxLength: 2048 } }
    CellFormat:  { name: cellFormat,  in: query, schema: { enum: [json, string], default: json } }
    FieldKey:    { name: fieldKey,    in: query, schema: { enum: [id, name], default: id } }
    TimeZone:    { name: timeZone,    in: query, schema: { type: string, examples: [America/New_York] } }
    Locale:      { name: locale,      in: query, schema: { type: string, examples: [en-US] } }
    Typecast:    { name: typecast,    in: query, schema: { type: boolean, default: false } }
  headers:
    IdempotencyKey: { schema: { type: string, minLength: 1, maxLength: 255 } }
    IfMatch:        { schema: { type: string, examples: ['"r17"'] } }
    TabulaVersion:  { schema: { type: string, pattern: '^\d{4}-\d{2}-\d{2}$' } }
    RateLimit:      { schema: { type: string } }
    RateLimitPolicy:{ schema: { type: string } }
    RetryAfter:     { schema: { type: integer } }
    ETag:           { schema: { type: string } }
```

**Common request headers:** `Authorization`, `Tabula-Version`, `Idempotency-Key`, `If-Match`, `If-None-Match`, `X-Request-Id`, `X-CSRF-Token` (cookie only), `Accept-Language`, `Tabula-Consistency: strong|eventual` (reads).
**Common response headers:** `X-Request-Id`, `Tabula-Version`, `RateLimit`, `RateLimit-Policy`, `ETag` (versioned resources), `Idempotent-Replayed`, `Deprecation`, `Sunset`, `Location` (201/202).

---

## 3. `components/schemas` (core)

### 3.1 Identifiers and primitives

```yaml
PublicId:
  type: string
  pattern: '^[a-z]{3}_[0-9A-Za-z]{22}$'
BaseId:   { allOf: [ { $ref: '#/components/schemas/PublicId' } ], pattern: '^bas_' }
TableId:  { allOf: [ { $ref: '#/components/schemas/PublicId' } ], pattern: '^tbl_' }
FieldId:  { allOf: [ { $ref: '#/components/schemas/PublicId' } ], pattern: '^fld_' }
RecordId: { allOf: [ { $ref: '#/components/schemas/PublicId' } ], pattern: '^rec_' }
ViewId:   { allOf: [ { $ref: '#/components/schemas/PublicId' } ], pattern: '^viw_' }
OptionId: { allOf: [ { $ref: '#/components/schemas/PublicId' } ], pattern: '^opt_' }
# … one per Spine §3 prefix (org, wsp, usr, tem, itf, pag, elm, aut, atv, run, stp, att, cmt, ntf, whk,
#   ihk, con, sct, tok, svc, app, evt, chg, imp, exp, lop, snp, rev, inv, aij, tpl, shr, ctc, vsc)
Timestamp: { type: string, format: date-time }
Decimal:   { type: string, pattern: '^-?\d+(\.\d+)?$' }
FieldType:
  enum: [text, long_text, number, currency, percent, date, datetime, duration, checkbox,
         single_select, multi_select, email, phone, url, rating, collaborator, attachment,
         barcode, link, contact, formula, lookup, rollup, count, autonumber, created_time,
         modified_time, created_by, modified_by, button, ai_generated, json]
  x-tabula-open-enum: true          # clients must tolerate new values
```

### 3.2 Problem

```yaml
Problem:
  type: object
  required: [type, title, status, code, requestId]
  properties:
    type:      { type: string, format: uri }
    title:     { type: string }
    status:    { type: integer }
    code:      { $ref: '#/components/schemas/ErrorCode' }
    detail:    { type: string }
    instance:  { type: string }
    requestId: { type: string }
    docs:      { type: string, format: uri }
    errors:
      type: array
      items:
        type: object
        required: [code]
        properties:
          pointer: { type: string, description: RFC 6901 pointer into the request }
          code:    { type: string }
          detail:  { type: string }
          fieldId: { $ref: '#/components/schemas/FieldId' }
  additionalProperties: true        # code-specific extension members (retryAfterMs, currentResource, limit…)
ErrorCode:
  type: string
  x-tabula-open-enum: true
  enum: [UNAUTHENTICATED, INVALID_TOKEN, TOKEN_EXPIRED, TOKEN_REVOKED, MFA_REQUIRED, CSRF_TOKEN_INVALID,
         INSUFFICIENT_SCOPE, PERMISSION_DENIED, FIELD_NOT_EDITABLE, VIEW_LOCKED, TOKEN_RESOURCE_RESTRICTED,
         IP_NOT_ALLOWED, SSO_REQUIRED, API_ACCESS_DISABLED, ORG_POLICY_VIOLATION, PLAN_LIMIT_EXCEEDED,
         INVALID_REQUEST, MALFORMED_JSON, INVALID_ID, UNSUPPORTED_API_VERSION, INVALID_SCOPE, PAYLOAD_TOO_LARGE,
         BATCH_TOO_LARGE, UNSUPPORTED_MEDIA_TYPE, NOT_FOUND, BASE_NOT_FOUND, TABLE_NOT_FOUND, FIELD_NOT_FOUND,
         VIEW_NOT_FOUND, RECORD_NOT_FOUND, ENDPOINT_REMOVED, FIELD_VALIDATION_FAILED, UNKNOWN_FIELD,
         BATCH_VALIDATION_FAILED, DUPLICATE_RECORD_IN_BATCH, UPSERT_AMBIGUOUS_MATCH, INVALID_FILTER, INVALID_SORT,
         INVALID_FORMULA, FIELD_TYPE_CHANGE_UNSUPPORTED, SCHEMA_CONSTRAINT_VIOLATION, QUERY_TOO_COMPLEX,
         IDEMPOTENCY_KEY_REUSED, ATTACHMENT_REJECTED, WEBHOOK_URL_NOT_ALLOWED, VERSION_CONFLICT,
         PRECONDITION_REQUIRED, CONFLICT, IDEMPOTENCY_IN_PROGRESS, ATTACHMENT_NOT_READY, INVALID_CURSOR,
         CURSOR_EXPIRED, RATE_LIMITED, CONCURRENCY_LIMITED, QUOTA_EXCEEDED, OPERATION_FAILED, OPERATION_CANCELLED,
         INTERNAL_ERROR, SERVICE_UNAVAILABLE, BASE_UNAVAILABLE, QUERY_TIMEOUT, UPSTREAM_ERROR]
```

Every operation declares `default: { $ref: '#/components/responses/Problem' }` with `content: application/problem+json`.

### 3.3 Cursor page

```yaml
CursorPage:
  description: Generic list envelope; specialized via allOf with data items
  type: object
  required: [object, data, hasMore, nextCursor]
  properties:
    object:     { const: list }
    data:       { type: array, items: {} }
    hasMore:    { type: boolean }
    nextCursor: { type: [string, 'null'], description: Opaque, HMAC-signed (17-… §16) }
    meta:
      type: object
      properties:
        snapshotSeq:   { type: integer }
        schemaVersion: { type: integer }
# Usage:  RecordPage: { allOf: [ { $ref: CursorPage }, { properties: { data: { items: { $ref: Record } } } } ] }
```

### 3.4 FilterNode (AST — normative definition in `11-filter-sort-group.md`)

```yaml
FilterNode:
  oneOf:
    - $ref: '#/components/schemas/FilterGroup'
    - $ref: '#/components/schemas/FilterCondition'
  discriminator: { propertyName: type, mapping: { group: FilterGroup, condition: FilterCondition } }
FilterGroup:
  type: object
  required: [type, op, children]
  properties:
    type:     { const: group }
    op:       { enum: [and, or] }
    children: { type: array, maxItems: 200, items: { $ref: '#/components/schemas/FilterNode' } }
FilterCondition:
  type: object
  required: [type, fieldId, operator]
  properties:
    type:     { const: condition }
    fieldId:  { type: string, description: Field ID (or name when fieldKey=name) }
    operator:
      type: string
      x-tabula-open-enum: true
      description: Operator names per 11-filter-sort-group.md, validated per field type
      examples: [eq, neq, gt, gte, lt, lte, contains, not_contains, starts_with, is_empty, is_not_empty,
                 in, not_in, has_any_of, has_all_of, has_none_of, is_within, is_before, is_after, is_me]
    value:    { description: Typed by field type and operator; omitted for unary operators }
SortSpec:
  type: object
  required: [fieldId]
  properties:
    fieldId:   { type: string }
    direction: { enum: [asc, desc], default: asc }
```

### 3.5 Record

```yaml
Record:
  type: object
  required: [object, id, createdAt, updatedAt, version, values]
  properties:
    object:    { const: record }
    id:        { $ref: '#/components/schemas/RecordId' }
    tableId:   { $ref: '#/components/schemas/TableId' }
    createdAt: { $ref: '#/components/schemas/Timestamp' }
    updatedAt: { $ref: '#/components/schemas/Timestamp' }
    createdBy: { $ref: '#/components/schemas/ActorRef' }
    version:   { type: integer, minimum: 1 }
    values:
      type: object
      description: Map fieldKey → CellValue. Empty cells are absent. Per-base OpenAPI narrows this.
      additionalProperties: { $ref: '#/components/schemas/CellValue' }
    computedStatus:
      type: object
      additionalProperties: { enum: [stale, pending, error] }
    deletedAt: { $ref: '#/components/schemas/Timestamp' }
    meta:      { type: object, additionalProperties: true }
CellValue:
  description: JSON value whose shape depends on field type & cellFormat (17-… §9.2)
  oneOf:
    - { type: string }
    - { type: number }
    - { type: boolean }
    - { $ref: '#/components/schemas/SelectOptionRef' }
    - { type: array, items: { $ref: '#/components/schemas/SelectOptionRef' } }
    - { $ref: '#/components/schemas/UserRef' }
    - { type: array, items: { $ref: '#/components/schemas/UserRef' } }
    - { type: array, items: { $ref: '#/components/schemas/LinkedRecordRef' } }
    - { type: array, items: { $ref: '#/components/schemas/AttachmentRef' } }
    - { type: object, additionalProperties: true }
SelectOptionRef:  { type: object, required: [id], properties: { id: { $ref: OptionId }, name: { type: string }, color: { type: string } } }
UserRef:          { type: object, required: [id], properties: { id: { type: string, pattern: '^usr_' }, name: { type: string }, email: { type: string } } }
LinkedRecordRef:  { type: object, required: [id], properties: { id: { $ref: RecordId }, displayValue: { type: string } } }
AttachmentRef:
  type: object
  required: [id]
  properties:
    id: { type: string, pattern: '^att_' }
    filename: { type: string }
    mimeType: { type: string }
    size: { type: integer }
    url: { type: string, format: uri }
    urlExpiresAt: { $ref: Timestamp }
    width: { type: integer }
    height: { type: integer }
    status: { enum: [scanning, ready, rejected] }
    thumbnails: { type: object, additionalProperties: { type: object, properties: { url: { type: string }, width: { type: integer }, height: { type: integer } } } }
ActorRef: { type: object, properties: { type: { enum: [user, api_token, service_account, automation, integration, ai, system, public_form] }, id: { type: string }, via: { type: string } } }
```

### 3.6 Table, Field, View

```yaml
Table:
  type: object
  required: [object, id, name, primaryFieldId]
  properties:
    object: { const: table }
    id: { $ref: TableId }
    baseId: { $ref: BaseId }
    name: { type: string, maxLength: 255 }
    description: { type: string, maxLength: 20000 }
    primaryFieldId: { $ref: FieldId }
    icon: { type: string }
    order: { type: string, description: fractional index key }
    recordCountApprox: { type: integer }
    restrictions: { $ref: TableRestrictions }
    fields: { type: array, items: { $ref: Field }, description: present when ?include=fields }
    views:  { type: array, items: { $ref: ViewSummary }, description: present when ?include=views }
    createdAt: { $ref: Timestamp }
    isSynced: { type: boolean, description: true for sync-source tables (read-only) }
TableRestrictions:
  type: object
  properties:
    recordCreate: { $ref: RoleRestriction }
    recordDelete: { $ref: RoleRestriction }
RoleRestriction:
  type: object
  properties:
    minRole: { enum: [creator, editor] }
    allowUserIds: { type: array, items: { type: string } }
    allowTeamIds: { type: array, items: { type: string } }
Field:
  type: object
  required: [object, id, name, type, config]
  properties:
    object: { const: field }
    id: { $ref: FieldId }
    tableId: { $ref: TableId }
    name: { type: string, maxLength: 255 }
    description: { type: string, maxLength: 20000 }
    type: { $ref: FieldType }
    config:
      description: Type-specific config, discriminated by `type` (07-field-engine.md). Examples below.
      oneOf:
        - $ref: TextConfig            # { maxLength? }
        - $ref: NumberConfig          # { precision: 0..8, allowNegative }
        - $ref: CurrencyConfig        # { currencyCode, precision }
        - $ref: SelectConfig          # { options: [{ id, name, color, order }] }
        - $ref: LinkConfig            # { targetTableId, allowMultiple, inverseFieldId, linkRelationId, viewIdForSelection? }
        - $ref: LookupConfig          # { linkFieldId, targetFieldId }
        - $ref: RollupConfig          # { linkFieldId, targetFieldId, aggregation, formula? }
        - $ref: FormulaConfig         # { formula, resultType (read-only), referencedFieldIds (read-only) }
        - $ref: AiGeneratedConfig     # { promptTemplateId | prompt, inputFieldIds, model?, autoRun }
        - { type: object, additionalProperties: true }
    isPrimary: { type: boolean }
    isComputed: { type: boolean, readOnly: true }
    restrictions: { type: object, properties: { edit: { $ref: RoleRestriction }, hiddenFrom: { $ref: RoleRestriction } } }
    order: { type: string }
    createdAt: { $ref: Timestamp }
ViewSummary:
  type: object
  properties:
    object: { const: view }
    id: { $ref: ViewId }
    name: { type: string }
    type: { enum: [grid, kanban, calendar, gallery, timeline, gantt, list, form] }
    visibility: { enum: [collaborative, personal, locked] }
    sectionId: { type: [string, 'null'] }
View:
  allOf:
    - $ref: ViewSummary
    - type: object
      properties:
        tableId: { $ref: TableId }
        version: { type: integer }
        config:
          type: object
          description: Typed by view type (10-view-engine.md)
          properties:
            filter: { $ref: FilterNode }
            sort: { type: array, items: { $ref: SortSpec } }
            groupBy: { type: array, maxItems: 3, items: { type: object, properties: { fieldId: { type: string }, direction: { enum: [asc, desc] } } } }
            fields: { type: array, items: { type: object, properties: { fieldId: { type: string }, visible: { type: boolean }, width: { type: integer } } } }
            rowHeight: { enum: [short, medium, tall, extra_tall] }
            colorRules: { type: array, items: { type: object } }
            # kanban: stackFieldId; calendar: dateFieldId/endDateFieldId; gallery: coverFieldId; timeline: start/end/groupBy…
          additionalProperties: true
```

### 3.7 Misc shared schemas

```yaml
LongOperation:
  type: object
  required: [object, id, kind, status]
  properties:
    object: { const: long_operation }
    id: { type: string, pattern: '^lop_' }
    kind: { enum: [field.type_change, table.duplicate, base.duplicate, records.bulk_delete, records.batch_async,
                  import.run, export.run, snapshot.restore, workspace.move, audit.export, interface.publish] }
    status: { enum: [queued, running, succeeded, failed, cancelling, cancelled] }
    progress: { type: object, properties: { completed: { type: integer }, total: { type: [integer, 'null'] }, unit: { type: string } } }
    resource: { type: object, properties: { object: { type: string }, id: { type: string } } }
    result: { type: object, additionalProperties: true }
    error: { $ref: Problem }
    cancellable: { type: boolean }
    createdAt: { $ref: Timestamp }
    startedAt: { $ref: Timestamp }
    finishedAt: { $ref: Timestamp }
    links: { type: object, properties: { self: { type: string }, cancel: { type: string } } }
Role:
  enum: [owner, admin, billing_admin, member, guest, creator, editor, commenter, viewer, interface_only,
         interface_editor, interface_user]
Grant:
  type: object
  properties:
    object: { const: grant }
    resourceType: { enum: [organization, workspace, base, interface] }
    resourceId: { type: string }
    principalType: { enum: [user, team, service_account] }
    principalId: { type: string }
    role: { $ref: Role }
    grantedAt: { $ref: Timestamp }
    grantedBy: { type: string }
    inheritedFrom: { type: [string, 'null'], description: present on effective-access listings }
DeletedResource:
  type: object
  properties: { object: { type: string }, id: { type: string }, deleted: { const: true }, deletionBatchId: { type: string }, restorableUntil: { $ref: Timestamp } }
```

---

## 4. Tag: Auth

| Method & path | Summary | Auth / Scope | Request → Response | Extra errors |
|---|---|---|---|---|
| `POST /v1/auth/login` | Password login (step 1) | public (IP + account rate limit, `25-security-observability-infrastructure.md`) | `{ email, password, rememberMe? }` → `200 { status: "authenticated", user, csrfToken }` + `Set-Cookie`, or `200 { status: "mfa_required", mfaToken, factors: [{type:"totp"},{type:"webauthn"}] }`, or `200 { status: "sso_required", ssoStartUrl }` | `401 UNAUTHENTICATED` with a generic `detail` ("Email or password is incorrect") — no account-existence oracle; `429 RATE_LIMITED` |
| `POST /v1/auth/mfa/verify` | Complete MFA | public (`mfaToken`) | `{ mfaToken, type: "totp", code }` or `{ mfaToken, type: "webauthn", assertion }` or `{ mfaToken, type: "recovery_code", code }` → `200 { status:"authenticated", user, csrfToken }` | `401 INVALID_TOKEN` (expired mfaToken, 5 min) |
| `POST /v1/auth/mfa/webauthn/options` | Get WebAuthn challenge | public (`mfaToken`) or session | `{ mfaToken?, purpose: "login" or "register" }` → `200 PublicKeyCredentialRequestOptions` | |
| `POST /v1/auth/mfa/factors` | Enroll factor | session (recent auth ≤ 10 min) | `{ type: "totp" }` → `200 { factorId, otpauthUri, secretQr }`; confirm with `POST …/factors/{id}:confirm { code }` → `200 { recoveryCodes[] }` (first factor only) | `401 MFA_REQUIRED` |
| `DELETE /v1/auth/mfa/factors/{factorId}` | Remove factor | session + step-up | → `204` | `403 ORG_POLICY_VIOLATION` (org requires MFA, last factor) |
| `GET /v1/auth/session` | Bootstrap current session | session | → `200 { user, orgs[], csrfToken, mfaLevel, expiresAt, featureFlags }` | |
| `POST /v1/auth/logout` | Revoke current session | session | `{ allSessions?: false }` → `204` + cookie cleared | |
| `GET /v1/auth/sessions` / `DELETE /v1/auth/sessions/{id}` | List / revoke own sessions | session | → `CursorPage<Session>` / `204` | |
| `POST /v1/auth/sso/start` | Begin SAML/OIDC SSO (home-realm discovery by email domain or org slug) | public | `{ email? , orgSlug?, returnTo? }` → `200 { redirectUrl }` (Jackson authorize URL with state + PKCE) | `404 NOT_FOUND` (no SSO for domain) |
| `GET /v1/auth/sso/callback` | IdP response (SAML ACS via Jackson / OIDC code) | public | query `code, state` → `302` to `returnTo` with session cookie (JIT provisioning per org policy) | `403 ORG_POLICY_VIOLATION` (user not assigned / domain mismatch) |
| `GET /v1/auth/oauth/authorize` | OAuth 2.1 authorize (shows consent UI) | session | query `response_type=code, client_id, redirect_uri, scope, state, code_challenge, code_challenge_method=S256` → `302` consent page → `302 redirect_uri?code&state` | RFC 6749 errors redirected (`invalid_scope`, `access_denied`) |
| `POST /v1/auth/oauth/token` | Token endpoint | client auth (basic/`private_key_jwt`) or public client + PKCE | `application/x-www-form-urlencoded`: `grant_type=authorization_code\|refresh_token`, … → `200 { access_token: "toat_…", token_type: "Bearer", expires_in: 3600, refresh_token: "tort_…", scope }` | RFC 6749 JSON errors (`invalid_grant` on refresh reuse → family revoked) |
| `POST /v1/auth/oauth/revoke` | RFC 7009 revoke | client auth | `token, token_type_hint` → `200` | |
| `POST /v1/auth/oauth/introspect` | RFC 7662 | confidential client | `token` → `200 { active, scope, client_id, sub, exp }` | |
| `GET /.well-known/oauth-authorization-server` | RFC 8414 metadata | public | → `200` | |
| `POST /v1/auth/ws-ticket` | Single-use WebSocket ticket | session or bearer (`records:read`) | `{ baseIds?: [] }` → `200 { ticket, expiresAt, url: "wss://rt.tabula.example/v1/ws" }` | |
| `POST /v1/auth/password/forgot` / `:reset` | Password reset | public | `{ email }` → `202` always; `{ token, newPassword }` → `204` | `422 FIELD_VALIDATION_FAILED` (weak password) |
| `POST /v1/auth/email/verify` | Verify email (signup / invitation) | public (token) | `{ token }` → `204` | `401 TOKEN_EXPIRED` |

Notes: OAuth endpoints use OAuth's own error format (RFC 6749 §5.2) rather than problem+json, because OAuth client libraries expect it. Login never distinguishes unknown email from wrong password.

Example — login with MFA:

```http
POST /v1/auth/login
Content-Type: application/json

{ "email": "dana@example.com", "password": "••••••••••••" }
```
```json
{ "status": "mfa_required", "mfaToken": "mfa_9f…", "expiresAt": "2026-10-03T14:15:00Z",
  "factors": [ { "type": "webauthn" }, { "type": "totp" }, { "type": "recovery_code" } ] }
```

---

## 5. Tag: Users

| Method & path | Summary | Scope · Permission | Request → Response | Extra errors |
|---|---|---|---|---|
| `GET /v1/users/me` | Current principal | any valid token | → `200 User` (+ `principal: { type, tokenId?, scopes[] }`) | |
| `PATCH /v1/users/me` | Update profile | session | `{ name?, avatarAttachmentId?, locale?, timeZone? }` → `200 User` | |
| `POST /v1/users/me/email:change` | Change email (verification) | session + step-up | `{ newEmail }` → `202` | `409 CONFLICT`, `403 ORG_POLICY_VIOLATION` (SSO-managed) |
| `GET /v1/users/me/preferences` / `PATCH` | UI preferences (`user_preferences`) | session | JSON merge patch → `200 Preferences` | |
| `GET /v1/users/me/tokens` | List own PATs | session | → `CursorPage<ApiToken>` (no secrets) | |
| `POST /v1/users/me/tokens` | Create PAT | session + MFA step-up | `{ name, scopes[], resourceRestrictions?, expiresAt?, pinnedApiVersion? }` → `201 ApiToken & { token: "tpat_…" }` (secret shown once) | `400 INVALID_SCOPE`, `403 ORG_POLICY_VIOLATION` (expiry > policy max) |
| `PATCH /v1/users/me/tokens/{tokenId}` | Rename/narrow scopes/restrictions (cannot widen) | session | → `200 ApiToken` | `422 INVALID_REQUEST` (widening) |
| `DELETE /v1/users/me/tokens/{tokenId}` | Revoke | session | → `204` | |
| `GET /v1/users/me/oauth-grants` / `DELETE …/{grantId}` | Authorized third-party apps | session | → list / `204` (revokes refresh family) | |
| `GET /v1/users/{userId}` | Public profile of a user sharing an org | `users:read` | → `200 UserSummary` (email per org visibility policy) | |

```yaml
ApiToken:
  properties:
    object: { const: api_token }
    id: { type: string, pattern: '^tok_' }
    name: { type: string }
    kind: { enum: [pat, service_account] }
    scopes: { type: array, items: { type: string } }
    resourceRestrictions: { type: object, properties: { workspaceIds: { type: array }, baseIds: { type: array }, ipAllowList: { type: array } } }
    tokenPrefix: { type: string, examples: ['tpat_4f9Kc…'] }
    pinnedApiVersion: { type: string }
    expiresAt: { type: [string, 'null'] }
    lastUsedAt: { type: [string, 'null'] }
    createdAt: { type: string }
```

---

## 6. Tag: Organizations

| Method & path | Summary | Scope · Permission | Request → Response | Extra errors |
|---|---|---|---|---|
| `GET /v1/organizations` | Orgs of the principal | any | → `CursorPage<Organization>` | |
| `GET /v1/organizations/{orgId}` | Get org | `users:read` · member | → `200 Organization` (plan, seat usage for admins) | |
| `PATCH /v1/organizations/{orgId}` | Update name/slug/logo | `org:admin` · `org.manage` | → `200` | `409 CONFLICT` (slug) |
| `GET /v1/organizations/{orgId}/members` | List members | `users:read` · member (guests: 403) | query `role`, `status`, `q`, `teamId` → `CursorPage<OrgMember>` | |
| `POST /v1/organizations/{orgId}/members:invite` | Invite users to org | `org:admin` · `org.manage` | `{ invites: [{ email, role, teamIds? }] }` (≤ 100) → `200 { results: [{ email, invitationId \| error }] }` | `403 ORG_POLICY_VIOLATION` (domain restriction), `403 PLAN_LIMIT_EXCEEDED` (seats) |
| `PATCH /v1/organizations/{orgId}/members/{userId}` | Change org role / deactivate | `org:admin` · `org.manage` | `{ role?, status?: "active"\|"deactivated" }` → `200 OrgMember` | `409 CONFLICT` (last owner); `403` (SCIM-managed users: role change only via SCIM if `scimManaged`) |
| `DELETE /v1/organizations/{orgId}/members/{userId}` | Remove member (+ transfer ownership option) | `org:admin` | query `transferTo=usr_…` → `202 LongOperation` (grant cleanup across shards) | |
| `GET/POST /v1/organizations/{orgId}/teams` | List / create team | `users:read` / `org:admin` | `{ name, description? }` → `201 Team` | `409 CONFLICT` |
| `GET/PATCH/DELETE /v1/organizations/{orgId}/teams/{teamId}` | Team CRUD | as above | → `200` / `204` | `403` (SCIM-managed team) |
| `POST /v1/organizations/{orgId}/teams/{teamId}/members` / `DELETE …/members/{userId}` | Team membership | `org:admin` | `{ userIds[] }` → `200 Team` | |
| `GET/POST /v1/organizations/{orgId}/domains` | Verified domains | `org:admin` | `{ domain }` → `201 { id, domain, status: "pending", verification: { type: "dns_txt", name, value } }` | `409 CONFLICT` (claimed by another org) |
| `POST /v1/organizations/{orgId}/domains/{domainId}:verify` | Check DNS TXT | `org:admin` | → `200 Domain` (`verified`) | `422 INVALID_REQUEST` (record not found) |
| `DELETE /v1/organizations/{orgId}/domains/{domainId}` | Remove domain | `org:admin` | → `204` | `409 CONFLICT` (SSO enforced on domain) |
| `GET/PATCH /v1/organizations/{orgId}/policies` | Enterprise policies | `org:admin` | JSON merge patch on `OrgPolicies` → `200` | `403 PLAN_LIMIT_EXCEEDED` (Enterprise-only keys) |
| `GET/PUT /v1/organizations/{orgId}/sso` | SSO connection config | `org:admin` | `{ protocol: "saml"\|"oidc", metadataXml? \| metadataUrl? \| oidc: { issuer, clientId, clientSecret }, enforce: bool, jitProvisioning: bool, defaultRole }` → `200 SsoConnection` (SP entity ID, ACS URL) | `422 INVALID_REQUEST` (metadata parse) |
| `POST /v1/organizations/{orgId}/sso:test` | Test SSO login | `org:admin` (session) | → `200 { redirectUrl }` | |
| `GET /v1/organizations/{orgId}/scim` | SCIM endpoint info | `org:admin` | → `200 { baseUrl: "https://api.tabula.example/scim/v2/{orgId}", tokenPrefix, lastSyncAt, userCount, groupCount }` | |
| `POST /v1/organizations/{orgId}/scim:rotate-token` | Rotate SCIM bearer | `org:admin` + step-up | → `200 { token }` (once) | |
| `GET/POST /v1/organizations/{orgId}/service-accounts` (+ `/{svcId}`, `/{svcId}/tokens`) | Service accounts & tokens | `org:admin` | `{ name, description }` → `201 ServiceAccount`; tokens like PATs | `403 PLAN_LIMIT_EXCEEDED` |
| `GET /v1/organizations/{orgId}/oauth-apps` (+ approve/block) | OAuth app allow-list | `org:admin` | `PATCH { appId, status: "approved"\|"blocked" }` | |
| `GET /v1/organizations/{orgId}/usage` | Usage counters vs plan | `org:admin` or `org.billing` | → `200 { period, metrics: { records, storageBytes, automationRuns, aiCredits, apiCalls } }` | |
| `POST /v1/organizations/{orgId}/audit-exports` | Configure audit SIEM export / one-off export | `audit:read` · `audit.read` (Enterprise) | see §23 | |

```yaml
OrgPolicies:
  properties:
    sharing: { properties: { publicLinks: { enum: [allowed, password_required, disabled] }, externalInvites: { enum: [allowed, verified_domains_only, disabled] }, allowedEmailDomains: { type: array } } }
    authentication: { properties: { ssoRequired: { type: boolean }, mfaRequired: { type: boolean }, sessionMaxAgeHours: { type: integer }, ipAllowList: { type: array } } }
    api: { properties: { patMaxLifetimeDays: { type: integer }, allowPatsForGuests: { type: boolean }, oauthAppPolicy: { enum: [any, approved_only] } } }
    ai: { properties: { enabled: { type: boolean }, allowedModels: { type: array }, dataRetention: { enum: [none, provider_default] } } }
    retention: { properties: { revisionHistoryDays: { type: integer }, trashDays: { type: integer, maximum: 180 }, auditYears: { type: integer, maximum: 7 } } }
    exports: { properties: { allowedRoles: { type: array }, disableCsvForGuests: { type: boolean } } }
```

---

## 7. Tag: Workspaces

| Method & path | Summary | Scope · Permission | Request → Response | Extra errors |
|---|---|---|---|---|
| `GET /v1/workspaces` | Workspaces visible to principal | `workspaces:read` | query `orgId` → `CursorPage<Workspace>` | |
| `POST /v1/workspaces` | Create workspace (shard assigned by placement service) | `workspaces:write` · org member (policy may restrict) | `{ orgId, name }` → `201 Workspace` | `403 PLAN_LIMIT_EXCEEDED` |
| `GET/PATCH /v1/workspaces/{workspaceId}` | Get / rename | `workspaces:read` / `workspaces:write` · `workspace.manage` | → `200 Workspace` | |
| `DELETE /v1/workspaces/{workspaceId}` | Soft delete (trash, 30 d) | `workspaces:write` · workspace `owner` | → `200 DeletedResource` | `409 CONFLICT` (contains bases with legal hold) |
| `POST /v1/workspaces/{workspaceId}:restore` | Restore | owner | → `200 Workspace` | |
| `GET /v1/workspaces/{workspaceId}/bases` | Bases in workspace | `schema:read` | → `CursorPage<BaseSummary>` (only accessible bases) | |
| `GET /v1/workspaces/{workspaceId}/members` | Grants at workspace level (+ effective via `?effective=true`) | `workspaces:read` | → `CursorPage<Grant>` | |
| `PUT /v1/workspaces/{workspaceId}/members/{principalType}/{principalId}` | Upsert grant | `workspaces:write` · `workspace.manage` | `{ role: owner\|creator\|editor\|commenter\|viewer }` → `200 Grant` | `403 ORG_POLICY_VIOLATION` (guest as owner), `409 CONFLICT` (last owner) |
| `DELETE /v1/workspaces/{workspaceId}/members/{principalType}/{principalId}` | Remove grant | as above | → `204` | `409 CONFLICT` (last owner) |
| `GET/POST /v1/workspaces/{workspaceId}/invitations` | List / create invitations | `workspaces:write` | `{ email, role, message? }` → `201 Invitation` | `403 ORG_POLICY_VIOLATION` (domain), `409 CONFLICT` (already member) |
| `DELETE /v1/workspaces/{workspaceId}/invitations/{invitationId}` | Revoke | as above | → `204` | |
| `POST /v1/invitations/{token}:accept` | Accept any invitation (org/workspace/base/interface) | session | → `200 { resourceType, resourceId }` | `401 TOKEN_EXPIRED`, `403 ORG_POLICY_VIOLATION` (email mismatch) |
| `POST /v1/workspaces/{workspaceId}:move` | Move workspace to another org (admin) | `org:admin` both orgs | → `202 LongOperation` | |

---

## 8. Tag: Bases

| Method & path | Summary | Scope · Permission | Request → Response | Extra errors |
|---|---|---|---|---|
| `GET /v1/bases` | All accessible bases (across workspaces) | `schema:read` | query `workspaceId?`, `q?` → `CursorPage<BaseSummary>` (from `base_directory` + grants) | |
| `POST /v1/bases` | Create base (empty / from template / with tables) | `schema:write` · `workspace.create_base` | `{ workspaceId, name, icon?, color?, templateId?, tables?: [TableCreate] }` → `201 Base` (or `202` when `templateId`) | `403 PLAN_LIMIT_EXCEEDED` |
| `GET /v1/bases/{baseId}` | Base metadata | `schema:read` · `base.read` | → `200 Base` (`role` of caller, `schemaVersion`, `changeSeq`) | |
| `PATCH /v1/bases/{baseId}` | Rename, icon, settings | `schema:write` · `base.manage_schema` | `{ name?, icon?, color?, settings?: { requireIfMatchForApiWrites?, … } }` → `200 Base` | |
| `DELETE /v1/bases/{baseId}` | Soft delete | `schema:write` · base `creator` + workspace `creator` | → `200 DeletedResource` | |
| `POST /v1/bases/{baseId}:restore` | Restore from trash | same | → `200 Base` | `404 BASE_NOT_FOUND` (already purged) |
| `POST /v1/bases/{baseId}:duplicate` | Duplicate | `schema:write` · `base.read` + target `workspace.create_base` | `{ targetWorkspaceId, name, include: { records: bool, comments: bool, automations: bool, interfaces: bool } }` → `202 LongOperation` (`result.baseId`) | `403 PLAN_LIMIT_EXCEEDED` |
| `GET /v1/bases/{baseId}/schema` | Full schema snapshot (tables, fields, views, link relations) | `schema:read` | query `include=views,interfaces` → `200 BaseSchema` + `ETag: "s412"`; supports `If-None-Match` → `304` | |
| `GET /v1/bases/{baseId}/openapi.json` | Per-base OpenAPI | `schema:read` | → `200 application/openapi+json` | |
| `GET /v1/bases/{baseId}/changes` | Masked change feed | `records:read` and/or `schema:read` | query `sinceSeq` (required), `tableIds[]`, `dataTypes[]`, `limit ≤ 500` → `200 { changes: [ChangePayload], cursor, mightHaveMore }` | `410 CURSOR_EXPIRED` |
| `GET /v1/bases/{baseId}/members` | Base-level grants (+ `?effective=true` incl. inherited) | `schema:read` · `base.read` | → `CursorPage<Grant>` | |
| `PUT /v1/bases/{baseId}/members/{principalType}/{principalId}` | Upsert base grant | `bases:manage` · `base.manage_members` | `{ role: creator\|editor\|commenter\|viewer\|interface_only }` → `200 Grant` | `403 ORG_POLICY_VIOLATION`, `403 PERMISSION_DENIED` (cannot grant above own role) |
| `DELETE /v1/bases/{baseId}/members/{principalType}/{principalId}` | Remove | same | → `204` | |
| `POST /v1/bases/{baseId}/invitations` | Invite by email to base | `bases:manage` | `{ email, role }` → `201 Invitation` | as workspace |
| `GET /v1/bases/{baseId}/snapshots` | List snapshots | `bases:manage` · `base.manage_schema` | → `CursorPage<Snapshot>` | |
| `POST /v1/bases/{baseId}/snapshots` | Create manual snapshot | same | `{ label? }` → `202 LongOperation` (`result.snapshotId`) | `403 PLAN_LIMIT_EXCEEDED` |
| `POST /v1/bases/{baseId}/snapshots/{snapshotId}:restore` | Restore **as new base** (default) or in place (Enterprise) | same + workspace `creator` | `{ mode: "new_base"\|"in_place", targetWorkspaceId? }` → `202 LongOperation` | `503 BASE_UNAVAILABLE` during in-place restore |
| `GET /v1/bases/{baseId}/trash` | Trash entries (deletion batches) | `bases:manage` · (records: `record.delete`; schema: `base.manage_schema`) | query `kind=records\|table\|field\|view\|interface\|automation` → `CursorPage<TrashEntry>` | |
| `POST /v1/bases/{baseId}/trash/{deletionBatchId}:restore` | Restore a deletion batch | per kind | → `200 { restored: { records: 120, fields: 0 } }` | `409 CONFLICT` (name clash → auto-suffixed, reported) |
| `DELETE /v1/bases/{baseId}/trash/{deletionBatchId}` | Purge early (admin) | base `creator` + step-up | → `204` | |
| `GET /v1/bases/{baseId}/share-links` | List share links | `bases:manage` · `base.share` | → `CursorPage<ShareLink>` | |
| `POST /v1/bases/{baseId}/share-links` | Create share link | `bases:manage` · `base.share` (+ org policy) | `ShareLinkCreate` (§20 `20-…`) → `201 ShareLink & { url }` | `403 ORG_POLICY_VIOLATION` |
| `PATCH /v1/bases/{baseId}/share-links/{shareId}` | Update (password, expiry, domains, embed) | same | → `200 ShareLink` | |
| `DELETE /v1/bases/{baseId}/share-links/{shareId}` | Revoke | same | → `204` | |
| `POST /v1/bases/{baseId}/share-links/{shareId}:regenerate` | New token, old invalid | same | → `200 ShareLink & { url }` | |
| `GET /v1/bases/{baseId}/activity` | Base activity feed (UI) | session · `base.read` | → `CursorPage<ActivityItem>` | |

```yaml
BaseSchema:
  properties:
    object: { const: base_schema }
    baseId: { $ref: BaseId }
    schemaVersion: { type: integer }
    tables: { type: array, items: { $ref: Table } }       # with fields + view summaries
    linkRelations:
      type: array
      items: { properties: { id: { type: string }, a: { properties: { tableId: {}, fieldId: {} } }, b: { properties: { tableId: {}, fieldId: {} } }, cardinality: { enum: [one_to_one, one_to_many, many_to_many] } } }
ShareLink:
  properties:
    object: { const: share_link }
    id: { type: string, pattern: '^shr_' }
    targetType: { enum: [base, view, interface, form] }
    targetId: { type: string }
    access: { enum: [public, password, email_domain, email_list] }
    tokenPrefix: { type: string, description: first 6 chars, for identification }
    allowCopy: { type: boolean }
    allowDownloadCsv: { type: boolean }
    showAttachments: { type: boolean }
    allowedEmailDomains: { type: array }
    allowedEmails: { type: array }
    embed: { properties: { enabled: { type: boolean }, frameAncestors: { type: array, items: { type: string } } } }
    expiresAt: { type: [string, 'null'] }
    status: { enum: [active, expired, revoked] }
    stats: { properties: { views30d: { type: integer }, lastAccessedAt: { type: [string, 'null'] } } }
    createdBy: { type: string }
    createdAt: { type: string }
```

---

## 9. Tag: Tables

| Method & path | Summary | Scope · Permission | Request → Response | Extra errors |
|---|---|---|---|---|
| `GET /v1/bases/{baseId}/tables` | List tables | `schema:read` | query `include=fields,views` → `CursorPage<Table>` (non-paginated in practice: ≤ 500) | |
| `POST /v1/bases/{baseId}/tables` | Create table (with initial fields; first = primary) | `schema:write` · `table.create` | `{ name, description?, fields: [FieldCreate] (≥1, ≤ 500) }` → `201 Table` | `409 CONFLICT` (name), `403 PLAN_LIMIT_EXCEEDED` (tables/base), `422 FIELD_VALIDATION_FAILED` (config) |
| `GET /v1/bases/{baseId}/tables/{tableId}` | Get table | `schema:read` | → `200 Table` + `ETag` | |
| `PATCH /v1/bases/{baseId}/tables/{tableId}` | Rename, description, primary field, restrictions, order | `schema:write` · `table.update` (restrictions: `base.manage_schema`) | `{ name?, description?, primaryFieldId?, restrictions?, order? }` → `200 Table` | `409 CONFLICT`, `422 SCHEMA_CONSTRAINT_VIOLATION` (primary field type not allowed) |
| `DELETE /v1/bases/{baseId}/tables/{tableId}` | Soft delete (also inverse link fields in other tables become "broken" & hidden until restore) | `schema:write` · `table.delete` | → `200 DeletedResource` | `422 SCHEMA_CONSTRAINT_VIOLATION` (last table) |
| `POST /v1/bases/{baseId}/tables/{tableId}:restore` | Restore | same | → `200 Table` | |
| `POST /v1/bases/{baseId}/tables/{tableId}:duplicate` | Duplicate (structure ± records) | `schema:write` · `table.create` | `{ name, includeRecords: bool, includeViews: bool }` → `202 LongOperation` | `403 PLAN_LIMIT_EXCEEDED` |

---

## 10. Tag: Fields

| Method & path | Summary | Scope · Permission | Request → Response | Extra errors |
|---|---|---|---|---|
| `GET /v1/bases/{baseId}/tables/{tableId}/fields` | List | `schema:read` | → `CursorPage<Field>` (respects hidden fields) | |
| `POST /v1/bases/{baseId}/tables/{tableId}/fields` | Create | `schema:write` · `field.create` | `FieldCreate { name, type, config, description?, order? }` → `201 Field` (formula/lookup/rollup: `202` if backfill > `COMPUTE_SYNC_FANOUT_LIMIT` × 20 records) | `409 CONFLICT`, `422 INVALID_FORMULA`, `422 SCHEMA_CONSTRAINT_VIOLATION` (cycle, depth > 32), `403 PLAN_LIMIT_EXCEEDED` (500 fields) |
| `GET /v1/bases/{baseId}/tables/{tableId}/fields/{fieldId}` | Get | `schema:read` | → `200 Field` | |
| `PATCH /v1/bases/{baseId}/tables/{tableId}/fields/{fieldId}` | Update name/description/config; **type change → 202** | `schema:write` · `field.update` | `{ name?, description?, config?, type? , conversion?: { dateFormat?, splitDelimiter?, createMissingOptions? } }` → `200 Field` or `202 LongOperation` (kind `field.type_change`) | `422 FIELD_TYPE_CHANGE_UNSUPPORTED`, `422 INVALID_FORMULA`, `412 VERSION_CONFLICT` (`If-Match: "s…"`) |
| `POST /v1/bases/{baseId}/tables/{tableId}/fields/{fieldId}:preview-conversion` | Dry-run type change on sample (first 100 records) | `schema:write` | `{ type, config, conversion? }` → `200 { samples: [{ recordId, before, after, lossy: bool }], estimatedLossyCount }` | |
| `DELETE /v1/bases/{baseId}/tables/{tableId}/fields/{fieldId}` | Soft delete | `schema:write` · `field.delete` | query `force=true` to also break dependents → `200 DeletedResource & { brokenDependents: [fieldId] }` | `422 SCHEMA_CONSTRAINT_VIOLATION` (primary field; dependents without `force`) |
| `POST /v1/bases/{baseId}/tables/{tableId}/fields/{fieldId}:restore` | Restore | same | → `200 Field` | |
| `PATCH /v1/bases/{baseId}/tables/{tableId}/fields/{fieldId}/options` | Batch edit select options (add/rename/recolor/reorder/delete) | `schema:write` · `field.update` | `{ add: [{name,color}], update: [{id,name?,color?}], delete: [optId], order: [optId] }` → `200 Field` | |
| `POST /v1/bases/{baseId}/formula:validate` | Validate formula (used by UI and tools) | `schema:read` | `{ tableId, formula }` → `200 { valid, resultType, referencedFieldIds, errors: [{ start, end, message, code }] }` | |

Example — type change accepted asynchronously:

```http
PATCH /v1/bases/bas_…/tables/tbl_…/fields/fld_Stage…
If-Match: "s412"
Idempotency-Key: 6c1b…

{ "type": "single_select", "conversion": { "createMissingOptions": true } }
```
```http
HTTP/1.1 202 Accepted
Location: /v1/bases/bas_…/long-operations/lop_…

{ "object": "long_operation", "id": "lop_…", "kind": "field.type_change", "status": "queued",
  "progress": { "completed": 0, "total": 52310, "unit": "records" }, "cancellable": true }
```

---

## 11. Tag: Records

Base path: `/v1/bases/{baseId}/tables/{tableId}`. Common query params on reads: `cellFormat`, `fieldKey`, `timeZone`, `locale`. On writes: `typecast`, `fieldKey`, `returnRecord` (default `true`; `false` → `204` for throughput).

| Method & path | Summary | Scope · Permission | Request → Response | Extra errors |
|---|---|---|---|---|
| `GET …/records` | List (Tier A, `17-…` §17.2) | `records:read` · `record.read` | query `fields`, `filter` (compact), `sort`, `viewId`, `recordIds`, `pageSize`, `cursor`, `includeDeleted` → `RecordPage` | `422 INVALID_FILTER`, `422 INVALID_SORT`, `400 INVALID_CURSOR`, `410 CURSOR_EXPIRED`, `504 QUERY_TIMEOUT` |
| `POST …/records:query` | Canonical query (Tier B) — safe, `no-idem` | `records:read` · `record.read` (+ target table read for `includes`) | `RecordQuery` → `RecordQueryResult` | + `422 QUERY_TOO_COMPLEX`, `429 CONCURRENCY_LIMITED` |
| `GET …/records/{recordId}` | Get one | `records:read` | query `fields`, `includeDeleted` → `200 Record` + `ETag: "r17"`; `If-None-Match` → `304` | |
| `POST …/records` | Create one | `records:write` · `record.create` (+ `tables.restrictions.recordCreate`) | `{ values }` → `201 Record` + `Location` | `422 FIELD_VALIDATION_FAILED`, `403 FIELD_NOT_EDITABLE`, `403 PLAN_LIMIT_EXCEEDED` (records/base), `409 ATTACHMENT_NOT_READY` |
| `PATCH …/records/{recordId}` | Merge update (only given cells) | `records:write` · `record.update` | `{ values }` + optional `If-Match` → `200 Record` | `412 VERSION_CONFLICT`, `428 PRECONDITION_REQUIRED` |
| `PUT …/records/{recordId}` | Replace (unspecified writable cells cleared; computed ignored) | `records:write` · `record.update` | `{ values }` (+ `If-Match` recommended) → `200 Record` | same |
| `DELETE …/records/{recordId}` | Soft delete (trash 30 d) | `records:write` · `record.delete` (+ `recordDelete` restriction) | → `200 DeletedResource` | |
| `POST …/records/{recordId}:restore` | Restore | `records:write` · `record.delete` | → `200 Record` | `404 RECORD_NOT_FOUND` (purged) |
| `POST …/records:batch` | Batch create/update/replace/upsert/delete (≤ 1000; `async` ≤ 10,000) | `records:write` · per-op actions | `RecordBatchRequest` → `200 RecordBatchResult` (atomic: all results; non-atomic: per-item) or `202 LongOperation` | `413 BATCH_TOO_LARGE`, `422 BATCH_VALIDATION_FAILED`, `422 DUPLICATE_RECORD_IN_BATCH`, `429 RATE_LIMITED` (`records_written`) |
| `POST …/records:delete-by-filter` | Bulk delete matching a filter (soft, one deletion batch) | `records:write` · `record.delete` | `{ filter: FilterNode, viewId?, expectedCount?: int }` → `202 LongOperation` (`result: { deleted, deletionBatchId }`) | `409 CONFLICT` (actual count deviates from `expectedCount` by > 1% — safety rail) |
| `GET …/records/{recordId}/history` | Cell-level revision history | `records:read` · `record.read` (per plan retention) | query `fieldIds[]`, `before`, `pageSize` → `CursorPage<RecordRevision>` | |
| `POST …/records/{recordId}/links/{fieldId}` | Add links (set semantics, idempotent) | `records:write` · `record.update` on both sides | `{ recordIds: [rec_…] (≤ 1000), position?: { before?: rec_… } }` → `200 { fieldId, added: n, linkCount }` | `422 FIELD_VALIDATION_FAILED` (`NOT_ALLOWED_MULTIPLE`, `INVALID_RECORD_REFERENCE`) |
| `DELETE …/records/{recordId}/links/{fieldId}` | Remove links | same | `{ recordIds: [...] }` (body on DELETE allowed) or query `recordIds=` → `200 { removed: n, linkCount }` | |
| `GET …/records/{recordId}/links/{fieldId}` | Paginate linked records (large link sets) | `records:read` | query `fields`, `pageSize`, `cursor` → `RecordPage` | |
| `GET …/records/{recordId}/comments` | (see Comments) | | | |
| `POST …/records/{recordId}/fields/{fieldId}:generate` | Run/rerun AI field for a record | `ai:use` + `records:write` | → `202 { status: "pending", invocationId: "aij_…" }` | `429 QUOTA_EXCEEDED` (AI credits), `403 ORG_POLICY_VIOLATION` (AI disabled) |
| `POST …/records/{recordId}/buttons/{fieldId}:click` | Trigger button action (automation/script) | `records:write` · `automation.run` | → `202 { runId? , url? }` | |

### 11.1 Schemas

```yaml
RecordWrite:
  type: object
  required: [values]
  properties:
    values: { type: object, additionalProperties: { $ref: CellInput } }
CellInput:
  description: >
    JSON-format value. Selects accept opt_ id, {id} or exact name (typecast: any name → created).
    Links accept [rec_…] or [{id}]. Collaborators accept usr_…, {id}, {email}. Attachments accept
    [{id: att_…}] or [{url, filename?}]. null or "" clears the cell.
RecordBatchRequest:
  type: object
  required: [operations]
  properties:
    atomic: { type: boolean, default: true }
    typecast: { type: boolean, default: false }
    async: { type: boolean, default: false }
    operations:
      type: array
      minItems: 1
      maxItems: 1000          # 10000 when async
      items:
        oneOf:
          - { properties: { op: { const: create }, clientRef: { type: string, maxLength: 64 }, values: {} }, required: [op, values] }
          - { properties: { op: { const: update }, id: { $ref: RecordId }, ifMatchVersion: { type: integer }, values: {} }, required: [op, id, values] }
          - { properties: { op: { const: replace }, id: { $ref: RecordId }, ifMatchVersion: { type: integer }, values: {} }, required: [op, id, values] }
          - { properties: { op: { const: upsert }, matchOn: { type: array, minItems: 1, maxItems: 3 }, clientRef: {}, values: {} }, required: [op, matchOn, values] }
          - { properties: { op: { const: delete }, id: { $ref: RecordId } }, required: [op, id] }
        discriminator: { propertyName: op }
RecordBatchResult:
  properties:
    object: { const: batch_result }
    atomic: { type: boolean }
    results:
      type: array
      items:
        properties:
          index: { type: integer }
          clientRef: { type: string }
          status: { type: integer }
          upsertResult: { enum: [created, updated] }
          record: { $ref: Record }
          deleted: { type: boolean }
          id: { type: string }
          error: { $ref: Problem }
    summary: { properties: { succeeded: { type: integer }, failed: { type: integer } } }
RecordQuery:
  type: object
  properties:
    viewId: { $ref: ViewId }
    filter: { $ref: FilterNode }
    sort: { type: array, maxItems: 10, items: { $ref: SortSpec } }
    fields: { type: array, items: { type: string } }
    search: { properties: { query: { type: string, maxLength: 256 }, fieldIds: { type: array }, mode: { enum: [prefix, substring, fulltext] } } }
    includes:
      type: array
      maxItems: 5
      items: { properties: { fieldId: { type: string }, fields: { type: array }, limit: { type: integer, maximum: 100, default: 20 } }, required: [fieldId] }
    aggregations:
      type: array
      maxItems: 20
      items:
        required: [id, function]
        properties:
          id: { type: string, pattern: '^[A-Za-z][A-Za-z0-9_]{0,63}$' }
          function: { enum: [count, count_empty, count_filled, count_distinct, sum, avg, min, max, median, percent_filled] }
          fieldId: { type: string }
          groupBy: { type: array, maxItems: 3, items: { oneOf: [ { type: string }, { properties: { fieldId: {}, granularity: { enum: [day, week, month, quarter, year] } } } ] } }
    aggregationsOnly: { type: boolean, default: false }
    asyncIfSlow: { type: boolean, default: false }
    pageSize: { type: integer, maximum: 1000, default: 100 }
    cursor: { type: [string, 'null'] }
    cellFormat: { enum: [json, string] }
    fieldKey: { enum: [id, name] }
    timeZone: { type: string }
    locale: { type: string }
    includeDeleted: { type: boolean }
RecordQueryResult:
  allOf:
    - $ref: CursorPage
    - properties:
        data: { items: { $ref: Record } }
        included: { type: object, additionalProperties: { $ref: Record } }
        aggregations: { type: object, additionalProperties: { $ref: AggregationResult } }
AggregationResult:
  properties:
    function: { type: string }
    fieldId: { type: string }
    value: { description: number, decimal string (currency), or ISO date (min/max of dates) }
    groupBy: { type: array }
    groups: { type: array, items: { properties: { key: { type: array }, value: {}, count: { type: integer } } } }
    truncated: { type: boolean }
RecordRevision:
  properties:
    object: { const: record_revision }
    id: { type: string, pattern: '^rev_' }
    at: { $ref: Timestamp }
    actor: { $ref: ActorRef }
    changes: { type: array, items: { properties: { fieldId: {}, before: {}, after: {} } } }
    changeId: { type: string, pattern: '^chg_' }
```

### 11.2 Example — create with typecast

```http
POST /v1/bases/bas_…/tables/tbl_Deals…/records?typecast=true&locale=en-US
Authorization: Bearer tpat_…
Idempotency-Key: 0192a703-…
Content-Type: application/json

{ "values": { "fld_Name…": "Acme renewal", "fld_Amount…": "$12,500", "fld_Stage…": "Negotiation",
              "fld_Owner…": { "email": "dana@example.com" }, "fld_Company…": ["rec_9Pq…"] } }
```
```http
HTTP/1.1 201 Created
Location: /v1/bases/bas_…/tables/tbl_Deals…/records/rec_6Wd…
ETag: "r1"

{ "object": "record", "id": "rec_6Wd…", "version": 1, "createdAt": "…", "updatedAt": "…",
  "values": { "fld_Name…": "Acme renewal", "fld_Amount…": "12500.00",
              "fld_Stage…": { "id": "opt_new…", "name": "Negotiation", "color": "gray" },
              "fld_Owner…": { "id": "usr_2bF…", "name": "Dana Ruiz" },
              "fld_Company…": [ { "id": "rec_9Pq…", "displayValue": "Acme Holdings" } ] } }
```

---

## 12. Tag: Views

Base path: `/v1/bases/{baseId}/tables/{tableId}/views` (and `/v1/bases/{baseId}/views/{viewId}` shortcut for get/records since view IDs are base-unique).

| Method & path | Summary | Scope · Permission | Request → Response | Extra errors |
|---|---|---|---|---|
| `GET …/views` | List views (collaborative + own personal) | `schema:read` · `view.read` | → `CursorPage<ViewSummary>` | |
| `POST …/views` | Create | `schema:write` · `view.create_collaborative` or `view.create_personal` | `{ name, type, visibility: "collaborative" or "personal", config?, sectionId?, copyFromViewId? }` → `201 View` | `409 CONFLICT` |
| `GET /v1/bases/{baseId}/views/{viewId}` | Get with config | `schema:read` | → `200 View` + `ETag: "v…"` | |
| `PATCH /v1/bases/{baseId}/views/{viewId}` | Rename / move section / visibility (lock) | `schema:write` · `view.update` (`view.lock` for locking) | `{ name?, sectionId?, visibility?, order? }` → `200 View` | `403 VIEW_LOCKED` |
| `PATCH /v1/bases/{baseId}/views/{viewId}/config` | **Config patch** (JSON Merge Patch, RFC 7396; arrays replaced) | `schema:write` · `view.update` | `{ filter?, sort?, groupBy?, fields?, rowHeight?, colorRules?, … }` + `If-Match: "v…"` → `200 View` | `403 VIEW_LOCKED`, `412 VERSION_CONFLICT`, `422 INVALID_FILTER`, `422 INVALID_SORT` |
| `DELETE /v1/bases/{baseId}/views/{viewId}` | Soft delete | `schema:write` · `view.update` | → `200 DeletedResource` | `422 SCHEMA_CONSTRAINT_VIOLATION` (last view of table) |
| `POST /v1/bases/{baseId}/views/{viewId}:restore` / `:duplicate` | Restore / duplicate | same | → `200`/`201 View` | |
| `GET /v1/bases/{baseId}/views/{viewId}/records` | Records via view (Tier A with view inheritance) | `records:read` · `view.read` + `record.read` | query `fields`, `filter` (ANDed), `sort` (replaces), `pageSize`, `cursor`, `cellFormat` → `RecordPage` | as records list |
| `POST /v1/bases/{baseId}/views/{viewId}/records:query` | Tier B pinned to view | same | `RecordQuery` (no `viewId`) → `RecordQueryResult` | |
| `GET /v1/bases/{baseId}/views/{viewId}/state` | Personal state (column widths, collapsed groups, scroll, hidden fields for personal override) | session/any · `view.read` | → `200 ViewUserState` | |
| `PUT /v1/bases/{baseId}/views/{viewId}/state` | Replace personal state | session/any | `ViewUserState` → `200` (`no-idem` — last write wins) | |
| `GET/POST/PATCH/DELETE /v1/bases/{baseId}/view-sections[/{sectionId}]` | Sidebar folders | `schema:write` · `view.update` | `{ name, order }` | |

---

## 13. Tag: Forms

Forms are views of `type: "form"`; config holds the field list, labels, help text, required flags, conditions, redirect, and branding. Public submission uses a **share link token** (§8 share links; `20-…`).

| Method & path | Summary | Auth | Request → Response | Extra errors |
|---|---|---|---|---|
| `GET /v1/forms/{shareToken}` | Public form schema (projection only — never field IDs of hidden fields, no record data) | public (share token) / password cookie | → `200 PublicForm { title, description, fields: [{ key: "f1", fieldId?, type, label, help, required, options?, validation, conditions }], branding, requiresCaptcha: bool, submitLimit }` | `404 NOT_FOUND` (revoked/expired → generic), `401 UNAUTHENTICATED` (password/email gate: `gate: "password"\|"email"`) |
| `POST /v1/forms/{shareToken}/submissions` | Submit | public; rate-limited per IP + share; CAPTCHA/Turnstile token when risk score high | `{ values: { f1: …, f2: … }, attachments: [{ key, uploadId }], captchaToken?, prefillSignature? }` → `201 { submissionId, recordId? (only if form config exposes), redirectUrl?, message }` | `422 FIELD_VALIDATION_FAILED`, `429 RATE_LIMITED`, `403 ORG_POLICY_VIOLATION` (form closed) |
| `POST /v1/forms/{shareToken}/uploads` | Upload init for form attachments (size/type limits per form) | public | `{ filename, size, mimeType }` → `200 { uploadId, url, fields, expiresAt }` (presigned POST to quarantine) | `413 PAYLOAD_TOO_LARGE` |
| `POST /v1/bases/{baseId}/views/{viewId}/form:submit` | Authenticated submission (internal forms; records created as user) | `records:write` · `record.create` | `{ values }` → `201 Record` | |
| `GET /v1/bases/{baseId}/views/{viewId}/form` | Form designer config | `schema:read` | → `200 View` | |

Public forms use **form-local keys** (`f1…fn`) instead of field IDs so the public schema does not disclose base structure; the mapping lives in the form view config. Prefill: `?prefill_f2=…` values are untrusted; "hidden prefilled" fields require an HMAC `prefillSignature` generated by the base owner (prevents spoofing of hidden fields like `source=partner`).

---

## 14. Tag: Interfaces

| Method & path | Summary | Scope · Permission | Request → Response | Extra errors |
|---|---|---|---|---|
| `GET /v1/bases/{baseId}/interfaces` | List interfaces (interface-only users see granted ones) | `interfaces:read` · `interface.read` | → `CursorPage<InterfaceSummary>` | |
| `POST /v1/bases/{baseId}/interfaces` | Create | `interfaces:write` · `interface.edit` (base creator/editor per policy) | `{ name, icon?, templateKey? }` → `201 Interface` | |
| `GET/PATCH/DELETE /v1/bases/{baseId}/interfaces/{interfaceId}` | Get (draft + published pointers) / rename, theme, nav / delete | `interfaces:read` / `interfaces:write` | → `200 Interface` (`ETag: "i…"`) | `412 VERSION_CONFLICT` |
| `GET/POST /v1/bases/{baseId}/interfaces/{interfaceId}/pages` | List / create pages | as above | `{ name, type: "dashboard"\|"record_list"\|"record_detail"\|"form"\|"blank", order }` → `201 Page` | |
| `GET/PATCH/DELETE /v1/bases/{baseId}/interfaces/{interfaceId}/pages/{pageId}` | Page CRUD; layout (element tree) update with `If-Match` | `interfaces:write` · `interface.edit` | `{ layout: ElementTree }` → `200 Page` | `422 INVALID_REQUEST` (element schema), `412` |
| `POST /v1/bases/{baseId}/interfaces/{interfaceId}:publish` | Publish draft → immutable `interface_versions` row | `interfaces:write` · `interface.publish` | `{ message? }` → `200 { versionId, publishedAt }` (or `202` for large) | `409 CONFLICT` (publish in progress), `422 SCHEMA_CONSTRAINT_VIOLATION` (element references deleted field) |
| `GET /v1/bases/{baseId}/interfaces/{interfaceId}/versions` (+ `:revert`) | Version list / revert draft to version | as above | | |
| `GET /v1/bases/{baseId}/interfaces/{interfaceId}/members` / `PUT …/members/{principalType}/{principalId}` | Interface grants (`interface_editor`, `interface_user`) | `bases:manage` · `base.manage_members` | `{ role }` → `200 Grant` | |
| `POST /v1/bases/{baseId}/interfaces/{interfaceId}/pages/{pageId}/elements/{elementId}:query` | **Element data query** (published version unless `?draft=true` for editors) | `records:read` · `interface.read` | `RecordQuery` minus `viewId` (narrowing only) → `RecordQueryResult`; record scoping & element filters enforced server-side | `422 QUERY_TOO_COMPLEX` |
| `POST /v1/bases/{baseId}/interfaces/{interfaceId}/pages/{pageId}/elements/{elementId}/records` | Create via element (if element allows) | `records:write` · element permission | `{ values }` (only element-editable fields) → `201 Record` | `403 FIELD_NOT_EDITABLE` |
| `PATCH /v1/bases/{baseId}/interfaces/{interfaceId}/pages/{pageId}/elements/{elementId}/records/{recordId}` | Edit via element | `records:write` · element permission + record in scope | → `200 Record` | `404 RECORD_NOT_FOUND` (out of scope) |

Element endpoints exist because interface-only users have **no table-level access**; the element's published config is the permission boundary (`19-…`).

---

## 15. Tag: Automations

| Method & path | Summary | Scope · Permission | Request → Response | Extra errors |
|---|---|---|---|---|
| `GET /v1/bases/{baseId}/automations` | List | `automations:read` · `automation.read` | query `status` → `CursorPage<AutomationSummary>` | |
| `POST /v1/bases/{baseId}/automations` | Create (draft) | `automations:write` · `automation.edit` | `{ name, description?, trigger: TriggerConfig, steps: [StepConfig] }` → `201 Automation` | `422 INVALID_REQUEST` (step schema per action type) |
| `GET /v1/bases/{baseId}/automations/{automationId}` | Get (draft + published version) | `automations:read` | → `200 Automation` + `ETag: "a…"` | |
| `PATCH /v1/bases/{baseId}/automations/{automationId}` | Update draft (`If-Match`) | `automations:write` · `automation.edit` | `{ name?, trigger?, steps?, settings?: { runOnImports, maxRunsPerHour, errorNotification } }` → `200 Automation` | `412 VERSION_CONFLICT` |
| `DELETE /v1/bases/{baseId}/automations/{automationId}` | Soft delete | same | → `200 DeletedResource` | |
| `POST /v1/bases/{baseId}/automations/{automationId}:publish` | Validate + publish draft as `automation_versions` row | `automations:write` · `automation.edit` | `{ enable: true }` → `200 { versionId: "atv_…", status: "enabled" }` | `422 INVALID_REQUEST` (`errors[]` per step: missing connection, bad field ref), `403 PLAN_LIMIT_EXCEEDED` |
| `POST /v1/bases/{baseId}/automations/{automationId}:enable` / `:disable` | Toggle published automation | `automations:write` | → `200 Automation` | `409 CONFLICT` (no published version) |
| `POST /v1/bases/{baseId}/automations/{automationId}:test` | Test run of draft (trigger sample: a record id or sample payload); side-effects **real** unless step supports dry-run, flagged in response | `automations:write` · `automation.run` | `{ triggerSample: { recordId? , payload? }, stepIds?: [], dryRun: true }` → `200 { runId, steps: [{ stepId, status, input, output, error }] }` (sync ≤ 30 s else `202`) | `429 QUOTA_EXCEEDED` |
| `GET /v1/bases/{baseId}/automations/{automationId}/runs` | Run history | `automations:read` | query `status`, `from`, `to` → `CursorPage<AutomationRunSummary>` | |
| `GET /v1/bases/{baseId}/automations/{automationId}/runs/{runId}` | Run detail incl. step runs (inputs/outputs redacted for secrets) | `automations:read` | → `200 AutomationRun { id, status, trigger: { eventId, type, recordId? }, startedAt, finishedAt, steps: [StepRun] , causationDepth }` | |
| `POST /v1/bases/{baseId}/automations/{automationId}/runs/{runId}:retry` | Retry failed run from failed step | `automations:write` | → `202 { runId }` | `409 CONFLICT` (not failed) |
| `GET /v1/automation-catalog` | Trigger & action types (incl. connector actions) with JSON Schemas | `automations:read` | → `200 { triggers: [...], actions: [...] }` | |
| `GET/POST/DELETE /v1/bases/{baseId}/inbound-webhooks[/{ihkId}]` (+ `:rotate-secret`) | Inbound webhook endpoints for "webhook received" triggers | `automations:write` | → `201 { id, url: "https://hooks.tabula.example/i/{token}", secret }` | |

`TriggerConfig` / `StepConfig` schemas: normative in `14-automation-engine.md`.

---

## 16. Tag: Contacts

The contact directory is a workspace-scoped system table (`ctc_…` records). Path: `/v1/workspaces/{workspaceId}/contacts`.

| Method & path | Summary | Scope · Permission | Request → Response | Extra errors |
|---|---|---|---|---|
| `GET …/contacts` | List / filter | `contacts:read` | Tier A params → `CursorPage<Contact>` | |
| `POST …/contacts:query` | Tier B query | `contacts:read` | `RecordQuery` → `RecordQueryResult<Contact>` | |
| `POST …/contacts` | Create (dedup check against identifiers) | `contacts:write` | `{ values, identifiers: [{ type: "email"\|"phone"\|"social", value }], onDuplicate: "error"\|"merge"\|"create" }` → `201 Contact` or `200` (merged) | `409 CONFLICT` (`duplicateOf: ctc_…` when `onDuplicate=error`) |
| `GET/PATCH/DELETE …/contacts/{contactId}` | CRUD | `contacts:read`/`write` | → `200 Contact` | `412 VERSION_CONFLICT` |
| `POST …/contacts:search` | Fuzzy search by name/email/phone/company | `contacts:read` | `{ query, limit ≤ 50 }` → `200 { data: [Contact & { score }] }` | |
| `GET …/contacts:lookup` | Exact lookup by identifier | `contacts:read` | query `email=` or `phone=` (E.164 normalized) → `200 Contact` | `404 RECORD_NOT_FOUND` |
| `GET/POST/DELETE …/contacts/{contactId}/identifiers[/{identifierId}]` | Manage identifiers | `contacts:write` | `{ type, value, primary? }` → `201` | `409 CONFLICT` (identifier owned by other contact; includes `ownerContactId` if visible) |
| `POST …/contacts:merge` | Merge N contacts into survivor | `contacts:write` · `record.update` + `record.delete` | `{ survivorId, mergedIds: [≤ 10], fieldResolution: { fld_…: "survivor"\|"newest"\|"concat"\|{ fromContactId } } }` → `200 { contact, mergeEventId }` (links re-pointed; timeline unified) | `422 INVALID_REQUEST` |
| `POST …/contacts/{contactId}:unmerge` | Reverse a merge event | same | `{ mergeEventId }` → `200 { restored: [ctc_…] }` | `409 CONFLICT` (later merges depend on it) |
| `GET …/contacts/{contactId}/timeline` | Activities, comments, linked record events | `contacts:read` | query `types[]`, `pageSize`, `cursor` → `CursorPage<ContactActivity>` | |
| `POST …/contacts/{contactId}/activities` | Log activity (call, meeting, note, external) | `contacts:write` | `{ type, occurredAt, summary, body?, source?: { connectionId, externalId } }` → `201 ContactActivity` | `409 CONFLICT` (duplicate `source.externalId`) |
| `GET …/contacts/{contactId}/merge-history` | Merge events | `contacts:read` | → `CursorPage<MergeEvent>` | |

---

## 17. Tag: Attachments

Upload is **direct-to-S3** (D15): the API never proxies file bytes.

| Method & path | Summary | Scope · Permission | Request → Response | Extra errors |
|---|---|---|---|---|
| `POST /v1/bases/{baseId}/attachments:init` | Start upload (single PUT ≤ 100 MB, else multipart) | `attachments:write` · `record.update` on target (or `record.create`) | `{ filename, size, mimeType, sha256?, target?: { tableId, fieldId, recordId? } }` → `200 { attachmentId: "att_…", upload: { method: "PUT", url, headers } }` or `{ upload: { method: "multipart", uploadId, partSize, parts: [{ partNumber, url }] } }`, `expiresAt` | `413 PAYLOAD_TOO_LARGE` (plan max file size), `403 PLAN_LIMIT_EXCEEDED` (storage), `422 ATTACHMENT_REJECTED` (blocked extension) |
| `POST /v1/bases/{baseId}/attachments/{attachmentId}:complete` | Finish upload (multipart: ETags list) → quarantine scan | same | `{ parts?: [{ partNumber, etag }] }` → `202 Attachment { status: "scanning" }` | `422 INVALID_REQUEST` (size/checksum mismatch) |
| `GET /v1/bases/{baseId}/attachments/{attachmentId}` | Metadata + signed URL | `records:read` · read access to a cell containing it | query `variant=original\|large\|small` , `disposition=inline\|attachment` → `200 Attachment { url, urlExpiresAt, status, width, height, thumbnails }` | `409 ATTACHMENT_NOT_READY` |
| `GET /v1/bases/{baseId}/attachments/{attachmentId}/download` | `302` redirect to CloudFront signed URL | same | → `302 Location` | |
| `POST /v1/bases/{baseId}/attachments:from-url` | Server-side fetch of remote URL (SSRF-safe egress) | `attachments:write` | `{ url, filename?, target? }` → `202 Attachment { status: "fetching" }` | `422 INVALID_REQUEST` with sub-code `URL_NOT_ALLOWED` (private IP, non-HTTP(S) scheme) |

Attachments become visible in cells once `status=ready`; writing an `att_` that is still `scanning` into a cell is allowed (cell shows "processing"), a `rejected` one fails with `422 ATTACHMENT_REJECTED`.

---

## 18. Tag: Comments

Path: `/v1/bases/{baseId}/tables/{tableId}/records/{recordId}/comments`.

| Method & path | Summary | Scope · Permission | Request → Response | Extra errors |
|---|---|---|---|---|
| `GET …/comments` | Threaded list (root comments, `replies` preview ≤ 3) | `comments:read` · `record.read` | query `parentId?`, `pageSize`, `cursor`, `order=asc\|desc` → `CursorPage<Comment>` | |
| `POST …/comments` | Create (mentions parsed server-side) | `comments:write` · `record.comment` | `{ body: { doc: RichTextDoc } or { text }, parentId?, anchor?: { fieldId } }` → `201 Comment` (+ `mention.created` events, record subscriptions) | `422 INVALID_REQUEST` (mention of user without base access → mention rendered but **no notification**; reported in `warnings[]`) |
| `PATCH …/comments/{commentId}` | Edit own | `comments:write` · author | `{ body }` → `200 Comment` (`editedAt`) | `403 PERMISSION_DENIED` |
| `DELETE …/comments/{commentId}` | Delete own (admins: any) | `comments:write` | → `204` (thread keeps tombstone) | |
| `PUT …/comments/{commentId}/reactions/{emoji}` | Add reaction (idempotent) | `comments:write` | → `200 { emoji, count, reactedByMe: true }` | `422 INVALID_REQUEST` (emoji not in allowed set) |
| `DELETE …/comments/{commentId}/reactions/{emoji}` | Remove own reaction | `comments:write` | → `204` | |
| `PUT/DELETE /v1/bases/{baseId}/tables/{tableId}/records/{recordId}/subscription` | Watch/unwatch record | session/`comments:read` | → `200 { subscribed }` | |

```yaml
Comment:
  properties:
    object: { const: comment }
    id: { type: string, pattern: '^cmt_' }
    recordId: { $ref: RecordId }
    parentId: { type: [string, 'null'] }
    author: { $ref: UserRef }
    body: { properties: { doc: { type: object }, text: { type: string } } }
    mentions: { type: array, items: { properties: { type: { enum: [user, team, record, contact] }, id: { type: string } } } }
    anchor: { properties: { fieldId: { type: string } } }
    reactions: { type: array, items: { properties: { emoji: {}, count: {}, reactedByMe: {} } } }
    replyCount: { type: integer }
    createdAt: {}
    editedAt: {}
    deleted: { type: boolean }
```

---

## 19. Tag: Notifications

| Method & path | Summary | Scope · Permission | Request → Response | Extra errors |
|---|---|---|---|---|
| `GET /v1/notifications` | Inbox | session (or `users:read` for own) | query `status=unread\|all`, `category`, `pageSize`, `cursor` → `CursorPage<Notification>` + `meta.unreadCount` | |
| `POST /v1/notifications:mark-read` | Mark read (ids or all before timestamp) | session | `{ ids?: [ntf_…], before?: Timestamp }` → `200 { updated }` | |
| `PATCH /v1/notifications/{notificationId}` | Read/unread/archive | session | `{ status: "read" or "unread" or "archived" }` → `200 Notification` | |
| `GET /v1/notifications/preferences` | Matrix of scope × category × channel | session | → `200 { defaults, overrides: [{ scope: { type: "base"\|"workspace"\|"global", id? }, category, channel: "in_app"\|"email"\|"push", enabled, digest?: "instant"\|"hourly"\|"daily" }] }` | |
| `PUT /v1/notifications/preferences` | Replace overrides | session | same shape → `200` | |
| `POST /v1/notifications/push-subscriptions` | Register Web Push / mobile token | session | `{ platform, endpoint, keys }` → `201` | |
| `GET /v1/notifications/unsubscribe/{token}` | One-click email unsubscribe (RFC 8058 `List-Unsubscribe-Post`) | public (signed token) | → `200` | |

Categories: `mention`, `comment_reply`, `record_assigned`, `record_watched_change`, `automation_failed`, `share_request`, `invitation`, `import_completed`, `export_ready`, `webhook_disabled`, `integration_auth_failed`, `security` (non-optional).

---

## 20. Tag: Integrations

| Method & path | Summary | Scope · Permission | Request → Response | Extra errors |
|---|---|---|---|---|
| `GET /v1/integrations/providers` | Connector catalogue (manifests: auth type, scopes, actions, triggers) | any | query `q`, `category` → `CursorPage<ConnectorSummary>` | |
| `GET /v1/integrations/providers/{connectorId}` | Connector manifest (versioned) | any | → `200 ConnectorManifest` (`20-…` §Integrations) | |
| `POST /v1/workspaces/{workspaceId}/integrations/connections:oauth-start` | Begin OAuth connect | `integrations:manage` · `integration.manage` | `{ connectorId, scopes?: [], returnTo, sharing: "private"\|"workspace" }` → `200 { authorizeUrl, state }` | `403 ORG_POLICY_VIOLATION` (connector blocked) |
| `GET /v1/integrations/oauth/callback` | Provider redirect target | public (state bound to session) | query `code, state` → `302 returnTo?connectionId=con_…` | `403` on state mismatch (rendered error page) |
| `POST /v1/workspaces/{workspaceId}/integrations/connections` | Create non-OAuth connection (API key / basic / custom) | `integrations:manage` | `{ connectorId, name, credentials: { apiKey } , sharing }` → `201 Connection` (credentials write-only) | `502 UPSTREAM_ERROR` (validation call failed) |
| `GET /v1/workspaces/{workspaceId}/integrations/connections` | List connections visible to caller | `integrations:manage` or `automations:read` | → `CursorPage<Connection>` (no secrets; `status`, `accountLabel`, `scopes`, `lastUsedAt`, `expiresAt`) | |
| `GET/PATCH /v1/workspaces/{workspaceId}/integrations/connections/{connectionId}` | Get / rename / change sharing | `integrations:manage` (owner or workspace owner) | → `200 Connection` | |
| `POST …/connections/{connectionId}:test` | Health check call | `integrations:manage` | → `200 { ok, accountLabel, latencyMs }` | `502 UPSTREAM_ERROR` |
| `POST …/connections/{connectionId}:reauthorize` | Re-run OAuth (scopes upgrade / expired refresh) | same | → `200 { authorizeUrl }` | |
| `DELETE …/connections/{connectionId}` | Disconnect (revoke at provider when supported; dependent automations flagged) | same | → `200 { revokedAtProvider: bool, affectedAutomations: [aut_…] }` | |
| `GET/POST /v1/bases/{baseId}/sync-sources` | List / create sync source → synced table | `integrations:manage` + `schema:write` | `{ connectionId, connectorId, resource: { type: "calendar_events", params }, schedule: { everyMinutes: 15 }, tableName, fieldMapping? }` → `201 SyncSource` (+ `202` initial sync long op) | `403 PLAN_LIMIT_EXCEEDED` |
| `GET/PATCH/DELETE /v1/bases/{baseId}/sync-sources/{syncSourceId}` | Manage | same | → `200` | |
| `POST /v1/bases/{baseId}/sync-sources/{syncSourceId}:run` | Sync now | same | → `202 { syncRunId }` | `409 CONFLICT` (run in progress) |
| `GET /v1/bases/{baseId}/sync-sources/{syncSourceId}/runs` | Sync run history | same | → `CursorPage<SyncRun>` | |
| `GET/POST/DELETE /v1/workspaces/{workspaceId}/secrets[/{secretId}]` | Secrets for scripts/automations (write-only values) | `automations:write` · workspace `creator` | `{ name, value, scope: { baseId? } }` → `201 { id, name, createdAt }` | `409 CONFLICT` |

---

## 21. Tag: Webhooks

Normative behavior: `17-…` §18.

| Method & path | Summary | Scope · Permission | Request → Response | Extra errors |
|---|---|---|---|---|
| `GET /v1/bases/{baseId}/webhooks` | List (own; base creators see all) | `webhooks:manage` | → `CursorPage<Webhook>` | |
| `POST /v1/bases/{baseId}/webhooks` | Create subscription | `webhooks:manage` + data scopes | `WebhookCreate` → `201 Webhook & { secret }` | `422 WEBHOOK_URL_NOT_ALLOWED`, `422 INVALID_FILTER`, `403 PLAN_LIMIT_EXCEEDED` |
| `GET/PATCH/DELETE /v1/bases/{baseId}/webhooks/{webhookId}` | Get / update (`notificationUrl`, `spec`, `status: "active"` re-enable) / delete | `webhooks:manage` · owner | → `200 Webhook` | |
| `GET /v1/bases/{baseId}/webhooks/{webhookId}/payloads` | Pull payloads | `webhooks:manage` | query `cursor` (required), `limit ≤ 50` → `200 WebhookPayloadList` | `410 CURSOR_EXPIRED`, `403 PERMISSION_DENIED` (owner lost access) |
| `POST /v1/bases/{baseId}/webhooks/{webhookId}:rotate-secret` | Rotate (old valid 24 h) | `webhooks:manage` | → `200 { secret, previousSecretExpiresAt }` | |
| `POST /v1/bases/{baseId}/webhooks/{webhookId}:ping` | Send test ping | `webhooks:manage` | → `200 { delivered: bool, status, latencyMs }` | |
| `GET /v1/bases/{baseId}/webhooks/{webhookId}/deliveries` | Delivery log (7 d) | `webhooks:manage` | → `CursorPage<WebhookDelivery { id, attemptedAt, status, httpStatus, latencyMs, errorClass }>` | |

```yaml
WebhookCreate:
  required: [notificationUrl, spec]
  properties:
    notificationUrl: { type: string, format: uri, pattern: '^https://' }
    description: { type: string, maxLength: 255 }
    deliveryMode: { enum: [ping, inline], default: ping }
    spec:
      required: [dataTypes]
      properties:
        dataTypes: { type: array, items: { enum: [record, schema, comment, form_submission] } }
        tableIds: { type: array, items: { $ref: TableId } }
        changeTypes: { type: array, items: { enum: [created, updated, deleted, restored] } }
        watchFieldIds: { type: array, items: { $ref: FieldId } }
        filter: { $ref: FilterNode }
        sources: { type: array, items: { enum: [ui, api, automation, form, import, sync, script, undo, restore] } }
        excludeOwnChanges: { type: boolean, default: false }
        includes: { properties: { previousValues: { type: boolean }, fieldIds: { type: array }, cellFormat: { enum: [json, string] } } }
WebhookPayloadList:
  properties:
    object: { const: webhook_payload_list }
    payloads: { type: array, items: { $ref: ChangePayload } }
    cursor: { type: integer }
    mightHaveMore: { type: boolean }
ChangePayload:
  properties:
    seq: { type: integer }
    timestamp: { $ref: Timestamp }
    actor: { $ref: ActorRef }
    changeId: { type: string }
    correlationId: { type: string }
    records: { type: object, additionalProperties: { properties: { created: { type: array }, updated: { type: array }, deleted: { type: array } } } }
    schema: { type: [object, 'null'], properties: { tables: {}, fields: {}, views: {} } }
    comments: { type: [array, 'null'] }
```

---

## 22. Tag: Search

| Method & path | Summary | Scope · Permission | Request → Response | Extra errors |
|---|---|---|---|---|
| `GET /v1/search` | Global search across accessible bases (records, tables, fields, bases, contacts, interfaces) | `records:read` + `schema:read` | query `q` (≤ 256), `types[]`, `workspaceId?`, `pageSize ≤ 50`, `cursor` → `CursorPage<SearchHit>` | `429 RATE_LIMITED` (search cost) |
| `POST /v1/bases/{baseId}/search` | Base-scoped search | `records:read` · `base.read` | `{ query, tableIds?, fieldIds?, types?: ["record","field","table","view","comment"], pageSize }` → `CursorPage<SearchHit>` | |

```yaml
SearchHit:
  properties:
    object: { const: search_hit }
    type: { enum: [record, table, field, base, view, interface, contact, comment] }
    id: { type: string }
    baseId: { type: string }
    tableId: { type: string }
    title: { type: string }
    snippet: { type: string, description: highlighted with <mark> tags, HTML-escaped }
    matchedFieldIds: { type: array }
    score: { type: number }
```

Permission: candidates are filtered by accessible base IDs at the index; final hits re-checked against PermissionSnapshots (field-level: hits only in hidden fields are dropped).

---

## 23. Tag: Audit (Enterprise)

| Method & path | Summary | Scope · Permission | Request → Response | Extra errors |
|---|---|---|---|---|
| `GET /v1/organizations/{orgId}/audit/events` | Query audit events | `audit:read` · `audit.read` | query `from`, `to` (≤ 90 d hot range; older → export), `actorId`, `eventType[]`, `resourceType`, `resourceId`, `ip`, `pageSize ≤ 500`, `cursor` → `CursorPage<AuditEvent>` | `422 INVALID_REQUEST` (range > 90 d) |
| `POST /v1/organizations/{orgId}/audit/exports` | One-off export (CSV/JSONL/Parquet) incl. archived ranges | `audit:read` | `{ from, to, format, filters }` → `202 LongOperation` (`result.downloadUrl`) | |
| `GET/POST/PATCH/DELETE /v1/organizations/{orgId}/audit/streams[/{streamId}]` | SIEM streaming configs (`audit_exports`): Splunk HEC, Datadog, S3, generic HTTPS | `audit:read` + `org:admin` | `{ destination: { type, url, tokenSecretRef }, filters }` → `201` | `422 WEBHOOK_URL_NOT_ALLOWED` |

```yaml
AuditEvent:
  properties:
    id: {}
    occurredAt: {}
    type: { examples: [session.created, api_token.created, grant.changed, share_link.created, export.completed, org.policy_changed] }
    actor: { properties: { type: {}, id: {}, email: {}, ip: {}, userAgent: {}, tokenId: {} } }
    target: { properties: { type: {}, id: {}, name: {} } }
    context: { properties: { orgId: {}, workspaceId: {}, baseId: {}, requestId: {}, geo: {} } }
    changes: { type: object, description: before/after for admin-relevant properties }
```

---

## 24. Tag: Imports / Exports

Normative behavior: `20-import-export-sharing-integrations.md`.

| Method & path | Summary | Scope · Permission | Request → Response | Extra errors |
|---|---|---|---|---|
| `POST /v1/bases/{baseId}/imports` | Create import job (after file upload via `attachments:init` with `purpose: "import"`) | `imports:write` · `record.create` (+ `table.create` for new table) | `{ source: { uploadId } or { url }, format?: "csv"\|"xlsx"\|"json", options?: { encoding?, delimiter?, sheet?, headerRow? } }` → `202 ImportJob { status: "analyzing" }` | `413 PAYLOAD_TOO_LARGE`, `422 INVALID_REQUEST` (unsupported format) |
| `GET /v1/bases/{baseId}/imports/{importId}` | Job incl. analysis (columns, detected types, confidence, sample rows) | `imports:write` | → `200 ImportJob` | |
| `PUT /v1/bases/{baseId}/imports/{importId}/mapping` | Set mapping & mode | `imports:write` | `ImportMapping` → `200 ImportJob { status: "ready", validationPreview }` | `422 FIELD_VALIDATION_FAILED` (mapping incompatible) |
| `POST /v1/bases/{baseId}/imports/{importId}:start` | Run | `imports:write` | `{ dryRun?: false }` → `202 LongOperation` | `403 PLAN_LIMIT_EXCEEDED` (records/base projection) |
| `POST /v1/bases/{baseId}/imports/{importId}:cancel` | Cancel (optionally rollback) | `imports:write` | `{ rollback: true }` → `202` | `409 CONFLICT` (completed) |
| `POST /v1/bases/{baseId}/imports/{importId}:rollback` | Undo a completed import (trash deletion batch) | `imports:write` · `record.delete` | → `202 LongOperation` | `409 CONFLICT` (rows modified since → requires `force`) |
| `GET /v1/bases/{baseId}/imports/{importId}/errors` | Row errors | `imports:write` | query `pageSize`, `cursor`, `format=json\|csv` → `CursorPage<ImportError>` or `text/csv` stream | |
| `POST /v1/bases/{baseId}/exports` | Create export (view or table) | `exports:read` · `export.data` (+ org export policy) | `{ source: { viewId } or { tableId, filter?, fields? }, format: "csv"\|"xlsx"\|"json"\|"jsonl", options: { cellFormat: "string", timeZone, locale, includeAttachmentsUrls, bom: true } }` → `202 ExportJob` | `403 ORG_POLICY_VIOLATION` |
| `GET /v1/bases/{baseId}/exports/{exportId}` | Status + download URL (signed, 1 h) | `exports:read` | → `200 ExportJob { status, rowCount, sizeBytes, downloadUrl?, expiresAt }` | |
| `GET /v1/bases/{baseId}/views/{viewId}/export.csv` | Small synchronous CSV (≤ 10k rows) | `exports:read` | → `200 text/csv` stream | `422 QUERY_TOO_COMPLEX` (> 10k → use async) |

---

## 25. Tag: Long operations

| Method & path | Summary | Scope · Permission | Request → Response | Extra errors |
|---|---|---|---|---|
| `GET /v1/bases/{baseId}/long-operations` | Recent ops for base (caller's, or all for creators) | any scope covering the op | query `status`, `kind` → `CursorPage<LongOperation>` | |
| `GET /v1/bases/{baseId}/long-operations/{operationId}` | Poll | same | → `200 LongOperation` + `Retry-After` while non-terminal | |
| `POST /v1/bases/{baseId}/long-operations/{operationId}:cancel` | Cancel | initiator or base creator | → `202 LongOperation { status: "cancelling" }` | `409 CONFLICT` (not cancellable / terminal) |
| `GET /v1/long-operations/{operationId}` | Control-plane ops (org member removal, workspace move, audit export) | initiator | → `200 LongOperation` | |

---

## 26. Tag: SCIM v2 (RFC 7643/7644)

Base: `https://api.tabula.example/scim/v2/{orgId}`; auth `scimBearer` (token in `core.scim_directories`, hashed). Content type `application/scim+json`. Errors use SCIM error schema (`urn:ietf:params:scim:api:messages:2.0:Error`), not problem+json.

| Method & path | Summary | Notes |
|---|---|---|
| `GET /ServiceProviderConfig`, `/ResourceTypes`, `/Schemas` | Discovery | patch: supported; bulk: not supported; filter: supported (max 200); sort: no; etag: yes |
| `GET /Users` | List/filter | `filter=userName eq "a@b.com"`, `startIndex`, `count` (SCIM uses index pagination; ≤ 200) |
| `POST /Users` | Provision | Creates/links `users` + `organization_members` (`scim_managed=true`); existing user with verified-domain email is linked, not duplicated; `409` uniqueness per SCIM |
| `GET /Users/{id}` | Get | `id` = `usr_…` |
| `PUT /Users/{id}` / `PATCH /Users/{id}` | Replace / patch | `active: false` ⇒ deactivate member, revoke sessions & tokens, transfer ownership policy |
| `DELETE /Users/{id}` | Deprovision | Same as deactivate (data retained); hard removal via admin UI |
| `GET /Groups`, `POST /Groups`, `GET/PUT/PATCH/DELETE /Groups/{id}` | Teams | `scim_group_mappings` ↔ `teams`; member add/remove via PATCH ops; group → role grants are configured in Tabula, not via SCIM |
| Enterprise extension | `urn:ietf:params:scim:schemas:extension:enterprise:2.0:User` | `department`, `manager` stored as user attributes for row policies |

---

## 27. Operation count & coverage checklist

| Tag | Operations (approx.) | Covered capabilities |
|---|---|---|
| Auth | 20 | password, MFA (TOTP/WebAuthn/recovery), sessions, SSO, OAuth 2.1 server, ws-ticket, reset/verify |
| Users | 11 | profile, prefs, PATs, OAuth grants |
| Organizations | 30 | members, teams, domains, policies, SSO, SCIM info, service accounts, OAuth app policy, usage |
| Workspaces | 13 | CRUD, grants, invitations, move |
| Bases | 27 | CRUD, duplicate, schema, per-base OpenAPI, changes, members, snapshots, trash, share links |
| Tables / Fields | 7 / 9 | CRUD, duplicate, type change (202), conversion preview, options, formula validate |
| Records | 16 | list, query, get, create, PATCH/PUT, delete/restore, batch/upsert, delete-by-filter, history, links, AI generate, button |
| Views / Forms | 13 / 5 | CRUD, config patch, personal state, records via view, public form schema/submit/upload |
| Interfaces | 12 | CRUD, pages, publish/versions, grants, element query/create/edit |
| Automations | 13 | CRUD, publish, enable/disable, test, runs, retry, catalog, inbound webhooks |
| Contacts | 13 | CRUD, query, search, lookup, identifiers, merge/unmerge, timeline, activities |
| Attachments / Comments / Notifications | 5 / 7 / 7 | direct upload, signed URLs; threads & reactions & subscriptions; inbox & prefs & push |
| Integrations / Webhooks / Search / Audit | 15 / 7 / 2 / 6 | connectors, OAuth connect, connections, sync sources, secrets; subscriptions & payloads; global & base search; audit query/export/streams |
| Imports / Exports / Long ops / SCIM | 7 / 3 / 4 / 12 | full lifecycle |

Total ≈ 260 operations. CI asserts every route has `operationId`, tag, scopes, permission, problem response and at least one example.

---

## 28. Proposed additions

| Item | Kind | Reason |
|---|---|---|
| `core.idempotency_keys` | Table | Control-plane idempotency (see `17-…` §25) |
| `core.api_tokens.kind`, `oauth_grant_id`, `pinned_api_version`, `last_used_at`, `last_used_ip` | Columns | OAuth access tokens stored as opaque tokens in the same table |
| `core.push_subscriptions` | Table | Web Push / mobile push endpoints for `POST /v1/notifications/push-subscriptions` (not in Spine inventory) |
| `core.user_mfa_challenges` → **Redis only** (`mfa:{mfaToken}`, 5 min) | Redis namespace | MFA step-2 token; avoids a table |
| `core.connectors`, `core.connector_versions` | Tables | Connector catalogue & manifests (see `20-…` Proposed additions) |
| `data.views.version` column | Column | View ETags for config patch (if not already present in `05-sql-schema.md`) |
| `data.interfaces.draft_version`, `data.automations.draft_version` | Columns | Draft ETags |
| `data.share_links` columns `access`, `allowed_emails`, `allowed_email_domains`, `embed jsonb`, `password_hash`, `token_prefix`, `stats_views_30d`, `last_accessed_at` | Columns | Share link features (`20-…`) |
| `data.webhook_subscriptions` columns (see `17-…` §25) | Columns | Webhook spec/cursor/secret rotation |
| `records:delete-by-filter`, `fields/{id}:preview-conversion`, `formula:validate` | Endpoints | New custom methods to add to the closed list in `17-…` §3.2 (`:delete-by-filter`, `:preview-conversion`, `:validate`, `:mark-read`, `:oauth-start`, `:reauthorize`, `:run`, `:retry`, `:ping`, `:lookup`, `:search`, `:init`, `:complete`, `:from-url`, `:start`, `:rollback`, `:verify`, `:confirm`, `:accept`, `:move`, `:enable`, `:disable`, `:revert`, `:generate`, `:click`, `:invite`, `:test`, `:rotate-token`, `:regenerate`) |
