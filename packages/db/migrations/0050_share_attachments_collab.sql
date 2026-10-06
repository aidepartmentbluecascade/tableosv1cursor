-- Workstream E: sharing, attachments, comments/notifications support columns.

-- ── Share links ────────────────────────────────────────────────────────────
-- Keep the plaintext token so base members can copy the link again later
-- (Airtable behaviour). The hash stays the lookup key.
ALTER TABLE data.share_links ADD COLUMN IF NOT EXISTS token text;
ALTER TABLE data.share_links ADD COLUMN IF NOT EXISTS table_id uuid;
ALTER TABLE data.share_links ADD COLUMN IF NOT EXISTS allow_copy boolean NOT NULL DEFAULT false;
ALTER TABLE data.share_links ADD COLUMN IF NOT EXISTS settings jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE data.share_links ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE data.share_links ADD COLUMN IF NOT EXISTS revoked_by uuid;

ALTER TABLE data.share_links DROP CONSTRAINT IF EXISTS share_links_target_type_check;
ALTER TABLE data.share_links
  ADD CONSTRAINT share_links_target_type_check
  CHECK (target_type = ANY (ARRAY['view'::text, 'form'::text, 'base'::text]));

CREATE INDEX IF NOT EXISTS share_links_base_idx
  ON data.share_links (base_id, created_at DESC) WHERE revoked_at IS NULL;

-- Public form submissions (rate limiting / audit trail).
CREATE TABLE IF NOT EXISTS data.share_submissions (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  share_link_id uuid NOT NULL REFERENCES data.share_links(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  base_id uuid NOT NULL,
  record_id uuid,
  ip text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS share_submissions_ip_idx
  ON data.share_submissions (ip, created_at DESC);

-- ── Attachments ────────────────────────────────────────────────────────────
ALTER TABLE data.attachments ADD COLUMN IF NOT EXISTS storage_driver text NOT NULL DEFAULT 'gcs';
ALTER TABLE data.attachments ADD COLUMN IF NOT EXISTS table_id uuid;
ALTER TABLE data.attachments ADD COLUMN IF NOT EXISTS record_id uuid;
ALTER TABLE data.attachments ADD COLUMN IF NOT EXISTS field_id uuid;
ALTER TABLE data.attachments ADD COLUMN IF NOT EXISTS width integer;
ALTER TABLE data.attachments ADD COLUMN IF NOT EXISTS height integer;
ALTER TABLE data.attachments ADD COLUMN IF NOT EXISTS uploaded_at timestamptz;
-- Uploads made through a public form share (no user session).
ALTER TABLE data.attachments ADD COLUMN IF NOT EXISTS share_link_id uuid;

CREATE INDEX IF NOT EXISTS attachments_record_idx
  ON data.attachments (record_id) WHERE record_id IS NOT NULL;

-- ── Comments / notifications ───────────────────────────────────────────────
ALTER TABLE core.notifications ADD COLUMN IF NOT EXISTS actor_user_id uuid;
ALTER TABLE core.notifications ADD COLUMN IF NOT EXISTS link text;
