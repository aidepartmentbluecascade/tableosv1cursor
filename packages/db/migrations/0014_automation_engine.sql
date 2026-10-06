-- Workstream G: automation execution engine.

-- Webhook trigger tokens (one per automation) — looked up by POST /v1/hooks/:token.
ALTER TABLE data.automations
  ADD COLUMN IF NOT EXISTS webhook_token text,
  ADD COLUMN IF NOT EXISTS last_run_at   timestamptz,
  ADD COLUMN IF NOT EXISTS next_run_at   timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS automations_webhook_token_uq
  ON data.automations (webhook_token) WHERE webhook_token IS NOT NULL;
CREATE INDEX IF NOT EXISTS automations_enabled_base_idx
  ON data.automations (base_id) WHERE enabled AND deleted_at IS NULL;

-- One row per (automation, triggering event). The unique trigger_key makes
-- trigger evaluation idempotent: replays of the same domain event never run twice.
CREATE TABLE IF NOT EXISTS data.automation_runs (
  id               uuid        PRIMARY KEY DEFAULT public.uuidv7(),
  automation_id    uuid        NOT NULL REFERENCES data.automations(id) ON DELETE CASCADE,
  base_id          uuid        NOT NULL,
  workspace_id     uuid        NOT NULL,
  trigger_type     text        NOT NULL,
  trigger_key      text        NOT NULL,
  trigger_payload  jsonb       NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(trigger_payload) = 'object'),
  is_test          boolean     NOT NULL DEFAULT false,
  causation_depth  smallint    NOT NULL DEFAULT 0,
  status           text        NOT NULL DEFAULT 'pending'
                               CHECK (status IN ('pending','running','succeeded','failed','skipped')),
  attempts         integer     NOT NULL DEFAULT 0,
  max_attempts     integer     NOT NULL DEFAULT 3,
  next_attempt_at  timestamptz NOT NULL DEFAULT now(),
  locked_until     timestamptz,
  steps            jsonb       NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(steps) = 'array'),
  error            text,
  session_id       uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  started_at       timestamptz,
  finished_at      timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS automation_runs_trigger_uq
  ON data.automation_runs (automation_id, trigger_key);
CREATE INDEX IF NOT EXISTS automation_runs_history_idx
  ON data.automation_runs (automation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS automation_runs_pending_idx
  ON data.automation_runs (next_attempt_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS automation_runs_session_idx
  ON data.automation_runs (session_id) WHERE session_id IS NOT NULL;

-- Per (automation, record) state used by "matches conditions" / "enters view"
-- triggers to fire only on a false → true transition.
CREATE TABLE IF NOT EXISTS data.automation_record_state (
  automation_id uuid        NOT NULL REFERENCES data.automations(id) ON DELETE CASCADE,
  record_id     uuid        NOT NULL,
  matched       boolean     NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (automation_id, record_id)
);

-- Outbox events already evaluated by the automation consumer.
CREATE TABLE IF NOT EXISTS data.automation_processed_events (
  event_id     uuid        PRIMARY KEY,
  processed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS automation_processed_events_time_idx
  ON data.automation_processed_events (processed_at);

-- Consumer cursor and other engine-level state.
CREATE TABLE IF NOT EXISTS data.automation_engine_state (
  key        text        PRIMARY KEY,
  value      jsonb       NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Dev mail transport: every email an automation sends is stored here (and
-- delivered over SMTP when SMTP_URL is configured).
CREATE TABLE IF NOT EXISTS core.email_outbox (
  id          uuid        PRIMARY KEY DEFAULT public.uuidv7(),
  org_id      uuid,
  workspace_id uuid,
  source      text        NOT NULL DEFAULT 'automation',
  source_id   uuid,
  to_addresses text[]     NOT NULL,
  cc_addresses text[]     NOT NULL DEFAULT '{}',
  subject     text        NOT NULL,
  body_text   text        NOT NULL,
  status      text        NOT NULL DEFAULT 'stored' CHECK (status IN ('stored','sent','failed')),
  error       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  sent_at     timestamptz
);
CREATE INDEX IF NOT EXISTS email_outbox_created_idx ON core.email_outbox (created_at DESC);

-- Outbox scans by time (the existing index is partial on published_at IS NULL).
CREATE INDEX IF NOT EXISTS outbox_events_created_idx ON data.outbox_events (created_at);
