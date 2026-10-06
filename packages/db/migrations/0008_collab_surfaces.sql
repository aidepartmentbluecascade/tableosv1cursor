-- Wave 4: collaboration surfaces (attachments, comments, search, shares, import/export, contacts, notifications)

CREATE TABLE data.attachments (
  id            uuid        PRIMARY KEY DEFAULT public.uuidv7(),
  workspace_id  uuid        NOT NULL,
  base_id       uuid        NOT NULL REFERENCES data.bases(id) ON DELETE CASCADE,
  filename      text        NOT NULL,
  mime          text        NOT NULL,
  size_bytes    bigint      NOT NULL CHECK (size_bytes >= 0),
  object_key    text        NOT NULL,
  checksum      text,
  scan_status   text        NOT NULL DEFAULT 'pending'
                            CHECK (scan_status IN ('pending','scanning','clean','rejected')),
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX attachments_base_idx ON data.attachments (base_id, created_at DESC);

CREATE TABLE data.attachment_variants (
  attachment_id uuid        NOT NULL REFERENCES data.attachments(id) ON DELETE CASCADE,
  kind          text        NOT NULL,
  object_key    text        NOT NULL,
  width         integer,
  height        integer,
  PRIMARY KEY (attachment_id, kind)
);

CREATE TABLE data.comments (
  id            uuid        PRIMARY KEY DEFAULT public.uuidv7(),
  workspace_id  uuid        NOT NULL,
  base_id       uuid        NOT NULL REFERENCES data.bases(id) ON DELETE CASCADE,
  table_id      uuid        NOT NULL,
  record_id     uuid        NOT NULL,
  parent_id     uuid        REFERENCES data.comments(id) ON DELETE CASCADE,
  body          text        NOT NULL CHECK (length(body) <= 10000),
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz,
  deleted_at    timestamptz
);
CREATE INDEX comments_record_idx ON data.comments (record_id, created_at, id) WHERE deleted_at IS NULL;
CREATE INDEX comments_base_idx ON data.comments (base_id, created_at DESC);

CREATE TABLE data.comment_reactions (
  comment_id    uuid        NOT NULL REFERENCES data.comments(id) ON DELETE CASCADE,
  user_id       uuid        NOT NULL,
  emoji         text        NOT NULL CHECK (length(emoji) BETWEEN 1 AND 32),
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (comment_id, user_id, emoji)
);

CREATE TABLE data.mentions (
  id              uuid        PRIMARY KEY DEFAULT public.uuidv7(),
  comment_id      uuid        NOT NULL REFERENCES data.comments(id) ON DELETE CASCADE,
  principal_type  text        NOT NULL CHECK (principal_type IN ('user','team','record','contact')),
  principal_id    uuid        NOT NULL
);
CREATE INDEX mentions_comment_idx ON data.mentions (comment_id);
CREATE INDEX mentions_principal_idx ON data.mentions (principal_type, principal_id);

CREATE TABLE data.record_subscriptions (
  workspace_id  uuid        NOT NULL,
  base_id       uuid        NOT NULL,
  table_id      uuid        NOT NULL,
  record_id     uuid        NOT NULL,
  user_id       uuid        NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, base_id, table_id, record_id, user_id)
);
CREATE INDEX record_subscriptions_user_idx ON data.record_subscriptions (user_id, base_id);

