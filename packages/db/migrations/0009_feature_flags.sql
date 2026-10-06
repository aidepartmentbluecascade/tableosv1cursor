-- Wave 5: feature flag catalog (evaluated in-process for MVP).

CREATE TABLE IF NOT EXISTS core.feature_flags (
  key            text        PRIMARY KEY CHECK (key ~ '^[a-z0-9_.-]{2,100}$'),
  description    text        NOT NULL DEFAULT '',
  kind           text        NOT NULL DEFAULT 'boolean' CHECK (kind IN ('boolean', 'variant', 'percentage')),
  default_value  jsonb       NOT NULL DEFAULT 'false'::jsonb,
  rules          jsonb       NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(rules) = 'array'),
  status         text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  owner_team     text,
  version        integer     NOT NULL DEFAULT 1,
  updated_by     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

INSERT INTO core.feature_flags (key, description, kind, default_value)
VALUES
  ('collab.comments', 'Record comments', 'boolean', 'true'::jsonb),
  ('collab.attachments', 'File attachments', 'boolean', 'true'::jsonb),
  ('billing.checkout', 'Stripe checkout', 'boolean', 'true'::jsonb)
ON CONFLICT (key) DO NOTHING;
