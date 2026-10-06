# 32 — Database Table & Object Inventory

> **Status:** Proposed for architectural approval · **Owner:** Platform Architecture (Database) · **Date:** 2026-10-03
>
> **Sections covered:** Section 58 (final table inventory: every table with purpose, important columns, relationships and indexes — generated from and matching the DDL in [05](05-sql-schema.md)); Section 59 (complete object hierarchy: Organization → Workspace → Base → Table → Field/Record/View…, interfaces, automations, contacts, sharing, integrations, secrets, webhooks, AI templates, user-scoped objects — annotated with plane and table).
>
> **Normative inputs:** [00 — Canonical Decisions](00-canonical-decisions.md) §3 (ID prefixes), §5 (inventory). Rationale: [04 — Database Architecture](04-database-architecture.md).

---

## 58. Table inventory

### 58.0 Reading guide

* **Counts:** `core` 37 spine + 2 proposed · `data` 54 spine + 6 proposed · `audit` 2 spine → **101 tables**. Rows marked **[Proposed]** are not in the spine (§5) and await reconciliation ([04 §6.29](04-database-architecture.md)).
* **Partitioning column:** `HASH(col)` / `RANGE(col)` per [04 §6.7](04-database-architecture.md); blank = unpartitioned.
* **Indexes column** notation: `PK(...)` primary key; `UQ(...)` unique (constraint or index); `IX(...)` btree; `GIN(...)`, `BRIN(...)`; `incl.` = covering `INCLUDE` columns; `NND` = `NULLS NOT DISTINCT`; `WHERE …` = partial index.
* **Relationships:** `→` declared FK (with `ON DELETE` where notable); *(logical)* = enforced by the application + reconciliation, deliberately not a declared FK (hot tables, partitioned tables, cross-plane). No FK ever crosses planes or shards.
* Every data-plane table carries `workspace_id` and RLS policy `tenant_rw` keyed on `app.workspace_id` (except `relay_checkpoints`); system rows of `ai_prompt_templates` have `workspace_id IS NULL`. Control-plane RLS families are listed in [05 §7.3.10](05-sql-schema.md).

### 58.1 Control plane — schema `core`

