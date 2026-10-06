-- MFA, invitations, audit, outbox relay cursor, control-plane idempotency

CREATE TABLE core.user_mfa_factors (
  id              uuid        PRIMARY KEY DEFAULT public.uuidv7(),
  user_id         uuid        NOT NULL REFERENCES core.users(id) ON DELETE CASCADE,
  kind            text        NOT NULL DEFAULT 'totp' CHECK (kind IN ('totp')),
  label           text        NOT NULL DEFAULT 'Authenticator',
  secret_ciphertext text      NOT NULL,
  confirmed_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX user_mfa_factors_user_kind_uq ON core.user_mfa_factors (user_id, kind)
  WHERE confirmed_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS core.invitations (
  id              uuid        PRIMARY KEY DEFAULT public.uuidv7(),
  org_id          uuid        NOT NULL REFERENCES core.organizations(id) ON DELETE CASCADE,
  workspace_id    uuid        REFERENCES core.workspaces(id) ON DELETE CASCADE,
  email           text        NOT NULL,
  email_normalized text       NOT NULL CHECK (email_normalized = lower(email_normalized)),
  role            text        NOT NULL,
  token_hash      bytea       NOT NULL CHECK (length(token_hash) = 32),
  status          text        NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending','accepted','revoked','expired')),
  invited_by      uuid        REFERENCES core.users(id) ON DELETE SET NULL,
  expires_at      timestamptz NOT NULL,
  accepted_at     timestamptz,
  accepted_by     uuid        REFERENCES core.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'core' AND table_name = 'invitations' AND column_name = 'email_normalized'
  ) THEN
    CREATE INDEX IF NOT EXISTS invitations_email_idx ON core.invitations (email_normalized) WHERE status = 'pending';
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS invitations_token_hash_uq ON core.invitations (token_hash);

CREATE SCHEMA IF NOT EXISTS audit;

CREATE TABLE IF NOT EXISTS audit.audit_events (
  id              uuid        PRIMARY KEY DEFAULT public.uuidv7(),
  org_id          uuid,
  workspace_id    uuid,
  actor_user_id   uuid,
  action          text        NOT NULL,
  target_type     text,
  target_id       uuid,
  metadata        jsonb       NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  ip              inet,
  user_agent      text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_events_org_created_idx ON audit.audit_events (org_id, created_at DESC);

ALTER TABLE data.outbox_events
  ADD COLUMN IF NOT EXISTS published_at timestamptz;

CREATE INDEX IF NOT EXISTS outbox_events_unpublished_idx ON data.outbox_events (created_at)
  WHERE published_at IS NULL;

CREATE TABLE core.idempotency_keys (
  org_id           uuid        NOT NULL,
  principal_id     uuid        NOT NULL,
  key              text        NOT NULL CHECK (length(key) BETWEEN 1 AND 255),
  request_hash     bytea       NOT NULL CHECK (length(request_hash) = 32),
  method           text        NOT NULL,
  path             text        NOT NULL,
  status           text        NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress','completed')),
  response_status  smallint,
  response_body    bytea,
  locked_until     timestamptz NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL,
  PRIMARY KEY (org_id, principal_id, key)
);
CREATE INDEX core_idempotency_keys_expiry_idx ON core.idempotency_keys (expires_at);