CREATE TABLE data.search_documents (
  id            uuid        PRIMARY KEY DEFAULT public.uuidv7(),
  workspace_id  uuid        NOT NULL,
  base_id       uuid        NOT NULL REFERENCES data.bases(id) ON DELETE CASCADE,
  doc_type      text        NOT NULL,
  ref_id        uuid        NOT NULL,
  title         text        NOT NULL DEFAULT '',
  body          text        NOT NULL DEFAULT '',
  tsv           tsvector    GENERATED ALWAYS AS (
                    to_tsvector('english', coalesce(title, '') || ' ' || coalesce(body, ''))
                  ) STORED,
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX search_documents_ref_uq ON data.search_documents (base_id, doc_type, ref_id);
CREATE INDEX search_documents_tsv_gin ON data.search_documents USING gin (tsv);
CREATE INDEX search_documents_workspace_idx ON data.search_documents (workspace_id, updated_at DESC);

CREATE TABLE data.share_links (
  id              uuid        PRIMARY KEY DEFAULT public.uuidv7(),
  workspace_id    uuid        NOT NULL,
  base_id         uuid        NOT NULL REFERENCES data.bases(id) ON DELETE CASCADE,
  target_type     text        NOT NULL CHECK (target_type IN ('view','form')),
  target_id       uuid        NOT NULL,
  token_hash      bytea       NOT NULL CHECK (length(token_hash) = 32),
  token_prefix    text        NOT NULL,
  access_mode     text        NOT NULL DEFAULT 'public' CHECK (access_mode IN ('public','password')),
  password_hash   text,
  expires_at      timestamptz,
  created_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  revoked_at      timestamptz,
  CHECK ((access_mode = 'password') = (password_hash IS NOT NULL))
);
CREATE UNIQUE INDEX share_links_token_hash_uq ON data.share_links (token_hash);
CREATE INDEX share_links_target_idx ON data.share_links (target_type, target_id) WHERE revoked_at IS NULL;

CREATE TABLE data.import_jobs (
  id                  uuid        PRIMARY KEY DEFAULT public.uuidv7(),
  workspace_id        uuid        NOT NULL,
  base_id             uuid        NOT NULL REFERENCES data.bases(id) ON DELETE CASCADE,
  table_id            uuid,
  long_operation_id   uuid        REFERENCES data.long_operations(id) ON DELETE SET NULL,
  status              text        NOT NULL DEFAULT 'queued'
                                  CHECK (status IN ('queued','running','succeeded','failed','cancelled')),
  source_filename     text,
  rows_total          bigint,
  rows_imported       bigint      NOT NULL DEFAULT 0,
  rows_failed         bigint      NOT NULL DEFAULT 0,
  created_by          uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  finished_at         timestamptz
);
CREATE INDEX import_jobs_base_idx ON data.import_jobs (base_id, created_at DESC);

CREATE TABLE data.import_errors (
  id              uuid        PRIMARY KEY DEFAULT public.uuidv7(),
  import_job_id   uuid        NOT NULL REFERENCES data.import_jobs(id) ON DELETE CASCADE,
  workspace_id    uuid        NOT NULL,
  source_row      bigint      NOT NULL,
  message         text        NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX import_errors_job_idx ON data.import_errors (import_job_id, source_row);

CREATE TABLE data.export_jobs (
  id                  uuid        PRIMARY KEY DEFAULT public.uuidv7(),
  workspace_id        uuid        NOT NULL,
  base_id             uuid        NOT NULL REFERENCES data.bases(id) ON DELETE CASCADE,
  table_id            uuid,
  long_operation_id   uuid        REFERENCES data.long_operations(id) ON DELETE SET NULL,
  status              text        NOT NULL DEFAULT 'queued'
                                  CHECK (status IN ('queued','running','succeeded','failed')),
  object_key          text,
  row_count           bigint,
  requested_by        uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  finished_at         timestamptz
);
CREATE INDEX export_jobs_base_idx ON data.export_jobs (base_id, created_at DESC);

CREATE TABLE data.contact_identifiers (
  id              uuid        PRIMARY KEY DEFAULT public.uuidv7(),
  workspace_id    uuid        NOT NULL,
  contact_id      uuid        NOT NULL,
  kind            text        NOT NULL CHECK (kind IN ('email','phone')),
  value_norm      text        NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX contact_identifiers_lookup_idx ON data.contact_identifiers (workspace_id, kind, value_norm);

CREATE TABLE data.contact_merge_events (
  id                    uuid        PRIMARY KEY DEFAULT public.uuidv7(),
  workspace_id          uuid        NOT NULL,
  survivor_contact_id   uuid        NOT NULL,
  merged_contact_id     uuid        NOT NULL,
  performed_by          uuid,
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX contact_merge_events_survivor_idx ON data.contact_merge_events (survivor_contact_id, created_at DESC);

CREATE TABLE core.notifications (
  id              uuid        PRIMARY KEY DEFAULT public.uuidv7(),
  user_id         uuid        NOT NULL REFERENCES core.users(id) ON DELETE CASCADE,
  workspace_id    uuid,
  base_id         uuid,
  category        text        NOT NULL DEFAULT 'comment',
  title           text        NOT NULL,
  body            jsonb       NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(body) = 'object'),
  read_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_inbox_idx ON core.notifications (user_id, created_at DESC);
CREATE INDEX notifications_unread_idx ON core.notifications (user_id) WHERE read_at IS NULL;

CREATE TABLE core.notification_preferences (
  user_id     uuid        NOT NULL REFERENCES core.users(id) ON DELETE CASCADE,
  category    text        NOT NULL DEFAULT '*',
  channel     text        NOT NULL DEFAULT 'in_app',
  enabled     boolean     NOT NULL DEFAULT true,
  PRIMARY KEY (user_id, category, channel)
);

CREATE TABLE core.public_link_directory (
  token_prefix    text        PRIMARY KEY,
  workspace_id    uuid        NOT NULL,
  shard_id        uuid        NOT NULL,
  share_link_id   uuid        NOT NULL REFERENCES data.share_links(id) ON DELETE CASCADE,
  kind            text        NOT NULL DEFAULT 'share_link'
);
CREATE INDEX public_link_directory_share_idx ON core.public_link_directory (share_link_id);