| # | Table | Purpose | Important columns | Relationships | Partitioning | Indexes |
|---|---|---|---|---|---|---|
| 1 | `organizations` | Tenant root: billing, SSO, policies, residency | slug, kind, status, data_region, kms_key_arn, settings | parent of almost every core table (org_id); referenced by data plane by UUID only |  | `PK(id)`<br>`UQ(slug) WHERE deleted_at IS NULL`<br>`IX(status) WHERE status <> 'active'`<br>`IX(purge_after) WHERE purge_after IS NOT NULL` |
| 2 | `organization_domains` | Verified email domains (SSO enforcement, auto-join) | domain, status, verification_token_hash, auto_join, sso_enforced | org_id → organizations (CASCADE) |  | `PK(id)`<br>`UQ(domain) WHERE status = 'verified'`<br>`UQ(org_id, domain)` |
| 3 | `users` | Global user identity | email, email_normalized, display_name, locale, time_zone, status | referenced by members, identities, sessions, tokens, notifications; data plane stores user UUIDs (no FK) |  | `PK(id)`<br>`UQ(email_normalized) WHERE status <> 'erased'`<br>`GIN(lower(display_name) gin_trgm_ops)` |
| 4 | `organization_members` | User ↔ org membership with org role | role (owner/admin/billing_admin/member/guest), status, source, scim_external_id | org_id → organizations; user_id → users (CASCADE) |  | `PK(org_id, user_id)`<br>`IX(user_id) WHERE status = 'active'`<br>`IX(org_id, role) WHERE role IN ('owner','admin','billing_admin')`<br>`UQ(org_id, scim_external_id) WHERE scim_external_id IS NOT NULL` |
| 5 | `organization_policies` | Enterprise policy settings, one row per policy key | policy_key, value jsonb, schema_version, version | org_id → organizations (CASCADE) |  | `PK(org_id, policy_key)` |
| 6 | `user_identities` | Login methods: password hash, OAuth subject, SAML/OIDC subject | provider, subject, sso_connection_id, password_hash (Argon2id) | user_id → users; sso_connection_id → sso_connections (CASCADE) |  | `PK(id)`<br>`UQ(provider, sso_connection_id, subject) NND`<br>`UQ(user_id) WHERE provider = 'password'`<br>`IX(user_id)` |
| 7 | `user_mfa_factors` | TOTP (encrypted), WebAuthn credentials, recovery codes (hashed) | kind, totp_secret_ciphertext/key_id/dek_ciphertext, webauthn_credential_id, recovery_code_hashes | user_id → users (CASCADE) |  | `PK(id)`<br>`IX(user_id) WHERE deleted_at IS NULL`<br>`UQ(webauthn_credential_id) WHERE webauthn_credential_id IS NOT NULL AND deleted_at IS NULL`<br>`UQ(user_id) WHERE kind = 'recovery_codes' AND deleted_at IS NULL` |
| 8 | `user_preferences` | UI preferences (not notification prefs) | prefs jsonb, schema_version | user_id → users (1:1, CASCADE) |  | `PK(user_id)` |
| 9 | `sessions` | Opaque session tokens (SHA-256 hashed) | token_hash, mfa_level, auth_method, idle_expires_at, expires_at, revoked_at | user_id → users (CASCADE); sso_connection_id/org_id informational |  | `PK(id)`<br>`UQ(token_hash)`<br>`IX(user_id) WHERE revoked_at IS NULL`<br>`IX(expires_at)` |
| 10 | `teams` | Groups of users within an org (manual or SCIM) | name, source | org_id → organizations; ← team_members, scim_group_mappings; principal in access_grants |  | `PK(id)`<br>`UQ(org_id, lower(name)) WHERE deleted_at IS NULL` |
| 11 | `team_members` | User ↔ team | source | team_id → teams; user_id → users; org_id → organizations (CASCADE) |  | `PK(team_id, user_id)`<br>`IX(user_id)` |
| 12 | `shards` | Data plane shard registry (no credentials, secret refs only) | name, region, status, dsn_secret_ref, writer/reader endpoints, dedicated_org_id, capacity_weight | dedicated_org_id → organizations (RESTRICT); ← workspace_directory, base_directory |  | `PK(id)`<br>`UQ(name)`<br>`IX(region, status) WHERE status = 'active'` |
| 13 | `workspaces` | Container of bases; belongs to org | name, status, contact_directory_base_id, settings, purge_after | org_id → organizations (CASCADE); contact_directory_base_id → data.bases (cross-plane, app-enforced) |  | `PK(id)`<br>`IX(org_id) WHERE deleted_at IS NULL`<br>`IX(purge_after) WHERE purge_after IS NOT NULL` |
| 14 | `workspace_directory` | Workspace → shard routing (authoritative) | shard_id, status, migration_epoch, region | workspace_id → workspaces (1:1); shard_id → shards (RESTRICT) |  | `PK(workspace_id)`<br>`IX(shard_id)`<br>`IX(org_id)` |
| 15 | `base_directory` | Base → workspace/shard routing + name for global listing | workspace_id, shard_id, kind, name, status, order_key | workspace_id → workspaces; shard_id → shards; base_id mirrors data.bases.id |  | `PK(base_id)`<br>`IX(workspace_id, order_key) WHERE status = 'active'`<br>`IX(shard_id)`<br>`GIN(lower(name) gin_trgm_ops) WHERE status = 'active'` |
| 16 | `service_accounts` | Non-human principals owned by an org | name, status | org_id → organizations; ← api_tokens; principal in access_grants |  | `PK(id)`<br>`UQ(org_id, lower(name)) WHERE deleted_at IS NULL` |
| 17 | `access_grants` | Additive role grants (org/workspace/base/interface × user/team/service_account) | resource_type, resource_id, principal_type, principal_id, role, workspace_id, base_id, expires_at | org_id → organizations; resource/principal polymorphic (app-enforced) |  | `PK(id)`<br>`UQ(resource_type, resource_id, principal_type, principal_id)`<br>`IX(principal_id, principal_type) incl.`<br>`IX(workspace_id) WHERE workspace_id IS NOT NULL`<br>`IX(expires_at) WHERE expires_at IS NOT NULL` |
| 18 | `invitations` | Pending invites to org/workspace/base/interface | email_normalized, role, token_hash, status, expires_at | org_id → organizations; resource polymorphic |  | `PK(id)`<br>`UQ(token_hash)`<br>`UQ(resource_type, resource_id, email_normalized) WHERE status = 'pending'`<br>`IX(email_normalized) WHERE status = 'pending'`<br>`IX(org_id, created_at DESC)` |
| 19 | `oauth_clients` | Third-party apps registered for OAuth | client_key, is_confidential, client_secret_hash, redirect_uris, allowed_scopes | org_id → organizations; owner_user_id → users (SET NULL); ← oauth_grants, oauth_authorization_codes |  | `PK(id)`<br>`UQ(client_key)`<br>`IX(org_id) WHERE org_id IS NOT NULL` |
| 20 | `oauth_grants` | User consent + refresh token family per client | scopes, resource_restrictions, family_id, refresh_token_hash, previous_refresh_token_hash | client_id → oauth_clients; user_id → users; ← api_tokens (oauth_access) |  | `PK(id)`<br>`UQ(refresh_token_hash) WHERE refresh_token_hash IS NOT NULL`<br>`IX(previous_refresh_token_hash) WHERE previous_refresh_token_hash IS NOT NULL`<br>`UQ(user_id, client_id) WHERE status = 'active'`<br>`IX(family_id)` |
| 21 | `oauth_authorization_codes` | Short-lived PKCE authorization codes | code_hash, code_challenge, redirect_uri, expires_at, consumed_at | client_id → oauth_clients; user_id → users |  | `PK(code_hash)`<br>`IX(expires_at)` |
| 22 | `api_tokens` | PATs, service-account tokens, OAuth access tokens (hashed secret) | kind, secret_hash, hash_version, display_hint, scopes, resource_restrictions, expires_at, status | user_id → users; service_account_id → service_accounts; oauth_grant_id → oauth_grants; org_id → organizations |  | `PK(id)`<br>`IX(user_id) WHERE status = 'active' AND kind = 'pat'`<br>`IX(service_account_id) WHERE service_account_id IS NOT NULL AND status = 'active'`<br>`IX(oauth_grant_id) WHERE oauth_grant_id IS NOT NULL`<br>`IX(org_id) WHERE org_id IS NOT NULL`<br>`IX(expires_at) WHERE status = 'active' AND expires_at IS NOT NULL` |
| 23 | `sso_connections` | SAML/OIDC config per org (Jackson tenant ref) | protocol, jackson_tenant/product, status, enforce, jit_provisioning, attribute_mapping | org_id → organizations; ← user_identities |  | `PK(id)`<br>`IX(org_id) WHERE status = 'active'`<br>`UQ(jackson_tenant, jackson_product)` |
| 24 | `scim_directories` | SCIM endpoint bearer tokens per org | token_hash, status, deprovision_mode | org_id → organizations; ← scim_group_mappings |  | `PK(id)`<br>`UQ(token_hash)`<br>`IX(org_id)` |
| 25 | `scim_group_mappings` | SCIM group ↔ team mapping | external_group_id, display_name | scim_directory_id → scim_directories; team_id → teams; org_id → organizations |  | `PK(id)`<br>`UQ(scim_directory_id, external_group_id)`<br>`UQ(team_id)` |
| 26 | `plans` | Plan catalog + limits (versioned) | key, version, limits, features, retired_at | ← subscriptions (RESTRICT) |  | `PK(id)`<br>`UQ(key, version)`<br>`UQ(key) WHERE retired_at IS NULL` |
| 27 | `subscriptions` | Org ↔ plan, billing provider refs, seats, status | status, provider_subscription_id, seats_purchased/used, limit_overrides, current_period_* | org_id → organizations; plan_id → plans (RESTRICT) |  | `PK(id)`<br>`UQ(org_id) WHERE status IN ('trialing','active','past_due','paused','incomplete')`<br>`UQ(billing_provider, provider_subscription_id) WHERE provider_subscription_id IS NOT NULL; -- ---------------------------------------------------------------------------- -- core.usage_counters — current-period aggregates per org/metric (limit checks). -- Q: (org, metric, period) point read on every metered action (cached, write-behind)` |
| 28 | `usage_counters` | Current-period aggregated usage per org/metric | metric, period_start/end, value, limit_value, threshold_notified | org_id → organizations |  | `PK(org_id, metric, period_start)` |
| 29 | `usage_events` | Raw metering events (monthly partitions) | metric, quantity, source, source_event_id, occurred_at | org_id/workspace_id/base_id by UUID (no FK; partitioned) | RANGE(occurred_at) | `PK(id, occurred_at)`<br>`UQ(metric, source_event_id, occurred_at)`<br>`IX(org_id, occurred_at)`<br>`BRIN(occurred_at)` |
| 30 | `notifications` | In-app notifications (monthly partitions) | user_id, category, title, body, resource_type/id, group_key, read_at, archived_at, source_event_id | user_id → users (CASCADE); ← notification_deliveries (by id+created_at, no FK) | RANGE(created_at) | `PK(id, created_at)`<br>`IX(user_id, created_at DESC) WHERE archived_at IS NULL`<br>`IX(user_id) WHERE read_at IS NULL AND archived_at IS NULL`<br>`IX(user_id, group_key, created_at DESC) WHERE group_key IS NOT NULL`<br>`UQ(user_id, source_event_id, created_at) WHERE source_event_id IS NOT NULL` |
| 31 | `notification_preferences` | Per user × scope × category × channel settings | scope_type, scope_id, category, channel, setting | user_id → users (CASCADE) |  | `PK(id)`<br>`UQ(user_id, scope_type, scope_id, category, channel) NND` |
| 32 | `notification_deliveries` | Email/push/Slack delivery attempts (monthly partitions) | channel, status, provider, provider_message_id, attempt, next_attempt_at | notification_id/notification_created_at → notifications (logical, no FK) | RANGE(created_at) | `PK(id, created_at)`<br>`IX(provider, provider_message_id) WHERE provider_message_id IS NOT NULL`<br>`IX(next_attempt_at) WHERE status IN ('queued','failed') AND next_attempt_at IS NOT NULL`<br>`IX(notification_id) WHERE notification_id IS NOT NULL`<br>`IX(user_id, created_at DESC)` |
| 33 | `email_suppressions` | Bounce/complaint suppression list | email_normalized, reason, expires_at | standalone (checked before every send) |  | `PK(email_normalized)` |
| 34 | `templates` | Template gallery metadata (+ snapshot in S3) | slug, visibility, category, tags, snapshot_object_key, status, use_count | org_id → organizations (org-private templates); source_base_id → data.bases (cross-plane) |  | `PK(id)`<br>`UQ(org_id, slug) NND`<br>`IX(category, use_count DESC) WHERE status = 'published' AND visibility = 'public'`<br>`GIN(tags)` |
| 35 | `feature_flags` | Flag definitions + targeting rules | key, kind, default_value, rules, status | standalone |  | `PK(key)` |
| 36 | `support_access_grants` | Time-boxed customer-approved staff access | staff_principal, access_level, reason, starts_at, expires_at, revoked_at | org_id → organizations; approved_by_user_id → users (RESTRICT) |  | `PK(id)`<br>`IX(org_id, staff_principal, expires_at) WHERE revoked_at IS NULL` |
| 37 | `rate_limit_overrides` | Custom rate limits per org/token/client/base | scope_type, scope_id, policy, expires_at | org_id → organizations; scope polymorphic |  | `PK(id)`<br>`UQ(scope_type, scope_id)` |
| 38 | `public_link_directory` | [Proposed] Global routing of share-link / inbound-webhook tokens to workspace+shard | token_hash, kind, object_id, workspace_id, base_id, status | org_id → organizations; workspace_id → workspaces; object_id → data.share_links / data.inbound_webhooks (cross-plane) |  | `PK(token_hash)`<br>`UQ(kind, object_id)`<br>`IX(workspace_id)` |
| 39 | `workspace_migrations` | [Proposed] Online workspace shard-move state machine | source/target_shard_id, phase, slot_name, snapshot_lsn, verification | workspace_id → workspaces; shards (×2); org_id → organizations |  | `PK(id)`<br>`UQ(workspace_id) WHERE phase NOT IN ('done','failed','aborted')` |

