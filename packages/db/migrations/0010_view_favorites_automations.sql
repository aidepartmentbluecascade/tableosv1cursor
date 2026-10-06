-- Per-user view favorites + MVP automations

CREATE TABLE IF NOT EXISTS data.view_favorites (
  user_id    uuid NOT NULL REFERENCES core.users(id) ON DELETE CASCADE,
  view_id    uuid NOT NULL REFERENCES data.views(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, view_id)
);

CREATE INDEX IF NOT EXISTS view_favorites_user_idx
  ON data.view_favorites (user_id);

CREATE TABLE IF NOT EXISTS data.automations (
  id           uuid PRIMARY KEY DEFAULT public.uuidv7(),
  workspace_id uuid NOT NULL,
  base_id      uuid NOT NULL REFERENCES data.bases(id) ON DELETE CASCADE,
  name         text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  enabled      boolean NOT NULL DEFAULT false,
  trigger      jsonb NOT NULL DEFAULT '{}'::jsonb
                 CHECK (jsonb_typeof(trigger) = 'object'),
  actions      jsonb NOT NULL DEFAULT '[]'::jsonb
                 CHECK (jsonb_typeof(actions) = 'array'),
  created_by   uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   uuid,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz,
  deleted_by   uuid
);

CREATE INDEX IF NOT EXISTS automations_base_idx
  ON data.automations (base_id)
  WHERE deleted_at IS NULL;
