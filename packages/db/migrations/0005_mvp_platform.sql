-- Wave 1: RLS helpers, platform hooks, MVP tables (single cluster)

-- ---------------------------------------------------------------------------
-- RLS helpers
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION data.current_workspace_id() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT nullif(current_setting('app.workspace_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION data.rls_workspace_pass(p_workspace_id uuid) RETURNS boolean
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT p_workspace_id = data.current_workspace_id()
      OR nullif(current_setting('app.workspace_id', true), '') IS NULL
      OR current_setting('app.bypass_rls', true) = 'on'
$$;

-- ---------------------------------------------------------------------------
-- Column hooks
-- ---------------------------------------------------------------------------
ALTER TABLE data.tables
  ADD COLUMN IF NOT EXISTS restrictions jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE data.fields
  ADD COLUMN IF NOT EXISTS restrictions jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE data.fields
  ADD COLUMN IF NOT EXISTS index_state text NOT NULL DEFAULT 'none';

-- ---------------------------------------------------------------------------
-- Data plane — MVP platform tables
-- ---------------------------------------------------------------------------
CREATE TABLE data.deletion_batches (
  id            uuid        PRIMARY KEY DEFAULT public.uuidv7(),
  workspace_id  uuid        NOT NULL,
  base_id       uuid        REFERENCES data.bases(id) ON DELETE CASCADE,
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  restored_at   timestamptz
);
CREATE INDEX deletion_batches_workspace_idx ON data.deletion_batches (workspace_id, created_at DESC);
CREATE INDEX deletion_batches_base_idx ON data.deletion_batches (base_id, created_at DESC) WHERE base_id IS NOT NULL;

CREATE TABLE data.record_revisions (
  id            uuid        PRIMARY KEY DEFAULT public.uuidv7(),
  workspace_id  uuid        NOT NULL,
  base_id       uuid        NOT NULL,
  table_id      uuid        NOT NULL,
  record_id     uuid        NOT NULL,
  change_seq    bigint      NOT NULL,
  cells_before  jsonb       NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(cells_before) = 'object'),
  cells_after   jsonb       NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(cells_after) = 'object'),
  actor_id      uuid,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX record_revisions_record_idx ON data.record_revisions (table_id, record_id, created_at DESC);
CREATE INDEX record_revisions_workspace_idx ON data.record_revisions (workspace_id, created_at DESC);

CREATE TABLE data.long_operations (
  id            uuid        PRIMARY KEY DEFAULT public.uuidv7(),
  workspace_id  uuid        NOT NULL,
  base_id       uuid        REFERENCES data.bases(id) ON DELETE CASCADE,
  kind          text        NOT NULL,
  status        text        NOT NULL DEFAULT 'queued',
  progress      jsonb       NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(progress) = 'object'),
  checkpoint    jsonb       NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(checkpoint) = 'object'),
  lease_until   timestamptz,
  error         text,
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  completed_at  timestamptz
);
CREATE INDEX long_operations_base_idx ON data.long_operations (base_id, created_at DESC) WHERE base_id IS NOT NULL;
CREATE INDEX long_operations_lease_idx ON data.long_operations (lease_until) WHERE status IN ('queued', 'running');

CREATE TABLE data.record_index_num (
  table_id      uuid             NOT NULL,
  field_slot    smallint         NOT NULL,
  record_id     uuid             NOT NULL,
  value_eq      double precision,
  sort_key      double precision,
  workspace_id  uuid             NOT NULL,
  base_id       uuid             NOT NULL,
  PRIMARY KEY (table_id, field_slot, record_id)
);
CREATE INDEX record_index_num_sort_idx ON data.record_index_num (table_id, field_slot, sort_key, record_id);

CREATE TABLE data.record_index_text (
  table_id      uuid        NOT NULL,
  field_slot    smallint    NOT NULL,
  record_id     uuid        NOT NULL,
  value_eq      text,
  sort_key      text,
  workspace_id  uuid        NOT NULL,
  base_id       uuid        NOT NULL,
  PRIMARY KEY (table_id, field_slot, record_id)
);
CREATE INDEX record_index_text_sort_idx ON data.record_index_text (table_id, field_slot, sort_key, record_id);