### 58.2 Data plane — schema `data` (every shard)

| # | Table | Purpose | Important columns | Relationships | Partitioning | Indexes |
|---|---|---|---|---|---|---|
| 1 | `bases` | Base metadata, settings, soft delete (cold row) | kind (standard/contact_directory), name, settings, schema_version, storage_bytes, write_fenced | parent of tables, fields, views, interfaces, automations…; 1:1 base_runtime; mirrors core.base_directory |  | `PK(id)`<br>`IX(workspace_id) WHERE deleted_at IS NULL`<br>`UQ(workspace_id) WHERE kind = 'contact_directory' AND deleted_at IS NULL`<br>`IX(workspace_id, deleted_at) WHERE deleted_at IS NOT NULL` |
| 2 | `base_runtime` | Hot per-base counters: change_seq, perm_epoch, schema_version | change_seq, perm_epoch, schema_version, automation_index_version, record_count | base_id → bases (1:1, CASCADE) |  | `PK(base_id)` |
| 3 | `tables` | Table metadata and per-table counters | kind, primary_field_id, next_field_slot, next_row_number, record_count, restrictions, sidecars_enabled | base_id → bases; primary_field_id → fields (deferrable); sync_source_id → sync_sources |  | `PK(id)`<br>`IX(base_id, order_key) WHERE deleted_at IS NULL`<br>`UQ(base_id, lower(name)) WHERE deleted_at IS NULL`<br>`UQ(base_id) WHERE kind = 'contacts' AND deleted_at IS NULL`<br>`IX(deletion_batch_id) WHERE deletion_batch_id IS NOT NULL` |
| 4 | `fields` | Field metadata: slot, type, config, restrictions | slot (never reused), type, config, config_schema_version, restrictions, index_state, conversion | table_id → tables; base_id → bases; ← field_dependencies, link_relations |  | `PK(id)`<br>`UQ(table_id, slot)`<br>`UQ(table_id, lower(name)) WHERE deleted_at IS NULL`<br>`IX(base_id) WHERE deleted_at IS NULL`<br>`IX(table_id) WHERE index_state IN ('backfilling','rebuilding','dropping')`<br>`IX(deletion_batch_id) WHERE deletion_batch_id IS NOT NULL`<br>`IX(config_schema_version)` |
| 5 | `field_dependencies` | Edges of the field-level dependency graph | field_id, depends_on_field_id, via_link_field_id, kind | all three → fields (CASCADE); base_id → bases |  | `PK(id)`<br>`UQ(field_id, depends_on_field_id, via_link_field_id) NND`<br>`IX(depends_on_field_id)`<br>`IX(base_id)` |
| 6 | `link_relations` | One row per bidirectional link (side A ↔ side B) with cardinality | kind, a_table_id, a_field_id, b_base_id, b_table_id, b_field_id, cardinality | tables ×2, fields ×2 (RESTRICT, deferrable), bases ×2; ← record_links (logical) |  | `PK(id)`<br>`UQ(a_field_id)`<br>`UQ(b_field_id) WHERE b_field_id IS NOT NULL`<br>`IX(base_id) WHERE deleted_at IS NULL`<br>`IX(b_table_id)` |
| 7 | `records` | Record rows: cells/computed/cell_meta JSONB (HASH table_id × 64) | table_id, id, row_number, manual_order, cells, computed, cell_meta, version, last_change_seq, deleted_at, deletion_batch_id | table_id → tables (logical, no FK); ← record_links, sidecars, comments, attachments (logical) | HASH(table_id) | `PK(table_id, id)`<br>`UQ(table_id, row_number)`<br>`IX(table_id, manual_order, id) WHERE deleted_at IS NULL`<br>`IX(table_id, created_at, id) WHERE deleted_at IS NULL`<br>`IX(table_id, deletion_batch_id) WHERE deleted_at IS NOT NULL`<br>`UQ(table_id, external_ref) WHERE external_ref IS NOT NULL AND deleted_at IS NULL` |
| 8 | `record_links` | Link edges (HASH relation_id × 32) | relation_id, a_record_id, b_record_id, a_order, b_order, deletion_batch_id | relation_id → link_relations; a/b_record_id → records (logical, no FK) | HASH(relation_id) | `PK(relation_id, a_record_id, b_record_id)`<br>`IX(relation_id, a_record_id, a_order) incl. WHERE deletion_batch_id IS NULL`<br>`IX(relation_id, b_record_id, b_order) incl. WHERE deletion_batch_id IS NULL`<br>`IX(deletion_batch_id) WHERE deletion_batch_id IS NOT NULL` |
| 9 | `record_index_num` | Typed numeric index sidecar (HASH table_id × 32) | table_id, field_slot, record_id, ord, value numeric | (table_id, record_id) → records; (table_id, field_slot) → fields (logical) | HASH(table_id) | `PK(table_id, field_slot, record_id, ord)`<br>`IX(table_id, field_slot, value, record_id)` |
| 10 | `record_index_text` | Typed text index sidecar: collation sort key + equality form | field_slot, ord, sort_key bytea, value_eq, flags | as record_index_num | HASH(table_id) | `PK(table_id, field_slot, record_id, ord)`<br>`IX(table_id, field_slot, sort_key, record_id)`<br>`IX(table_id, field_slot, value_eq)`<br>`GIN(table_id, field_slot, value_eq gin_trgm_ops) WHERE (flags & 1) = 1` |
| 11 | `record_index_time` | Typed timestamp index sidecar | field_slot, ord, value timestamptz | as record_index_num | HASH(table_id) | `PK(table_id, field_slot, record_id, ord)`<br>`IX(table_id, field_slot, value, record_id)` |
| 12 | `record_rich_docs` | Yjs CRDT state for rich long-text cells (V1+) | ydoc_state, state_vector, pending_updates, doc_version | (table_id, record_id, field_slot) → records/fields (logical) |  | `PK(table_id, record_id, field_slot)` |
| 13 | `record_revisions` | Cell-level record history (monthly partitions) | record_id, change_seq, kind, changed_slots, before, after, actor_type, actor_id, via | record → records, change_seq → base_changes (logical) | RANGE(created_at) | `PK(id, created_at)`<br>`IX(table_id, record_id, created_at DESC)`<br>`IX(workspace_id, created_at)`<br>`BRIN(created_at)` |
| 14 | `computed_stale` | Markers for deferred recompute | table_id, record_id, field_id, reason, attempts, enqueued_at | records / fields (logical) |  | `PK(table_id, record_id, field_id)`<br>`IX(base_id, enqueued_at)` |
| 15 | `view_sections` | Sidebar folders for views | name, order_key, owner_user_id | table_id → tables; base_id → bases; ← views (SET NULL) |  | `PK(id)`<br>`IX(table_id, order_key) WHERE deleted_at IS NULL` |
| 16 | `views` | View metadata + typed config document | type, visibility, owner_user_id, config, config_schema_version, order_key, version, is_default | table_id → tables; section_id → view_sections; ← view_user_state, view_record_orders, share_links (logical) |  | `PK(id)`<br>`IX(table_id, order_key) WHERE deleted_at IS NULL`<br>`IX(base_id) WHERE deleted_at IS NULL`<br>`UQ(table_id, owner_user_id, lower(name)) NND WHERE deleted_at IS NULL`<br>`UQ(table_id) WHERE is_default AND deleted_at IS NULL`<br>`GIN((config -> 'refs') jsonb_path_ops)`<br>`IX(deletion_batch_id) WHERE deletion_batch_id IS NOT NULL` |
| 17 | `view_user_state` | Per-user view overrides (widths, scroll, collapsed groups) | state jsonb | view_id → views (CASCADE); user_id → core.users (cross-plane) |  | `PK(view_id, user_id)`<br>`IX(user_id)` |
| 18 | `interfaces` | Interface app metadata (draft/published pointers) | status, draft_revision, published_version_id, settings, version | base_id → bases; published_version_id → interface_versions; ← interface_pages |  | `PK(id)`<br>`IX(base_id, order_key) WHERE deleted_at IS NULL` |
| 19 | `interface_pages` | Draft pages; layout = element tree (elm_ ids inside JSON) | page_type, layout, layout_schema_version, parent_page_id, order_key | interface_id → interfaces (CASCADE); parent_page_id → interface_pages |  | `PK(id)`<br>`IX(interface_id, order_key) WHERE deleted_at IS NULL`<br>`IX(layout_schema_version)` |
| 20 | `interface_versions` | Immutable published interface snapshots | version_no, snapshot, snapshot_schema_version, schema_version_at_publish | interface_id → interfaces (CASCADE) |  | `PK(id)`<br>`UQ(interface_id, version_no)` |
| 21 | `automations` | Automation metadata, status, draft definition | status, draft_definition, draft_revision, published_version_id, settings, run_as_user_id, disabled_reason | base_id → bases; published_version_id → automation_versions; ← schedules, inbound_webhooks, runs (logical) |  | `PK(id)`<br>`IX(base_id, order_key) WHERE deleted_at IS NULL`<br>`IX(base_id) WHERE status = 'active'` |
| 22 | `automation_versions` | Immutable published automation definitions | version_no, is_test, definition, compiled, references, trigger_type, trigger_table_id | automation_id → automations (CASCADE); ← automation_schedules; runs (logical) |  | `PK(id)`<br>`UQ(automation_id, version_no) WHERE version_no IS NOT NULL`<br>`GIN("references" jsonb_path_ops)`<br>`IX(trigger_table_id) WHERE trigger_table_id IS NOT NULL` |
| 23 | `automation_runs` | One row per triggered run (monthly partitions on trigger_at) | run_key, trigger_event_id, trigger_at, status, causation_depth, lease_*, deadline_at | automation_id, automation_version_id (logical); ← automation_step_runs (logical) | RANGE(trigger_at) | `PK(id, trigger_at)`<br>`UQ(automation_id, run_key, trigger_at)`<br>`IX(automation_id, trigger_at DESC)`<br>`IX(lease_expires_at) WHERE status IN ('queued','admitted','running')`<br>`IX(base_id, trigger_at DESC)` |
| 24 | `automation_step_runs` | Per-step executions (monthly partitions on trigger_at) | run_id, step_id, step_path, iteration, status, attempt, idempotency_key, input, output, lease_* | run_id + trigger_at → automation_runs (logical); ai_invocation_id → ai_invocations (logical) | RANGE(trigger_at) | `PK(id, trigger_at)`<br>`UQ(run_id, step_path, iteration, trigger_at)`<br>`IX(run_id, trigger_at)`<br>`IX(lease_expires_at) WHERE status IN ('queued','running')`<br>`IX(next_attempt_at) WHERE status = 'waiting_retry'`<br>`IX(idempotency_key)` |
| 25 | `automation_schedules` | Next-fire times for scheduled triggers | kind, spec, time_zone, misfire_policy, next_fire_at | automation_id → automations (1:1); automation_version_id → automation_versions |  | `PK(automation_id)`<br>`IX(next_fire_at) WHERE status = 'active'` |
| 26 | `inbound_webhooks` | Endpoints that trigger automations | url_token_hash, signature_scheme, secret_ciphertext/key_id/dek_ciphertext, status | automation_id → automations; base_id → bases; ↔ core.public_link_directory |  | `PK(id)`<br>`UQ(url_token_hash)`<br>`IX(automation_id)` |
| 27 | `webhook_subscriptions` | Outbound API webhooks (spec, cursor, signing secret) | notification_url, spec, cursor_seq, status, expires_at, secret_ciphertext | base_id → bases; created_by_token_id → core.api_tokens (cross-plane); ← webhook_deliveries (logical) |  | `PK(id)`<br>`IX(base_id) WHERE status = 'active'`<br>`IX(expires_at) WHERE status = 'active'`<br>`IX(created_by_token_id) WHERE created_by_token_id IS NOT NULL`<br>`GIN(spec jsonb_path_ops)` |
| 28 | `webhook_deliveries` | Outbound delivery attempts (monthly partitions) | subscription_id, seq_from, seq_to, attempt, status, http_status, next_attempt_at | subscription_id → webhook_subscriptions (logical) | RANGE(created_at) | `PK(id, created_at)`<br>`IX(subscription_id, created_at DESC)`<br>`IX(next_attempt_at) WHERE status = 'retrying'` |
| 29 | `integration_connections` | Connected external accounts (envelope-encrypted credentials) | provider, auth_type, scopes, credential_ciphertext, key_id, dek_ciphertext, dek_version, status, token_expires_at | workspace-scoped; ← sync_sources (SET NULL); referenced by automation definitions by id |  | `PK(id)`<br>`IX(workspace_id, provider) WHERE deleted_at IS NULL`<br>`IX(token_expires_at) WHERE status = 'active' AND token_expires_at IS NOT NULL`<br>`IX(workspace_id, dek_version)` |
| 30 | `secrets` | Workspace/base secrets for automations & scripts (envelope-encrypted) | name, ciphertext, key_id, dek_ciphertext, dek_version | base_id → bases (nullable = workspace-level) |  | `PK(id)`<br>`UQ(workspace_id, base_id, lower(name)) NND WHERE deleted_at IS NULL`<br>`IX(workspace_id, dek_version)` |
| 31 | `attachments` | Attachment occurrence metadata (object key, mime, size, scan status) | owner_kind, record_id, field_id, blob_id, object_key, filename, status, sha256, size_bytes | base_id → bases; record/field/comment (logical); blob_id → attachment_blobs (proposed); ← attachment_variants |  | `PK(id)`<br>`IX(record_id) WHERE record_id IS NOT NULL`<br>`IX(blob_id) WHERE blob_id IS NOT NULL`<br>`IX(base_id, status, created_at) WHERE status IN ('pending_upload','uploaded','scanning','processing')`<br>`IX(purge_after) WHERE purge_after IS NOT NULL AND deleted_at IS NULL`<br>`IX(comment_id) WHERE comment_id IS NOT NULL` |
| 32 | `attachment_variants` | Thumbnails/previews/posters | variant, object_key, mime, width, height, status | attachment_id → attachments (CASCADE) or blob_id → attachment_blobs |  | `PK(id)`<br>`UQ(attachment_id, variant) WHERE attachment_id IS NOT NULL`<br>`UQ(blob_id, variant) WHERE blob_id IS NOT NULL` |
| 33 | `comments` | Record (and field-anchored) comments, one-level threads | record_id, parent_id, anchor, body, body_plain, author_id, reply_count, resolved_at | base_id → bases; parent_id → comments (CASCADE); record (logical); ← comment_reactions, mentions |  | `PK(id)`<br>`IX(record_id, created_at, id)`<br>`IX(parent_id, created_at) WHERE parent_id IS NOT NULL`<br>`IX(base_id, created_at DESC)`<br>`IX(record_id) WHERE deleted_at IS NULL AND parent_id IS NULL`<br>`UQ(author_id, client_id) WHERE client_id IS NOT NULL` |
| 34 | `comment_reactions` | Emoji reactions | emoji, user_id | comment_id → comments (CASCADE) |  | `PK(comment_id, user_id, emoji)` |
| 35 | `mentions` | Parsed mentions (user/team/record/contact) from comments & long text | source_type, source_id, field_id, target_type, target_id, access_state | source → comments / records (logical); target polymorphic |  | `PK(id)`<br>`UQ(source_type, source_id, field_id, target_type, target_id) NND`<br>`IX(target_type, target_id, created_at DESC)` |
| 36 | `record_subscriptions` | Users watching a record | record_id, user_id, reason, muted | record (logical); user_id → core.users (cross-plane) |  | `PK(record_id, user_id)`<br>`IX(user_id, base_id)` |
| 37 | `contact_identifiers` | Normalized emails/phones/handles for contacts | contact_id, kind, provider, value_norm, is_primary, verified_at | contact_id → records in contacts table (logical) |  | `PK(id)`<br>`IX(workspace_id, kind, provider, value_norm) WHERE deleted_at IS NULL`<br>`IX(contact_id) WHERE deleted_at IS NULL`<br>`UQ(contact_id, kind) WHERE is_primary AND deleted_at IS NULL` |
| 38 | `contact_merge_events` | Contact merge history for unmerge/audit | survivor_contact_id, merged_contact_ids, field_resolution, pre_merge_snapshot, status | contacts (logical) |  | `PK(id)`<br>`IX(survivor_contact_id, created_at DESC)`<br>`GIN(merged_contact_ids)` |
| 39 | `contact_activities` | Contact timeline items | contact_id, kind, occurred_at, actor, source_record_id, summary, payload, source_event_id | contact_id → contacts records (logical) |  | `PK(id)`<br>`IX(contact_id, occurred_at DESC, id) WHERE deleted_at IS NULL`<br>`UQ(source_event_id) WHERE source_event_id IS NOT NULL`<br>`BRIN(created_at)` |
| 40 | `share_links` | Public/restricted share tokens for views/forms/interfaces/bases | resource_type, resource_id, token_hash, access, password_hash, permissions, status, expires_at | base_id → bases; resource polymorphic; ↔ core.public_link_directory |  | `PK(id)`<br>`UQ(token_hash)`<br>`IX(resource_type, resource_id) WHERE status = 'active'`<br>`IX(base_id)` |
| 41 | `base_changes` | Per-base ordered change log with forward + inverse ops (daily partitions, 30 d) | base_id, seq, ops, inverse_ops, actor_type, actor_id, via, client_mutation_id, reverts_seq | seq allocated from base_runtime.change_seq; referenced by revisions, webhooks (logical) | RANGE(created_at) | `PK(base_id, seq, created_at)`<br>`IX(base_id, client_mutation_id) WHERE client_mutation_id IS NOT NULL`<br>`IX(base_id, actor_id, seq DESC) WHERE actor_id IS NOT NULL` |
| 42 | `outbox_events` | Transactional outbox (daily partitions, 3 d; logical replication) | event_type, topic, partition_key, aggregate_type/id, base_seq, actor, payload | consumed by relay; no FKs | RANGE(created_at) | `PK(id, created_at)` |
| 43 | `idempotency_keys` | API idempotency records (24 h) | principal_id, key, request_hash, status, response_status, response_body, expires_at | standalone |  | `PK(workspace_id, principal_id, key)`<br>`IX(expires_at)` |
| 44 | `deletion_batches` | Trash entries grouping soft-deleted objects | root_type, root_id, object_count, status, purge_after | ← deletion_batch_id on records, record_links, tables, fields, views, … |  | `PK(id)`<br>`IX(base_id, deleted_at DESC) WHERE status = 'trashed'`<br>`IX(workspace_id, deleted_at DESC) WHERE status = 'trashed'`<br>`IX(purge_after) WHERE status = 'trashed'` |
| 45 | `base_snapshots` | Point-in-time base snapshot metadata (data in S3) | kind, status, change_seq, object_key, size_bytes, expires_at | base_id → bases (CASCADE); long_operation_id (logical) |  | `PK(id)`<br>`IX(base_id, created_at DESC)`<br>`IX(expires_at) WHERE status = 'completed' AND expires_at IS NOT NULL` |
| 46 | `long_operations` | User-visible async tasks with progress and leases | kind, status, params, progress_done/total, result, error, lease_* | ← import_jobs, export_jobs (SET NULL) |  | `PK(id)`<br>`IX(base_id, created_at DESC)`<br>`IX(lease_expires_at) WHERE status IN ('queued','running','cancelling')`<br>`UQ(workspace_id, idempotency_key) WHERE idempotency_key IS NOT NULL` |
| 47 | `import_jobs` | Import configuration, mapping, result summary | source_kind, mapping, options, status, rows_* | base_id → bases; long_operation_id → long_operations; ← import_errors |  | `PK(id)`<br>`IX(base_id, created_at DESC)` |
| 48 | `import_errors` | Row-level import errors | source_row, column_ref, code, message, raw | import_job_id → import_jobs (CASCADE) |  | `PK(id)`<br>`IX(import_job_id, source_row)` |
| 49 | `export_jobs` | Export configuration & result object | format, options, status, object_key, expires_at | base_id → bases; long_operation_id → long_operations |  | `PK(id)`<br>`IX(base_id, created_at DESC)` |
| 50 | `sync_sources` | External data source sync configs (sync tables) | provider, config, direction, schedule, status, cursor, next_run_at | base_id → bases; target_table_id → tables; integration_connection_id → integration_connections; ← sync_runs |  | `PK(id)`<br>`IX(next_run_at) WHERE status = 'active'`<br>`IX(base_id)` |
| 51 | `sync_runs` | Sync executions | trigger, status, records_created/updated/deleted, stats | sync_source_id → sync_sources (CASCADE) |  | `PK(id)`<br>`IX(sync_source_id, started_at DESC)` |
| 52 | `ai_prompt_templates` | Versioned prompt templates (system rows have workspace_id NULL) | key, version, purpose, system_prompt, user_prompt_template, model_policy, status | referenced by ai_invocations.template_id (logical) |  | `PK(id)`<br>`UQ(workspace_id, key, version) NND`<br>`UQ(workspace_id, key) NND WHERE status = 'active'` |
| 53 | `ai_invocations` | Every AI call: model, tokens, cost, latency (monthly partitions) | feature, provider, model, input_hash, tokens, cost_micros, status, record/field, idempotency_key | template, record, automation run (logical) | RANGE(created_at) | `PK(id, created_at)`<br>`IX(table_id, record_id, field_id, created_at DESC) WHERE record_id IS NOT NULL`<br>`IX(workspace_id, created_at)`<br>`IX(input_hash, created_at DESC) WHERE status = 'ok'`<br>`UQ(idempotency_key, created_at) WHERE idempotency_key IS NOT NULL`<br>`BRIN(created_at)` |
| 54 | `search_documents` | MVP Postgres FTS documents (HASH base_id × 32) | doc_key, doc_type, entity_id, title, all_text, restricted_text, tsv (generated), source_seq | entity polymorphic (logical) | HASH(base_id) | `PK(base_id, doc_key)`<br>`GIN(tsv)`<br>`GIN(data.f_unaccent(lower(title)) gin_trgm_ops)`<br>`IX(base_id, doc_type, table_id) WHERE NOT deleted` |
| 55 | `workspace_keys` | [Proposed] Per-workspace DEK registry (KMS-wrapped) | dek_version, kms_key_id, dek_ciphertext, status | referenced by dek_version on encrypted rows |  | `PK(workspace_id, dek_version)`<br>`UQ(workspace_id) WHERE status = 'active'` |
| 56 | `attachment_blobs` | [Proposed, 18] Content-addressed blobs per workspace | sha256, size_bytes, object_key, ref_count, snapshot_pins | ← attachments.blob_id, attachment_variants.blob_id |  | `PK(id)`<br>`UQ(workspace_id, sha256)`<br>`IX(purge_pending_at) WHERE purge_pending_at IS NOT NULL` |
| 57 | `view_record_orders` | [Proposed, 10] Per-view manual record order | scope_key, record_id, order_key | view_id → views (CASCADE) |  | `PK(view_id, scope_key, record_id)`<br>`IX(view_id, scope_key, order_key)` |
| 58 | `view_watches` | [Proposed, 10] Watch definitions for enter/leave-view triggers | view_id or inline_filter, automation_id, last_seq, status | base_id → bases; view_id → views; automation_id → automations |  | `PK(id)`<br>`IX(table_id) WHERE status = 'active'` |
| 59 | `view_match_state` | [Proposed, 10] Current membership set per watch | record_id, matched_at | watch_id → view_watches (CASCADE) |  | `PK(watch_id, record_id)` |
| 60 | `relay_checkpoints` | [Proposed, 15] Relay LSN checkpoint per shard (infrastructure) | slot_name, confirmed_lsn, base_seq_watermarks | standalone; no RLS |  | `PK(shard_id)` |

