-- Control plane: identity, routing, grants (MVP — single cluster, schema core)

CREATE TABLE core.organizations (
  id                       uuid        PRIMARY KEY DEFAULT public.uuidv7(),
  name                     text        NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  slug                     text        NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  kind                     text        NOT NULL DEFAULT 'standard'
                                       CHECK (kind IN ('personal','standard','enterprise')),
  status                   text        NOT NULL DEFAULT 'active'
                                       CHECK (status IN ('active','suspended','pending_deletion','deleted')),
  data_region              text        NOT NULL DEFAULT 'us-east-1',
  billing_email            text,
  settings                 jsonb       NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(settings) = 'object'),
  settings_schema_version  smallint    NOT NULL DEFAULT 1,
  created_by               uuid,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  deleted_at               timestamptz
);
CREATE UNIQUE INDEX organizations_slug_uq ON core.organizations (slug) WHERE deleted_at IS NULL;

CREATE TABLE core.users (
  id                    uuid        PRIMARY KEY DEFAULT public.uuidv7(),
  email                 text        NOT NULL CHECK (length(email) BETWEEN 3 AND 320),
  email_normalized      text        NOT NULL CHECK (email_normalized = lower(email_normalized)),
  email_verified_at     timestamptz,
  display_name          text        NOT NULL DEFAULT '' CHECK (length(display_name) <= 200),
  locale                text        NOT NULL DEFAULT 'en-US',
  time_zone             text        NOT NULL DEFAULT 'UTC',
  status                text        NOT NULL DEFAULT 'active'
                                    CHECK (status IN ('pending','active','deactivated','erased')),
  last_login_at         timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_uq ON core.users (email_normalized) WHERE status <> 'erased';

CREATE TABLE core.organization_members (
  org_id          uuid        NOT NULL REFERENCES core.organizations(id) ON DELETE CASCADE,
  user_id         uuid        NOT NULL REFERENCES core.users(id) ON DELETE CASCADE,
  role            text        NOT NULL CHECK (role IN ('owner','admin','billing_admin','member','guest')),
  status          text        NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','deactivated')),
  source          text        NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','invite','scim','sso_jit','domain_auto_join','org_creation')),
  joined_at       timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id)
);
CREATE INDEX organization_members_user_idx ON core.organization_members (user_id) WHERE status = 'active';

CREATE TABLE core.user_identities (
  id                  uuid        PRIMARY KEY DEFAULT public.uuidv7(),
  user_id             uuid        NOT NULL REFERENCES core.users(id) ON DELETE CASCADE,
  provider            text        NOT NULL CHECK (provider IN ('password','google','microsoft','apple','github','saml','oidc')),
  subject             text        NOT NULL,
  email_at_provider   text,
  password_hash       text,
  password_changed_at timestamptz,
  profile             jsonb       NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(profile) = 'object'),
  last_used_at        timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CHECK ((provider = 'password') = (password_hash IS NOT NULL))
);
CREATE UNIQUE INDEX user_identities_password_uq ON core.user_identities (user_id) WHERE provider = 'password';
CREATE INDEX user_identities_user_idx ON core.user_identities (user_id);

CREATE TABLE core.sessions (
  id                 uuid        PRIMARY KEY DEFAULT public.uuidv7(),
  user_id            uuid        NOT NULL REFERENCES core.users(id) ON DELETE CASCADE,
  token_hash         bytea       NOT NULL CHECK (length(token_hash) = 32),
  auth_method        text        NOT NULL CHECK (auth_method IN ('password','oauth','saml','oidc','magic_link','support_impersonation')),
  mfa_level          text        NOT NULL DEFAULT 'none' CHECK (mfa_level IN ('none','mfa','phishing_resistant')),
  org_id             uuid,
  ip                 inet,
  user_agent         text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  last_seen_at       timestamptz NOT NULL DEFAULT now(),
  idle_expires_at    timestamptz NOT NULL,
  expires_at         timestamptz NOT NULL,
  revoked_at         timestamptz,
  CHECK (idle_expires_at <= expires_at)
);
CREATE UNIQUE INDEX sessions_token_hash_uq ON core.sessions (token_hash);
CREATE INDEX sessions_user_active_idx ON core.sessions (user_id) WHERE revoked_at IS NULL;