CREATE TABLE data.record_index_time (
  table_id      uuid        NOT NULL,
  field_slot    smallint    NOT NULL,
  record_id     uuid        NOT NULL,
  value_eq      timestamptz,
  sort_key      timestamptz,
  workspace_id  uuid        NOT NULL,
  base_id       uuid        NOT NULL,
  PRIMARY KEY (table_id, field_slot, record_id)
);
CREATE INDEX record_index_time_sort_idx ON data.record_index_time (table_id, field_slot, sort_key, record_id);

CREATE TABLE data.link_relations (
  id               uuid        PRIMARY KEY DEFAULT public.uuidv7(),
  workspace_id     uuid        NOT NULL,
  base_id          uuid        NOT NULL REFERENCES data.bases(id) ON DELETE CASCADE,
  a_table_id       uuid        NOT NULL REFERENCES data.tables(id) ON DELETE RESTRICT,
  a_field_id       uuid        NOT NULL REFERENCES data.fields(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  b_table_id       uuid        NOT NULL REFERENCES data.tables(id) ON DELETE RESTRICT,
  b_field_id       uuid        REFERENCES data.fields(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  allow_multiple_a boolean     NOT NULL DEFAULT true,
  allow_multiple_b boolean     NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX link_relations_a_field_uq ON data.link_relations (a_field_id);
CREATE INDEX link_relations_base_idx ON data.link_relations (base_id);

CREATE TABLE data.record_links (
  relation_id         uuid        NOT NULL REFERENCES data.link_relations(id) ON DELETE CASCADE,
  a_record_id         uuid        NOT NULL,
  b_record_id         uuid        NOT NULL,
  a_order             text        NOT NULL DEFAULT 'a0',
  b_order             text        NOT NULL DEFAULT 'a0',
  workspace_id        uuid        NOT NULL,
  base_id             uuid        NOT NULL,
  deletion_batch_id   uuid        REFERENCES data.deletion_batches(id) ON DELETE SET NULL,
  PRIMARY KEY (relation_id, a_record_id, b_record_id)
);
CREATE INDEX record_links_a_idx ON data.record_links (relation_id, a_record_id, a_order);
CREATE INDEX record_links_b_idx ON data.record_links (relation_id, b_record_id, b_order);

CREATE TABLE data.field_dependencies (
  dependent_field_id   uuid        NOT NULL REFERENCES data.fields(id) ON DELETE CASCADE,
  depends_on_field_id  uuid        NOT NULL REFERENCES data.fields(id) ON DELETE CASCADE,
  via_link_field_id    uuid        REFERENCES data.fields(id) ON DELETE CASCADE,
  workspace_id         uuid        NOT NULL,
  base_id              uuid        NOT NULL REFERENCES data.bases(id) ON DELETE CASCADE,
  PRIMARY KEY (dependent_field_id, depends_on_field_id),
  CHECK (dependent_field_id <> depends_on_field_id)
);
CREATE INDEX field_dependencies_depends_on_idx ON data.field_dependencies (depends_on_field_id);

CREATE TABLE data.computed_stale (
  table_id      uuid        NOT NULL,
  record_id     uuid        NOT NULL,
  field_id      uuid        NOT NULL REFERENCES data.fields(id) ON DELETE CASCADE,
  workspace_id  uuid        NOT NULL,
  base_id       uuid        NOT NULL,
  enqueued_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (table_id, record_id, field_id)
);
CREATE INDEX computed_stale_base_idx ON data.computed_stale (base_id, enqueued_at);

-- ---------------------------------------------------------------------------
-- Control plane — billing & invites (MVP skeleton)
-- ---------------------------------------------------------------------------
CREATE TABLE core.plans (
  id          uuid        PRIMARY KEY DEFAULT public.uuidv7(),
  code        text        NOT NULL UNIQUE CHECK (code IN ('free', 'team', 'business', 'enterprise')),
  name        text        NOT NULL,
  limits      jsonb       NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(limits) = 'object'),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE core.subscriptions (
  id                     uuid        PRIMARY KEY DEFAULT public.uuidv7(),
  org_id                 uuid        NOT NULL REFERENCES core.organizations(id) ON DELETE CASCADE,
  plan_id                uuid        NOT NULL REFERENCES core.plans(id) ON DELETE RESTRICT,
  status                 text        NOT NULL DEFAULT 'active'
                                     CHECK (status IN ('trialing', 'active', 'past_due', 'paused', 'canceled', 'incomplete')),
  stripe_customer_id     text,
  stripe_subscription_id text,
  seats                  integer     NOT NULL DEFAULT 0 CHECK (seats >= 0),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX subscriptions_org_idx ON core.subscriptions (org_id);

CREATE TABLE core.usage_counters (
  org_id        uuid        NOT NULL REFERENCES core.organizations(id) ON DELETE CASCADE,
  metric        text        NOT NULL,
  period_start  date        NOT NULL,
  value         bigint      NOT NULL DEFAULT 0,
  PRIMARY KEY (org_id, metric, period_start)
);

CREATE TABLE core.invitations (
  id             uuid        PRIMARY KEY DEFAULT public.uuidv7(),
  org_id         uuid        NOT NULL REFERENCES core.organizations(id) ON DELETE CASCADE,
  email          text        NOT NULL CHECK (length(email) BETWEEN 3 AND 320),
  resource_type  text        NOT NULL CHECK (resource_type IN ('org', 'workspace', 'base', 'interface')),
  resource_id    uuid        NOT NULL,
  role           text        NOT NULL,
  token_hash     bytea       NOT NULL CHECK (length(token_hash) = 32),
  invited_by     uuid        NOT NULL,
  status         text        NOT NULL DEFAULT 'pending'
                             CHECK (status IN ('pending', 'accepted', 'revoked', 'expired')),
  expires_at     timestamptz NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX invitations_token_uq ON core.invitations (token_hash);
CREATE INDEX invitations_org_idx ON core.invitations (org_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Audit store (thin MVP)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit.audit_events (
  id             uuid        PRIMARY KEY DEFAULT public.uuidv7(),
  org_id         uuid        NOT NULL,
  actor_type     text        NOT NULL,
  actor_id       text,
  action         text        NOT NULL,
  resource_type  text,
  resource_id    text,
  ip             inet,
  meta           jsonb       NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(meta) = 'object'),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_events_org_time_idx ON audit.audit_events (org_id, created_at DESC);

-- Seed Free + Team plans (idempotent)
INSERT INTO core.plans (code, name, limits)
VALUES
  (
    'free',
    'Free',
    '{
      "recordsPerBase": 2000,
      "tablesPerBase": 50,
      "attachmentBytesPerBase": 1073741824,
      "automationRunsPerMonth": 200,
      "apiRatePerTokenRps": 5,
      "revisionRetentionDays": 14
    }'::jsonb
  ),
  (
    'team',
    'Team',
    '{
      "recordsPerBase": 100000,
      "tablesPerBase": 200,
      "attachmentBytesPerBase": 53687091200,
      "automationRunsPerMonth": 50000,
      "apiRatePerTokenRps": 20,
      "revisionRetentionDays": 365
    }'::jsonb
  )
ON CONFLICT (code) DO NOTHING;

-- ---------------------------------------------------------------------------
-- RLS on key data tables (FORCE; migrator + bypass_rls escape hatches)
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'data.bases',
    'data.base_runtime',
    'data.tables',
    'data.fields',
    'data.records',
    'data.views',
    'data.base_changes',
    'data.outbox_events'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS workspace_tenant ON %s', t);
    EXECUTE format(
      'CREATE POLICY workspace_tenant ON %s FOR ALL
         USING (data.rls_workspace_pass(workspace_id))
         WITH CHECK (data.rls_workspace_pass(workspace_id))',
      t
    );
  END LOOP;
END $$;