### 58.2a Tables adopted in the reconciliation pass

DDL is in [05 §7.18](05-sql-schema.md). Together with the tables above, these make up the full set of **117 tables**.

| Schema | Table | Purpose | Important columns | Relationships | Partitioning | Indexes |
|---|---|---|---|---|---|---|
| `global` | `login_directory` | Route a login email to the user's home region | email_hash, user_id, home_region, sso_org_hint | user by UUID (cross-region) |  | `PK(email_hash)` |
| `global` | `domain_directory` | Verified domain → org/region, SSO enforcement at login | domain, org_id, home_region, sso_enforced | org by UUID |  | `PK(domain)` |
| `core` | `outbox_events` | Control-plane transactional outbox | event_type, partition_key, aggregate_*, actor, payload | read by core relay (logical replication) | RANGE(created_at) daily, 3 d | `PK(id, created_at)` |
| `core` | `relay_checkpoints` | Control-plane relay LSN checkpoint | relay_name, slot_name, confirmed_lsn | standalone; no RLS |  | `PK(relay_name)` |
| `core` | `idempotency_keys` | Idempotency for control-plane mutations | org_id, principal_id, key, request_hash, status, response_* | org by UUID |  | `PK(org_id, principal_id, key)`<br>`IX(expires_at)` |
| `core` | `org_encryption_keys` | BYOK customer CMK references | org_id, region, kms_key_arn, status | → organizations |  | `PK(id)`<br>`UQ(org_id, region) WHERE active` |
| `core` | `connectors` | Connector registry | slug, publisher, trust_tier, owner_org_id, status | → organizations (private) |  | `PK(id)`<br>`UQ(slug)` |
| `core` | `connector_versions` | Versioned connector manifests and bundles | version, manifest, bundle_*, review_status | → connectors |  | `PK(connector_id, version)` |
| `core` | `migration_runs` | Shard migration orchestrator state | migration_name, plane, target, wave, status | standalone |  | `PK(id)`<br>`UQ(migration_name, target)` |
| `core` | `privacy_erasure_ledger` | GDPR erasures that are re-applied after any restore | workspace_id, subject_kind, subject_hash, scope, status | workspace by UUID |  | `PK(id)`<br>`IX(workspace_id, requested_at)` |
| `data` | `schema_revisions` | Schema/config history (fields, views, pages, automations) | object_type, object_id, change_seq, action, before, after | base by UUID | RANGE(created_at) monthly | `PK(id, created_at)`<br>`IX(object_id, created_at)`<br>`IX(base_id, created_at)` |
| `data` | `contact_duplicate_candidates` | Contact dedup review queue | contact_a_id, contact_b_id, score, signals, status | contacts by UUID |  | `PK(id)`<br>`UQ(a, b)`<br>`IX(workspace_id, score) WHERE open` |
| `data` | `integration_trigger_states` | Polling cursors and provider webhook registrations | connection_id, automation_id, trigger_key, mode, cursor, next_poll_at | → integration_connections, automations |  | `PK(id)`<br>`UQ(connection_id, automation_id, trigger_key)`<br>`IX(next_poll_at) WHERE polling` |
| `data` | `interface_user_state` | Per-user interface state (V1) | interface_id, user_id, state | → interfaces |  | `PK(interface_id, user_id)` |
| `data` | `ai_agent_sessions` | AI agent runs with approval gating | started_by_*, model, status, step_count, pending_approval, cost_micros | automation_run by UUID |  | `PK(id)`<br>`IX(workspace_id, created_at)` |
| `data` | `ai_feedback` | Thumbs and corrections on AI outputs (eval data) | invocation_id, user_id, rating, correction | ai_invocations by UUID |  | `PK(id)`<br>`UQ(invocation_id, user_id)` |