CREATE TABLE core.shards (
  id                 uuid        PRIMARY KEY DEFAULT public.uuidv7(),
  name               text        NOT NULL UNIQUE CHECK (name ~ '^[a-z0-9-]{3,63}$'),
  region             text        NOT NULL,
  status             text        NOT NULL DEFAULT 'provisioning'
                                 CHECK (status IN ('provisioning','active','full','draining','read_only','retired')),
  dsn_secret_ref     text        NOT NULL,
  writer_endpoint    text        NOT NULL,
  reader_endpoints   text[]      NOT NULL DEFAULT '{}',
  pg_major_version   smallint    NOT NULL DEFAULT 16,
  dedicated_org_id   uuid        REFERENCES core.organizations(id) ON DELETE RESTRICT,
  capacity_weight    integer     NOT NULL DEFAULT 100 CHECK (capacity_weight >= 0),
  workspace_count    integer     NOT NULL DEFAULT 0,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX shards_placement_idx ON core.shards (region, status) WHERE status = 'active';

CREATE TABLE core.workspaces (
  id                         uuid        PRIMARY KEY DEFAULT public.uuidv7(),
  org_id                     uuid        NOT NULL REFERENCES core.organizations(id) ON DELETE CASCADE,
  name                       text        NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  description                text        NOT NULL DEFAULT '',
  status                     text        NOT NULL DEFAULT 'active' CHECK (status IN ('active','trashed','deleted')),
  settings                   jsonb       NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(settings) = 'object'),
  settings_schema_version    smallint    NOT NULL DEFAULT 1,
  created_by                 uuid,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  deleted_at                 timestamptz
);
CREATE INDEX workspaces_org_idx ON core.workspaces (org_id) WHERE deleted_at IS NULL;

CREATE TABLE core.workspace_directory (
  workspace_id     uuid        PRIMARY KEY REFERENCES core.workspaces(id) ON DELETE CASCADE,
  org_id           uuid        NOT NULL REFERENCES core.organizations(id) ON DELETE CASCADE,
  shard_id         uuid        NOT NULL REFERENCES core.shards(id) ON DELETE RESTRICT,
  status           text        NOT NULL DEFAULT 'active' CHECK (status IN ('active','migrating','read_only','deleted')),
  migration_epoch  integer     NOT NULL DEFAULT 0,
  region           text        NOT NULL,
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX workspace_directory_shard_idx ON core.workspace_directory (shard_id);

CREATE TABLE core.base_directory (
  base_id        uuid        PRIMARY KEY,
  workspace_id   uuid        NOT NULL REFERENCES core.workspaces(id) ON DELETE CASCADE,
  org_id         uuid        NOT NULL REFERENCES core.organizations(id) ON DELETE CASCADE,
  shard_id       uuid        NOT NULL REFERENCES core.shards(id) ON DELETE RESTRICT,
  kind           text        NOT NULL DEFAULT 'standard' CHECK (kind IN ('standard','contact_directory')),
  name           text        NOT NULL,
  status         text        NOT NULL DEFAULT 'active' CHECK (status IN ('active','trashed','deleted')),
  order_key      text        NOT NULL DEFAULT 'a0',
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz
);
CREATE INDEX base_directory_workspace_idx ON core.base_directory (workspace_id, order_key) WHERE status = 'active';

CREATE TABLE core.access_grants (
  id              uuid        PRIMARY KEY DEFAULT public.uuidv7(),
  org_id          uuid        NOT NULL REFERENCES core.organizations(id) ON DELETE CASCADE,
  resource_type   text        NOT NULL CHECK (resource_type IN ('org','workspace','base','interface')),
  resource_id     uuid        NOT NULL,
  workspace_id    uuid,
  base_id         uuid,
  principal_type  text        NOT NULL CHECK (principal_type IN ('user','team','service_account')),
  principal_id    uuid        NOT NULL,
  role            text        NOT NULL,
  source          text        NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','invite','scim','domain_auto_join','creator','migration')),
  granted_by      uuid,
  expires_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (
       (resource_type = 'org'       AND role IN ('owner','admin','billing_admin','member','guest'))
    OR (resource_type = 'workspace' AND role IN ('owner','creator','editor','commenter','viewer'))
    OR (resource_type = 'base'      AND role IN ('creator','editor','commenter','viewer','interface_only'))
    OR (resource_type = 'interface' AND role IN ('interface_editor','interface_user'))
  ),
  CHECK (resource_type = 'org' OR workspace_id IS NOT NULL),
  CHECK (resource_type NOT IN ('base','interface') OR base_id IS NOT NULL),
  CHECK (resource_type <> 'org' OR resource_id = org_id)
);
CREATE UNIQUE INDEX access_grants_resource_principal_uq ON core.access_grants (resource_type, resource_id, principal_type, principal_id);
CREATE INDEX access_grants_principal_idx ON core.access_grants (principal_id, principal_type);

CREATE TABLE core.feature_flags (
  key            text        PRIMARY KEY CHECK (key ~ '^[a-z0-9_.-]{2,100}$'),
  description    text        NOT NULL DEFAULT '',
  kind           text        NOT NULL DEFAULT 'boolean' CHECK (kind IN ('boolean','variant','percentage')),
  default_value  jsonb       NOT NULL DEFAULT 'false'::jsonb,
  rules          jsonb       NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(rules) = 'array'),
  status         text        NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  owner_team     text,
  version        integer     NOT NULL DEFAULT 1,
  updated_by     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
