# 30 — Architecture Diagrams

> **Sections covered:** §56 Architecture Diagrams — system, database (planes/shards), domain model (class), event, automation, realtime, authentication (password + MFA, SAML SSO, OAuth PKCE), permission evaluation, interface, deployment (AWS/EKS), record lifecycle (state), request lifecycle (sequence), plus field type change flow and import flow.
>
> **Status:** Proposed · **Owner:** Platform Architecture · **Date:** 2026-10-03 · Conforms to [`00-canonical-decisions.md`](./00-canonical-decisions.md). Each diagram is a summary; the owning document is linked under it and is authoritative for detail. All diagrams are Mermaid and render on GitHub/GitLab.

---

## Index

| # | Diagram | Type | Owning document |
|---|---|---|---|
| 1 | [System architecture](#1-system-architecture) | flowchart | [`03`](./03-system-architecture.md) |
| 2 | [Database architecture](#2-database-architecture-planes-and-shards) | flowchart | [`04`](./04-database-architecture.md) |
| 3 | [Domain model](#3-domain-model) | classDiagram | [`02`](./02-domain-model-and-erd.md) |
| 4 | [Event architecture](#4-event-architecture) | flowchart | [`15`](./15-events.md) |
| 5 | [Automation architecture](#5-automation-architecture) | flowchart | [`14`](./14-automation-engine.md) |
| 6 | [Realtime architecture](#6-realtime-architecture) | flowchart | [`16`](./16-realtime.md) |
| 7 | [Authentication architecture](#7-authentication-architecture) | 3 × sequence | [`19`](./19-permissions-and-multitenancy.md), [`25`](./25-security-observability-infrastructure.md) |
| 8 | [Permission architecture](#8-permission-architecture-evaluation-flow) | flowchart | [`19`](./19-permissions-and-multitenancy.md) |
| 9 | [Interface architecture](#9-interface-architecture) | flowchart | [`13`](./13-interface-builder.md) |
| 10 | [Deployment architecture](#10-deployment-architecture-aws--eks) | flowchart | [`25`](./25-security-observability-infrastructure.md) |
| 11 | [Record lifecycle](#11-record-lifecycle) | stateDiagram | [`06`](./06-record-storage.md), [`22`](./22-audit-history-undo-trash.md) |
| 12 | [Request lifecycle](#12-request-lifecycle) | sequence | [`03`](./03-system-architecture.md), [`17`](./17-api-architecture.md) |
| 13 | [Field type change flow](#13-field-type-change-flow) | sequence | [`06` §15](./06-record-storage.md), [`07`](./07-field-engine.md) |
| 14 | [Import flow](#14-import-flow) | sequence | [`20`](./20-import-export-sharing-integrations.md) |

---

## 1. System architecture

Clients enter through CloudFront/WAF and an ALB into one EKS cluster per region where the single server image runs as process roles. `api` handles REST and write transactions; `realtime` handles WebSockets; `relay` streams committed changes from each shard into the event backbone; `worker` pools consume queues/topics; `scheduler` runs leader-only loops; `sandbox` executes user scripts with no credentials. State lives in the control-plane Postgres, data-plane shards, the audit store, Redis, Kafka, OpenSearch and S3.

```mermaid
flowchart LR
  subgraph C["Clients"]
    SPA["Web SPA"]
    PUB["Public forms shares apps"]
    DEV["API clients"]
  end
  subgraph E["Edge"]
    CF["CloudFront WAF"]
    ALB["ALB"]
  end
  subgraph R["Process roles - one image"]
    API["api"]
    RT["realtime"]
    WK["worker pools"]
    SC["scheduler"]
    RL["relay"]
    SB["sandbox"]
  end
  subgraph S["State"]
    CP[("Control plane")]
    DP[("Data plane shards")]
    AU[("Audit store")]
    RD[("Redis")]
    KF[("Kafka API")]
    OSS[("OpenSearch")]
    OBJ[("S3")]
  end
  SPA --> CF
  PUB --> CF
  DEV --> CF
  CF --> ALB
  ALB --> API
  ALB --> RT
  API --> CP
  API --> DP
  API --> RD
  API --> OBJ
  DP --> RL
  RL --> KF
  KF --> WK
  KF --> RT
  RT --> RD
  WK --> DP
  WK --> CP
  WK --> AU
  WK --> OSS
  WK --> SB
  SC --> DP
  SC --> CP
```

---

## 2. Database architecture (planes and shards)

The control plane answers "who, what may they access, and where does it live". Routing goes base → workspace → shard through cached directories. Each data-plane shard hosts many workspaces (workspace affinity), has replicas for reads, and a relay reading its logical replication slot. Enterprise orgs can have dedicated shards. Audit is a separate store with S3 Parquet archive.

```mermaid
flowchart TB
  subgraph CPL["Control plane cluster - schema core"]
    CPP[("primary")]
    CPR[("replicas")]
    DIR["workspace_directory and base_directory"]
    SHR["shards registry"]
  end
  ROUTER["ShardResolver - LRU 30s plus Redis 300s"]
  subgraph CELL1["Cell dp-001"]
    B1["PgBouncer"]
    P1[("primary - schema data")]
    R1[("replicas x2")]
    L1["relay - slot"]
  end
  subgraph CELL2["Cell dp-002"]
    B2["PgBouncer"]
    P2[("primary - schema data")]
    R2[("replicas x2")]
    L2["relay - slot"]
  end
  subgraph CELLD["Dedicated cell - one org, own KMS key"]
    BD["PgBouncer"]
    PD[("primary - schema data")]
    LD["relay - slot"]
  end
  subgraph AUD["Audit store - schema audit"]
    AP[("audit primary")]
    AR[("S3 Parquet archive")]
  end
  ROUTER --> DIR
  DIR --> CPR
  ROUTER --> B1
  ROUTER --> B2
  ROUTER --> BD
  B1 --> P1
  B2 --> P2
  BD --> PD
  P1 -.-> R1
  P2 -.-> R2
  P1 --> L1
  P2 --> L2
  PD --> LD
  L1 --> LOG["Kafka API log"]
  L2 --> LOG
  LD --> LOG
  LOG --> AW["audit writer"]
  AW --> AP
  AP --> AR
```

---

## 3. Domain model

Core aggregates and their relationships (logical; physical tables in [`02` §4](./02-domain-model-and-erd.md#4-entity-relationship-diagrams)). Control-plane classes on the left reference data-plane classes by id only.

```mermaid
classDiagram
  class Organization {
    +uuid id
    +string slug
    +string homeRegion
    +status
  }
  class User {
    +uuid id
    +string email
    +status
  }
  class Team {
    +uuid id
    +string name
  }
  class Workspace {
    +uuid id
    +uuid shardId
  }
  class AccessGrant {
    +string resourceType
    +uuid resourceId
    +string principalType
    +string role
  }
  class Base {
    +uuid id
    +long changeSeq
    +long schemaVersion
    +long permEpoch
  }
  class Table {
    +uuid id
    +uuid primaryFieldId
    +int nextFieldSlot
  }
  class Field {
    +uuid id
    +int slot
    +string type
    +json config
  }
  class LinkRelation {
    +uuid id
    +string cardinality
  }
  class Record {
    +uuid id
    +json cells
    +json computed
    +long version
  }
  class View {
    +uuid id
    +string type
    +json config
    +string visibility
  }
  class Interface {
    +uuid id
    +int draftRevision
  }
  class InterfaceVersion {
    +int versionNo
    +json snapshot
  }
  class Automation {
    +uuid id
    +string status
  }
  class AutomationVersion {
    +int versionNo
    +json definition
  }
  class AutomationRun {
    +uuid id
    +string status
    +int causationDepth
  }
  class Comment {
    +uuid id
    +json body
  }
  class Attachment {
    +uuid id
    +string scanStatus
  }
  class ChangeSet {
    +long seq
    +json ops
    +json inverseOps
  }
  class DeletionBatch {
    +uuid id
    +string kind
  }
  Organization "1" --> "*" Workspace : owns
  Organization "1" --> "*" Team : groups
  User "*" --> "*" Organization : member of
  Team "*" --> "*" User : contains
  AccessGrant --> Workspace : on
  AccessGrant --> Base : on
  AccessGrant --> Interface : on
  Workspace "1" --> "*" Base : contains
  Base "1" --> "*" Table : contains
  Table "1" --> "*" Field : defines
  Table "1" --> "*" Record : holds
  Table "1" --> "*" View : presents
  LinkRelation --> Field : side A and B
  Record "*" --> "*" Record : linked via LinkRelation
  Base "1" --> "*" Interface : contains
  Interface "1" --> "*" InterfaceVersion : publishes
  Base "1" --> "*" Automation : contains
  Automation "1" --> "*" AutomationVersion : publishes
  AutomationVersion "1" --> "*" AutomationRun : pinned by
  Record "1" --> "*" Comment : discussed in
  Record "*" --> "*" Attachment : references
  Base "1" --> "*" ChangeSet : ordered log
  Base "1" --> "*" DeletionBatch : trash
```

---

## 4. Event architecture

Every shard transaction writes current state plus `base_changes` (fine-grained ordered ops) and `outbox_events` (domain events). The relay reads both through logical replication and publishes to the Kafka API topics (V1) or BullMQ/Redis pub/sub (MVP profile behind the same `EventBus` interface). Consumers are idempotent; DLQs per topic.

```mermaid
flowchart LR
  subgraph TX["Shard transaction"]
    ST["current state tables"]
    BC["base_changes"]
    OB["outbox_events"]
  end
  TX --> WAL["WAL - logical slot"]
  WAL --> RLY["relay"]
  RLY --> T1["tabula.base-changes.v1 - key base_id"]
  RLY --> T2["tabula.domain-events.v1 - key workspace or base"]
  RLY --> T3["tabula.audit.v1 - key org_id"]
  RLY --> T4["tabula.usage.v1 - key org_id"]
  T1 --> RTF["realtime fan-out"]
  T1 --> WHD["webhook dispatcher"]
  T1 --> SYX["sync exporters"]
  T2 --> ATM["automation trigger matcher"]
  T2 --> NTR["notification router"]
  T2 --> IDX["search indexer"]
  T2 --> AIF["AI field runner"]
  T2 --> CTL["contact timeline"]
  T3 --> AUW["audit writer"]
  T4 --> USG["usage meter"]
  ATM --> DLQ["dlq topics"]
  WHD --> DLQ
  RLY -. MVP profile .-> BQ["BullMQ queues and Redis pub/sub"]
```

---

## 5. Automation architecture

The trigger matcher consumes domain events and schedules, matches them against an in-memory trigger index per base, applies conditions, and inserts idempotent `automation_runs` (`run_key` from the trigger event). Admission enforces tenant fairness and quotas; steps execute on `automation-step` workers with leases; scripts run in the sandbox via mTLS RPC; external calls leave through the egress proxy. Actions write through the normal record write path with `actor.type=automation` and `causationDepth + 1`, which feeds back into the event stream bounded by `MAX_CAUSATION_DEPTH` = 8.

```mermaid
flowchart TB
  EV["domain events"] --> TM["trigger matcher"]
  SCHD["scheduler - automation_schedules"] --> TM
  IHK["inbound webhook endpoint"] --> TM
  BTN["button clicked"] --> TM
  TM --> IDXT["trigger index per base"]
  TM --> COND["condition evaluation - filter AST"]
  COND --> RUN["insert automation_runs - unique run_key"]
  RUN --> ADM["admission - quotas, budgets, fairness"]
  ADM --> Q["automation-step queue"]
  Q --> SR["step runner - leases"]
  SR --> REC["record actions - write path"]
  SR --> SBX["sandbox - scripts"]
  SR --> EGP["egress proxy"]
  SR --> AIG["AI gateway"]
  SR --> EML["email and notifications"]
  EGP --> EXT["external APIs"]
  REC --> EV2["new events with causationDepth plus 1"]
  EV2 --> GUARD{"depth above 8 or budget exceeded"}
  GUARD -->|no| TM
  GUARD -->|yes| DIS["disable_by_system and notify"]
  SR --> SRUN["automation_step_runs"]
  RECON["reconciler"] --> SRUN
  RECON --> Q
```

---

## 6. Realtime architecture

Clients authenticate with a single-use ws-ticket, subscribe to a base from the `asOfSeq` they loaded, and receive committed changes in seq order after per-connection redaction. Presence lives only in Redis. Gaps trigger catch-up from `base_changes`. MVP fan-out uses Redis pub/sub `rt:base:{baseId}`; V1 uses Kafka consumer groups per gateway node with base-affine subscription routing.

```mermaid
flowchart LR
  subgraph Browser
    RS["RecordStore"]
    WSC["realtime-client"]
  end
  WSC -->|"ws-ticket, subscribe baseId fromSeq"| LB["ALB - sticky by base hash"]
  LB --> GW1["gateway node 1"]
  LB --> GW2["gateway node 2"]
  GW1 --> PRES[("Redis presence hash")]
  GW2 --> PRES
  BCT["base-changes topic or rt pub/sub"] --> GW1
  BCT --> GW2
  GW1 --> RED["per-connection redaction - perm snapshot"]
  RED --> WSC
  GW1 -->|"gap detected"| CU["catch-up - base_changes since seq"]
  CU --> REP[("shard replica")]
  WSC -->|"ops setCell addLinks"| GW1
  GW1 -->|"command"| WP["write path - records facade"]
  WP --> SH[("shard primary")]
  SH --> RLY["relay"]
  RLY --> BCT
  RS <--> WSC
```

---

## 7. Authentication architecture

Opaque session tokens (HttpOnly cookie) hashed in Postgres and cached in Redis (`sess:{tokenHash}`); Argon2id passwords; TOTP/WebAuthn MFA; SAML/OIDC through BoxyHQ SAML Jackson; OAuth 2.1 with PKCE for third-party apps (D19).

### 7.1 Password + MFA login

```mermaid
sequenceDiagram
  autonumber
  participant B as Browser
  participant API as api auth
  participant RL as Redis rate limit
  participant CP as Control plane
  participant R as Redis sessions
  B->>API: POST auth login email password
  API->>RL: check rl login per IP and per email
  API->>CP: load user and password identity
  API->>CP: check domain SSO enforcement
  alt SSO enforced for domain
    API-->>B: 409 redirect to SSO
  end
  API->>API: Argon2id verify, constant time on unknown user
  alt MFA enrolled
    API-->>B: 200 mfa_required with short lived challenge token
    B->>API: POST auth mfa verify TOTP or WebAuthn assertion
    API->>CP: verify factor, update sign count
  end
  API->>CP: INSERT sessions token_hash mfa_level
  API->>R: SET sess tokenHash TTL
  API->>CP: outbox session.created
  API-->>B: Set-Cookie session HttpOnly Secure SameSite Lax, plus CSRF token
```

### 7.2 SAML SSO (SP-initiated)

```mermaid
sequenceDiagram
  autonumber
  participant B as Browser
  participant API as api auth
  participant JX as SAML Jackson
  participant IDP as Customer IdP
  participant CP as Control plane
  B->>API: POST auth sso start with email
  API->>CP: resolve organization_domains to sso_connection
  API->>JX: authorize request for tenant and product
  JX-->>B: redirect with SAMLRequest and RelayState
  B->>IDP: authenticate user
  IDP-->>B: POST SAMLResponse to ACS
  B->>JX: SAMLResponse
  JX->>JX: validate signature, audience, NotOnOrAfter, replay cache
  JX-->>API: OAuth style code exchange returns profile
  API->>CP: find user_identity by saml subject
  alt not found and JIT enabled
    API->>CP: create user, identity, organization_member with default role
  end
  API->>CP: INSERT session auth_method sso
  API-->>B: Set-Cookie session and redirect to app
```

### 7.3 OAuth 2.1 authorization code with PKCE (third-party app)

```mermaid
sequenceDiagram
  autonumber
  participant APP as Third party app
  participant B as User browser
  participant API as api oauth
  participant CP as Control plane
  APP->>APP: create code_verifier and S256 code_challenge
  APP->>B: redirect to v1 auth oauth authorize with client_id scopes code_challenge state
  B->>API: GET authorize
  API->>CP: validate client and redirect_uri exact match
  API-->>B: consent screen with scopes and base picker
  B->>API: approve
  API->>CP: upsert oauth_grants, insert oauth_authorization_codes TTL 60s
  API-->>B: redirect to app with code and state
  B->>APP: code and state
  APP->>API: POST v1 auth oauth token with code and code_verifier
  API->>CP: redeem code once, verify S256 challenge
  API-->>APP: access token 1h opaque, refresh token rotating
  APP->>API: API call with Bearer access token
  API->>API: scopes intersect resource restrictions intersect user permissions
```

---

## 8. Permission architecture (evaluation flow)

Additive grants (org → workspace → base, max role wins) produce a base role; deny-style restriction overlays (table, field, locked views, interface element scopes, Enterprise row policies) narrow it; token scopes and share-link scopes intersect. The result is compiled into a `PermissionSnapshot` cached at `perm:{principalId}:{baseId}:{permEpoch}` and invalidated by bumping `perm_epoch`.

```mermaid
flowchart TB
  START["request with principal, base, action, target"] --> EP["read permEpoch for base - pod map"]
  EP --> CACHE{"snapshot in Redis"}
  CACHE -->|hit| EVAL
  CACHE -->|miss| COMPILE
  subgraph COMPILE["Compile snapshot"]
    G1["org role and org policy"] --> MAX["max role across grants"]
    G2["workspace grants - user and teams"] --> MAX
    G3["base grants - user and teams"] --> MAX
    G4["interface grants"] --> IFS["interface scopes"]
    MAX --> ROLE["effective base role"]
    ROLE --> ACT["role to action set"]
    OV["restrictions - tables, fields, locked views, row policies"] --> NAR["narrow action set"]
    ACT --> NAR
    IFS --> NAR
    NAR --> SNAP["PermissionSnapshot"]
  end
  COMPILE --> STORE["SET perm key with TTL"]
  STORE --> EVAL
  EVAL["evaluate action"] --> TOK{"API token or OAuth"}
  TOK -->|yes| SCOPE["intersect token scopes and resource restrictions"]
  TOK -->|no| SHARE{"share link principal"}
  SCOPE --> SHARE
  SHARE -->|yes| SHS["intersect share scope - view fields and filter"]
  SHARE -->|no| ROW
  SHS --> ROW{"row policy or interface record filter applies"}
  ROW -->|yes| RF["inject record predicate into query or check record"]
  ROW -->|no| DEC
  RF --> DEC{"allowed"}
  DEC -->|yes| OK["proceed and redact restricted fields in output"]
  DEC -->|no| DENY["403 problem json, audit denied for sensitive actions"]
```

---

## 9. Interface architecture

Builders edit a **draft** (pages with element trees). Publishing copies drafts into an immutable `interface_versions` row and compiles element permissions. End users load the published version; each data element issues an element-scoped query where the server applies the element's forced filters and permissions, so users never query the base directly. Buttons emit `button.clicked` to automations.

```mermaid
flowchart LR
  subgraph Builder["Builder - interface_editor"]
    CAN["canvas editor"]
    DRAFT["UI interfaceDraft store"]
  end
  CAN --> DRAFT
  DRAFT -->|"PUT page with If-Match"| PAGES[("interface_pages layout draft")]
  DRAFT -->|"publish"| PUBL["publish service"]
  PUBL --> VAL["validate bindings against schema"]
  VAL --> COMP["compile element permissions"]
  COMP --> VER[("interface_versions immutable")]
  VER --> PTR["interfaces.published_version_id"]
  subgraph Runtime["End user - interface_user or interface_only"]
    APPR["app renderer"]
    ELM["element components"]
  end
  PTR --> APPR
  APPR --> ELM
  ELM -->|"elements elementId query"| EQ["element query service"]
  EQ --> PS["perm snapshot with interface scope"]
  EQ --> QC["query compiler - forced filters, current user predicates"]
  QC --> SHARD[("shard")]
  ELM -->|"edit within allowed fields"| WP["records write path"]
  ELM -->|"button"| BC["button.clicked event"]
  BC --> AUT["automations"]
```

---

## 10. Deployment architecture (AWS / EKS)

One AWS account per environment per region (prod-us, prod-eu), three AZs. Public traffic terminates at CloudFront/WAF, then a regional ALB into EKS. Node groups separate general compute, realtime (connection-heavy), file processing (native deps), and sandbox (isolated, tainted, no IAM). Managed data services sit in private subnets; egress to customer endpoints goes through an allowlisting proxy with fixed NAT IPs.

```mermaid
flowchart TB
  U["Users and API clients"] --> R53["Route 53 - latency and geo routing"]
  R53 --> CFR["CloudFront plus WAF plus Shield"]
  CFR --> S3W[("S3 static SPA assets")]
  CFR --> ALBR["ALB - public subnets, 3 AZ"]
  subgraph VPC["VPC - prod region"]
    subgraph EKSC["EKS cluster"]
      NG1["node group general - api, worker, scheduler, relay"]
      NG2["node group realtime"]
      NG3["node group file workers"]
      NG4["node group sandbox - tainted, no IAM role"]
      ADD["add-ons - KEDA, Argo Rollouts, External Secrets, OTel collector"]
    end
    PGBN["PgBouncer deployments per shard"]
    RDSCP[("RDS Postgres control plane Multi-AZ")]
    RDSS[("RDS Postgres shards Multi-AZ plus replicas")]
    RDSA[("RDS Postgres audit")]
    ECC[("ElastiCache cache cluster")]
    ECQ[("ElastiCache BullMQ cluster AOF")]
    MSK[("Amazon MSK")]
    OSD[("OpenSearch Service")]
    EGX["egress proxy plus NAT fixed IPs"]
  end
  ALBR --> NG1
  ALBR --> NG2
  NG1 --> PGBN
  NG2 --> PGBN
  NG3 --> PGBN
  PGBN --> RDSS
  NG1 --> RDSCP
  NG1 --> RDSA
  NG1 --> ECC
  NG1 --> ECQ
  NG1 --> MSK
  NG2 --> ECC
  NG2 --> MSK
  NG1 --> OSD
  NG3 --> S3B[("S3 attachment buckets SSE-KMS")]
  NG1 --> S3B
  NG4 --> EGX
  NG1 --> EGX
  EGX --> INET["Internet - customer webhooks, SaaS, AI providers"]
  KMS["KMS CMKs"] -.-> RDSS
  KMS -.-> S3B
  SM["Secrets Manager"] -.-> EKSC
  GHA["GitHub Actions"] --> ECR[("ECR images")]
  ARGO["Argo CD"] --> EKSC
  ECR --> EKSC
```

---

## 11. Record lifecycle

A record is created live, may have computed fields temporarily stale (deferred fan-out), can be trashed (its link pairs captured in the deletion batch), restored, merged (contact records), and finally purged after `TRASH_RETENTION`.

```mermaid
stateDiagram-v2
  [*] --> Live : create via UI API form import sync automation
  state Live {
    [*] --> Fresh
    Fresh --> Stale : dependency changed with fanout above 500
    Stale --> Fresh : compute worker recalculates
    Fresh --> Fresh : cell edit with sync recompute
  }
  Live --> Trashed : delete creates deletion batch and captures links
  Trashed --> Live : restore batch and reinsert live links
  Live --> Merged : contact merge into survivor
  Merged --> Live : unmerge within retention
  Merged --> Purged : retention elapsed
  Trashed --> Purged : retention elapsed or permanent delete
  Purged --> [*]
```

---

## 12. Request lifecycle

A public API write request end to end, including idempotency and the post-commit path. Read requests follow the same front half and use replica routing by base-seq watermark.

```mermaid
sequenceDiagram
  autonumber
  participant CL as API client
  participant CF as CloudFront WAF
  participant API as api pod
  participant RD as Redis
  participant CP as Control plane replica
  participant SH as Shard primary
  participant RL as relay
  participant KF as Kafka
  participant CS as Consumers
  CL->>CF: PATCH records with Bearer token and Idempotency-Key
  CF->>API: forward via ALB
  API->>API: requestId and trace context
  API->>RD: token lookup, rate limit buckets, idem fast path
  alt idempotent replay
    API-->>CL: stored response
  end
  API->>API: decode public ids
  API->>RD: route cache
  opt route miss
    API->>CP: base_directory join workspace_directory
  end
  API->>RD: perm snapshot and schema snapshot
  API->>API: validate, normalize, authorize
  API->>SH: BEGIN, SET LOCAL workspace, allocate change_seq
  API->>SH: lock rows, write records links computed revisions
  API->>SH: INSERT base_changes, outbox_events, idempotency_keys
  API->>SH: COMMIT
  API->>RD: watermark seq and lsn, idem response
  API-->>CL: 200 with records, ETag versions, X-Tabula-Base-Seq
  SH-->>RL: logical decoding
  RL->>KF: publish events
  KF-->>CS: realtime, automations, webhooks, search, audit, usage
```

---

## 13. Field type change flow

Shadow-slot conversion ([`06` §15](./06-record-storage.md)): the field keeps its id, gets a new slot; small tables convert in the same transaction, large tables in background batches with dual-read; undo repoints the slot.

```mermaid
sequenceDiagram
  autonumber
  participant U as Builder
  participant API as api schema
  participant SH as Shard
  participant W as worker maintenance
  participant RT as realtime clients
  U->>API: PATCH field with new type, preflight
  API->>SH: sample 1000 values
  API->>API: converter preview counts lossy values
  API-->>U: preview - convertible, lossy, examples
  U->>API: confirm conversion
  API->>SH: BEGIN, lock base_runtime, schema_version plus 1
  API->>SH: allocate new slot, set fields.conversion fromSlot toSlot, type and config
  API->>SH: re-typecheck dependents, mark invalid ones
  alt records up to 5000
    API->>SH: convert all rows into new slot in same tx
    API->>SH: clear conversion, tombstone old slot for undo window
  else large table
    API->>SH: INSERT long_operations queued
  end
  API->>SH: base_changes field.type_changed with inverse repoint op, outbox
  API->>SH: COMMIT
  SH-->>RT: field.type_changed - clients reload schema and visible window
  opt large table
    loop batches of 1000 with SKIP LOCKED
      W->>SH: read old slot, convert, write new slot
      W->>SH: progress, long_operation.progressed
    end
    W->>SH: finalize - clear conversion, schema_version plus 1
    W->>SH: enqueue recompute of dependents
  end
  opt undo within window
    U->>API: undo change
    API->>SH: repoint field slot to old slot, restore type and config
  end
```

---

## 14. Import flow

CSV/XLSX import: upload to quarantine, scan, analyze, map, then process in chunks of 1,000 rows through the normal record write path under a long operation. Every chunk's `base_changes` row is tagged with the operation id so the import can be undone within retention.

```mermaid
sequenceDiagram
  autonumber
  participant U as User
  participant API as api import-export
  participant S3 as S3 quarantine
  participant FS as worker file-scan
  participant IW as worker import
  participant SH as Shard
  participant N as notification
  U->>API: POST imports
  API->>SH: INSERT import_jobs draft
  API-->>U: presigned upload URL
  U->>S3: upload file
  U->>API: POST imports analyze
  API->>FS: enqueue scan
  FS->>S3: ClamAV scan
  FS->>SH: scan clean
  API->>IW: analyze job - parse header and 1000 sample rows, detect types
  IW->>SH: save analysis
  API-->>U: columns with suggested field types
  U->>API: PUT mapping and POST start
  API->>SH: check plan record limits estimate, INSERT long_operations
  API->>IW: enqueue import
  loop each chunk of 1000 rows
    IW->>IW: parse, normalize via field types, collect row errors
    IW->>SH: tx - create fields if needed, upsert records, links by key, base_changes tagged with lop, outbox records.bulk_changed
    IW->>SH: INSERT import_errors, update progress
    SH-->>U: long_operation.progressed via realtime
  end
  IW->>SH: import_jobs completed, counts
  IW->>N: import.completed
  N-->>U: in-app and email notification with error report link
  opt undo import
    U->>API: POST imports undo
    API->>SH: apply inverse ops of tagged changes in reverse seq order
  end
```

---

## Proposed additions

None.