### 58.3 Audit store — schema `audit`

| # | Table | Purpose | Important columns | Relationships | Partitioning | Indexes |
|---|---|---|---|---|---|---|
| 1 | `audit_events` | Security & admin audit trail (monthly; hot 90 d → S3 Parquet) | event_id, org_id, event_type, category, outcome, actor_*, ip, resource_type/id, details | org/workspace/base by UUID (cross-store, no FK) | RANGE(occurred_at) | `PK(id, occurred_at)`<br>`UQ(event_id, occurred_at)`<br>`IX(org_id, occurred_at DESC, id)`<br>`IX(org_id, actor_id, occurred_at DESC)`<br>`IX(org_id, resource_type, resource_id, occurred_at DESC)`<br>`IX(org_id, event_type, occurred_at DESC)`<br>`BRIN(occurred_at)` |
| 2 | `audit_exports` | SIEM streaming/export configs & checkpoints | kind, config, credential_ciphertext/key_id/dek_ciphertext, status, checkpoint_* | org_id (cross-store) |  | `PK(id)`<br>`IX(org_id)`<br>`IX(status) WHERE status = 'active'` |


---

## 59. Object hierarchy

### 59.1 Tenant and content hierarchy

Legend: `[C]` control plane `core.*` · `[D]` data plane `data.*` (on the workspace's shard) · `[A]` audit store · `[S3]` object storage · `[R]` Redis (cache only) · `(json)` = lives inside a JSONB document, not a row · public ID prefix in `‹›`.

```text
Organization ‹org›                                   [C] organizations
├── Verified domains                                 [C] organization_domains
├── Policies (sharing, AI, retention, IP, session…)  [C] organization_policies
├── Members (org role)                               [C] organization_members → users
├── Teams ‹tem›                                      [C] teams
│   └── Team members                                 [C] team_members
├── Service accounts ‹svc›                           [C] service_accounts
│   └── Service-account tokens ‹tok›                 [C] api_tokens (kind=service_account)
├── SSO connections                                  [C] sso_connections (→ Jackson tenant)
├── SCIM directories                                 [C] scim_directories
│   └── Group mappings → teams                       [C] scim_group_mappings
├── Subscription → Plan                              [C] subscriptions → plans
├── Usage counters / raw usage events                [C] usage_counters, usage_events
├── OAuth client apps owned by the org ‹app›         [C] oauth_clients
├── Org-private templates ‹tpl›                      [C] templates (visibility=org) + [S3] tabula-snapshots
├── Support access grants                            [C] support_access_grants
├── Rate-limit overrides                             [C] rate_limit_overrides
├── Dedicated shard(s) (Enterprise)                  [C] shards.dedicated_org_id
├── Audit log                                        [A] audit_events (+ [S3] tabula-audit-archive)
│   └── SIEM exports                                 [A] audit_exports
├── Grants at org scope                              [C] access_grants (resource_type=org)
├── Invitations (org/workspace/base/interface) ‹inv› [C] invitations
└── Workspace ‹wsp›                                  [C] workspaces
    ├── Routing → shard                              [C] workspace_directory → shards
    ├── Shard moves                                  [C] workspace_migrations [Proposed]
    ├── Grants at workspace scope                    [C] access_grants (resource_type=workspace)
    ├── Encryption keys (DEK per workspace)          [D] workspace_keys [Proposed]
    ├── Integration connections ‹con›                [D] integration_connections
    ├── Secrets (workspace-level) ‹sct›              [D] secrets (base_id NULL)
    ├── Custom AI prompt templates ‹tpl›             [D] ai_prompt_templates (workspace_id set)
    ├── Contacts directory (one per workspace)       [D] bases (kind=contact_directory)
    │   └── Contacts table                           [D] tables (kind=contacts)
    │       └── Contact ‹ctc›                        [D] records (rows of the contacts table)
    │           ├── Identifiers (email/phone/handles)[D] contact_identifiers
    │           ├── Activity timeline                [D] contact_activities
    │           ├── Merge history                    [D] contact_merge_events
    │           └── Linked from any base (contact fields)  [D] link_relations (kind=contact) + record_links
    ├── Trash entries (workspace & base level)       [D] deletion_batches
    └── Base ‹bas›                                   [D] bases  ↔ [C] base_directory (routing + listing)
        ├── Runtime counters (change_seq, perm_epoch, schema_version)  [D] base_runtime
        ├── Grants at base scope / interface_only    [C] access_grants (resource_type=base)
        ├── Change log ‹chg› (30 d; undo/redo, realtime catch-up, webhooks)  [D] base_changes
        ├── Domain events ‹evt› (outbox)             [D] outbox_events → Kafka
        ├── Snapshots ‹snp›                          [D] base_snapshots + [S3] tabula-snapshots
        ├── Long operations ‹lop›                    [D] long_operations
        │   ├── Imports ‹imp› → row errors           [D] import_jobs → import_errors
        │   └── Exports ‹exp›                        [D] export_jobs + [S3] tabula-exports
        ├── Sync sources → runs                      [D] sync_sources → sync_runs (target: tables kind=sync)
        ├── Secrets (base-level) ‹sct›               [D] secrets (base_id set)
        ├── Share links ‹shr› (view/form/interface/base)  [D] share_links ↔ [C] public_link_directory [Proposed]
        ├── Outbound API webhooks ‹whk›              [D] webhook_subscriptions
        │   └── Deliveries                           [D] webhook_deliveries
        ├── Search documents (MVP FTS)               [D] search_documents
        ├── AI invocations ‹aij›                     [D] ai_invocations
        ├── Link relations (one per link field pair) [D] link_relations
        ├── Field dependency graph                   [D] field_dependencies
        ├── Table ‹tbl›                              [D] tables
        │   ├── Field ‹fld› (slot, type, config)     [D] fields
        │   │   ├── Select options ‹opt›             (json) fields.config.options[]
        │   │   ├── Restrictions (edit/hide)         (json) fields.restrictions
        │   │   └── Index sidecar state              fields.index_state → record_index_* rows
        │   ├── Table restrictions / row policies    (json) tables.restrictions
        │   ├── Record ‹rec›                         [D] records (cells / computed / cell_meta)
        │   │   ├── Link edges                       [D] record_links
        │   │   ├── Typed index rows                 [D] record_index_num / _text / _time
        │   │   ├── Rich-text CRDT docs (V1+)        [D] record_rich_docs
        │   │   ├── Revisions ‹rev›                  [D] record_revisions
        │   │   ├── Pending recompute markers        [D] computed_stale
        │   │   ├── Attachments ‹att›                [D] attachments + [S3] tabula-attachments
        │   │   │   └── Variants (thumbs, posters)   [D] attachment_variants (+ attachment_blobs [Proposed]) + [S3] tabula-attachment-variants
        │   │   ├── Comments ‹cmt› (threads)         [D] comments
        │   │   │   ├── Reactions                    [D] comment_reactions
        │   │   │   └── Mentions                     [D] mentions (also from long_text cells)
        │   │   └── Watchers                         [D] record_subscriptions
        │   ├── View section ‹vsc›                   [D] view_sections
        │   └── View ‹viw› (grid/form/kanban/…)      [D] views (config json: filters, sorts, groups, field visibility)
        │       ├── Personal per-user state          [D] view_user_state
        │       ├── Per-view manual order            [D] view_record_orders [Proposed]
        │       └── Enter/leave watches              [D] view_watches → view_match_state [Proposed]
        ├── Interface ‹itf›                          [D] interfaces
        │   ├── Grants (interface_editor/user)       [C] access_grants (resource_type=interface)
        │   ├── Page ‹pag› (draft)                   [D] interface_pages
        │   │   └── Element ‹elm›                    (json) interface_pages.layout element tree
        │   └── Published version                    [D] interface_versions (snapshot json: pages + elements + element permissions)
        └── Automation ‹aut›                         [D] automations (draft_definition json)
            ├── Version ‹atv› (immutable)            [D] automation_versions
            │   ├── Trigger                          (json) definition.trigger (+ trigger_type/trigger_table_id columns)
            │   └── Steps / actions / branches       (json) definition.steps, compiled graph
            ├── Schedule (scheduled triggers)        [D] automation_schedules
            ├── Inbound webhook endpoint ‹ihk›       [D] inbound_webhooks ↔ [C] public_link_directory [Proposed]
            └── Run ‹run›                            [D] automation_runs
                └── Step run ‹stp›                   [D] automation_step_runs (→ ai_invocations)
```

### 59.2 User-scoped and global objects

```text
User ‹usr›                                           [C] users
├── Login identities (password/OAuth/SAML/OIDC)      [C] user_identities
├── MFA factors (TOTP, WebAuthn, recovery codes)     [C] user_mfa_factors
├── Sessions                                         [C] sessions  (+ [R] sess:{tokenHash})
├── UI preferences                                   [C] user_preferences
├── Personal access tokens ‹tok›                     [C] api_tokens (kind=pat)
├── OAuth consents (per client app)                  [C] oauth_grants
│   ├── Access tokens ‹tok›                          [C] api_tokens (kind=oauth_access)
│   └── Authorization codes (transient)              [C] oauth_authorization_codes
├── Org memberships / team memberships               [C] organization_members, team_members
├── Grants held (user principal)                     [C] access_grants (principal_type=user)
├── Notifications ‹ntf›                              [C] notifications
│   └── Delivery attempts (email/push/slack)         [C] notification_deliveries
├── Notification preferences                         [C] notification_preferences
├── Personal views / personal view state             [D] views (visibility=personal), view_user_state
├── Personal integration connections                 [D] integration_connections (visibility=personal)
└── Watched records / mentions of me                 [D] record_subscriptions, mentions (target_type=user)

Global (platform) objects
├── Shards (data plane cells)                        [C] shards
├── Plans                                            [C] plans
├── Feature flags                                    [C] feature_flags
├── Public template gallery ‹tpl›                    [C] templates (org_id NULL) + [S3] tabula-snapshots
├── OAuth client apps (platform-curated) ‹app›       [C] oauth_clients (org_id NULL)
├── Email suppression list                           [C] email_suppressions
├── System AI prompt templates                       [D] ai_prompt_templates (workspace_id NULL, seeded on every shard)
└── Relay checkpoints (per shard)                    [D] relay_checkpoints [Proposed]
```

### 59.3 Object → storage quick reference

| Object (public prefix) | Plane | Table / location | Notes |
|---|---|---|---|
| Organization `org` | C | `organizations` | |
| Workspace `wsp` | C (+ D content) | `workspaces`, routing `workspace_directory` | content on one shard |
| User `usr` | C | `users` | data plane stores UUIDs only |
| Team `tem` | C | `teams` | |
| Base `bas` | D (+ C directory) | `bases`, `base_runtime`, `core.base_directory` | |
| Table `tbl` | D | `tables` | |
| Field `fld` | D | `fields` | slot keys JSONB cells |
| Select option `opt` | D | `fields.config.options[]` (json) | cells store option IDs |
| Record `rec` | D | `records` | |
| Contact `ctc` | D | `records` of `tables.kind='contacts'` + `contact_*` tables | |
| View `viw` / section `vsc` | D | `views` / `view_sections` | |
| Interface `itf` / page `pag` / element `elm` | D | `interfaces` / `interface_pages` / layout json | published in `interface_versions` |
| Automation `aut` / version `atv` / run `run` / step run `stp` | D | `automations` / `automation_versions` / `automation_runs` / `automation_step_runs` | |
| Attachment `att` | D + S3 | `attachments`, `attachment_variants` | |
| Comment `cmt` | D | `comments` | |
| Notification `ntf` | C | `notifications` | |
| Share link `shr` | D (+ C routing) | `share_links` | |
| Inbound webhook `ihk` / outbound webhook `whk` | D | `inbound_webhooks` / `webhook_subscriptions` | |
| Integration connection `con` / secret `sct` | D | `integration_connections` / `secrets` | envelope-encrypted |
| API token `tok` / service account `svc` / OAuth app `app` | C | `api_tokens` / `service_accounts` / `oauth_clients` | |
| Base change `chg` / event `evt` | D | `base_changes` / `outbox_events` | |
| Import `imp` / export `exp` / long op `lop` / snapshot `snp` | D | `import_jobs` / `export_jobs` / `long_operations` / `base_snapshots` | |
| Record revision `rev` | D | `record_revisions` | |
| Invitation `inv` | C | `invitations` | |
| AI invocation `aij` | D | `ai_invocations` | |
| Template `tpl` | C (gallery) / D (AI prompt templates) | `templates` / `ai_prompt_templates` | same prefix, resolved by endpoint |
