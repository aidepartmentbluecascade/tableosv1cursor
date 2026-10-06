-- Workstream G: reconcile core.invitations and audit.audit_events.
-- 0005 created both tables first; 0006 used CREATE TABLE IF NOT EXISTS, so the
-- 0006 shape (used by the application code) never applied. Bring the live
-- tables up to the superset of both shapes.

-- ---------------------------------------------------------------------------
-- core.invitations
-- ---------------------------------------------------------------------------
ALTER TABLE core.invitations
  ADD COLUMN IF NOT EXISTS workspace_id     uuid REFERENCES core.workspaces(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS base_id          uuid,
  ADD COLUMN IF NOT EXISTS email_normalized text,
  ADD COLUMN IF NOT EXISTS accepted_at      timestamptz,
  ADD COLUMN IF NOT EXISTS accepted_by      uuid REFERENCES core.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS revoked_at       timestamptz,
  ADD COLUMN IF NOT EXISTS updated_at       timestamptz NOT NULL DEFAULT now();

UPDATE core.invitations SET email_normalized = lower(email) WHERE email_normalized IS NULL;

ALTER TABLE core.invitations
  ALTER COLUMN email_normalized SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'invitations_email_normalized_lower_chk'
  ) THEN
    ALTER TABLE core.invitations
      ADD CONSTRAINT invitations_email_normalized_lower_chk
      CHECK (email_normalized = lower(email_normalized));
  END IF;
END $$;

-- The 0005 generic resource columns stay (resource_type/resource_id) but are
-- optional now; new code fills them when it can.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'core' AND table_name = 'invitations' AND column_name = 'resource_type'
  ) THEN
    ALTER TABLE core.invitations ALTER COLUMN resource_type DROP NOT NULL;
    ALTER TABLE core.invitations ALTER COLUMN resource_id DROP NOT NULL;
  END IF;
END $$;

ALTER TABLE core.invitations ALTER COLUMN invited_by DROP NOT NULL;

CREATE INDEX IF NOT EXISTS invitations_email_idx
  ON core.invitations (email_normalized) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS invitations_workspace_idx
  ON core.invitations (workspace_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- audit.audit_events
-- ---------------------------------------------------------------------------
ALTER TABLE audit.audit_events
  ADD COLUMN IF NOT EXISTS workspace_id  uuid,
  ADD COLUMN IF NOT EXISTS actor_user_id uuid,
  ADD COLUMN IF NOT EXISTS target_type   text,
  ADD COLUMN IF NOT EXISTS target_id     text,
  ADD COLUMN IF NOT EXISTS metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS user_agent    text;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'audit' AND table_name = 'audit_events' AND column_name = 'actor_type'
  ) THEN
    ALTER TABLE audit.audit_events ALTER COLUMN actor_type SET DEFAULT 'user';
    ALTER TABLE audit.audit_events ALTER COLUMN actor_type DROP NOT NULL;
  END IF;
END $$;

-- Login and other user-scoped events may have no org.
ALTER TABLE audit.audit_events ALTER COLUMN org_id DROP NOT NULL;

CREATE INDEX IF NOT EXISTS audit_events_actor_idx
  ON audit.audit_events (actor_user_id, created_at DESC);
