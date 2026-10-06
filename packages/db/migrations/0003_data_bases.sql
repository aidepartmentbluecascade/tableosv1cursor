-- Data plane: bases, runtime, change log, records (MVP — no hash/time partitions)

CREATE OR REPLACE FUNCTION data.is_field_type(t text) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT t IN ('text','long_text','number','currency','percent','date','datetime','duration','checkbox',
               'single_select','multi_select','email','phone','url','rating','collaborator','attachment','barcode',
               'link','contact','formula','lookup','rollup','count','autonumber','created_time','modified_time',
               'created_by','modified_by','button','ai_generated','json')
$$;

CREATE OR REPLACE FUNCTION data.is_actor_type(t text) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT t IN ('user','api_token','service_account','automation','integration','ai','system','public_form')
$$;

CREATE OR REPLACE FUNCTION data.is_via(t text) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT t IN ('ui','api','automation','import','sync','form','script','undo','redo','restore','system')
$$;

CREATE TABLE data.bases (
  id                      uuid        PRIMARY KEY DEFAULT public.uuidv7(),
  workspace_id            uuid        NOT NULL,
  kind                    text        NOT NULL DEFAULT 'standard' CHECK (kind IN ('standard','contact_directory')),
  name                    text        NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  description             text        NOT NULL DEFAULT '',
  settings                jsonb       NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(settings) = 'object'),
  settings_schema_version smallint    NOT NULL DEFAULT 1,
  schema_version          bigint      NOT NULL DEFAULT 1,
  write_fenced            boolean     NOT NULL DEFAULT false,
  created_by              uuid,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_by              uuid,
  updated_at              timestamptz NOT NULL DEFAULT now(),
  deleted_at              timestamptz,
  deleted_by              uuid
);
CREATE INDEX bases_workspace_idx ON data.bases (workspace_id) WHERE deleted_at IS NULL;

CREATE TABLE data.base_runtime (
  base_id                   uuid        PRIMARY KEY REFERENCES data.bases(id) ON DELETE CASCADE,
  workspace_id              uuid        NOT NULL,
  change_seq                bigint      NOT NULL DEFAULT 0,
  perm_epoch                bigint      NOT NULL DEFAULT 1,
  schema_version            bigint      NOT NULL DEFAULT 1,
  automation_index_version  bigint      NOT NULL DEFAULT 1,
  record_count              bigint      NOT NULL DEFAULT 0,
  last_change_at            timestamptz,
  updated_at                timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE data.idempotency_keys (
  workspace_id     uuid        NOT NULL,
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
  PRIMARY KEY (workspace_id, principal_id, key)
);
CREATE INDEX idempotency_keys_expiry_idx ON data.idempotency_keys (expires_at);

CREATE TABLE data.outbox_events (
  id                uuid        NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  org_id            uuid        NOT NULL,
  workspace_id      uuid        NOT NULL,
  base_id           uuid,
  event_type        text        NOT NULL CHECK (event_type ~ '^[a-z_]+\.[a-z_]+$'),
  schema_version    smallint    NOT NULL DEFAULT 1,
  topic             text        NOT NULL DEFAULT 'tabula.domain-events.v1',
  partition_key     text        NOT NULL,
  aggregate_type    text        NOT NULL,
  aggregate_id      uuid        NOT NULL,
  base_seq          bigint,
  actor             jsonb       NOT NULL CHECK (jsonb_typeof(actor) = 'object'),
  correlation_id    uuid,
  causation_id      uuid,
  causation_depth   smallint    NOT NULL DEFAULT 0,
  payload           jsonb       NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  PRIMARY KEY (id, created_at)
);

CREATE TABLE data.base_changes (
  base_id             uuid        NOT NULL,
  seq                 bigint      NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  id                  uuid        NOT NULL DEFAULT public.uuidv7(),
  workspace_id        uuid        NOT NULL,
  kind                text        NOT NULL CHECK (kind IN ('records','links','schema','views','interfaces','automations','comments','undo','redo','restore','bulk')),
  ops                 jsonb       NOT NULL CHECK (jsonb_typeof(ops) = 'array'),
  inverse_ops         jsonb       CHECK (inverse_ops IS NULL OR jsonb_typeof(inverse_ops) = 'array'),
  op_count            integer     NOT NULL CHECK (op_count >= 1),
  table_ids           uuid[]      NOT NULL DEFAULT '{}',
  actor_type          text        NOT NULL CHECK (data.is_actor_type(actor_type)),
  actor_id            uuid,
  via                 text        NOT NULL CHECK (data.is_via(via)),
  session_id          uuid,
  client_mutation_id  text,
  correlation_id      uuid,
  schema_version      bigint      NOT NULL,
  PRIMARY KEY (base_id, seq)
);
CREATE INDEX base_changes_created_idx ON data.base_changes (base_id, created_at DESC);

CREATE TABLE data.tables (
  id                      uuid        PRIMARY KEY DEFAULT public.uuidv7(),
  workspace_id            uuid        NOT NULL,
  base_id                 uuid        NOT NULL REFERENCES data.bases(id) ON DELETE CASCADE,
  kind                    text        NOT NULL DEFAULT 'standard' CHECK (kind IN ('standard','contacts','sync')),
  name                    text        NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  description             text        NOT NULL DEFAULT '',
  primary_field_id        uuid,       -- FK added in 0004 (circular with fields)
  order_key               text        NOT NULL,
  next_field_slot         smallint    NOT NULL DEFAULT 1 CHECK (next_field_slot BETWEEN 1 AND 32000),
  next_row_number         bigint      NOT NULL DEFAULT 1 CHECK (next_row_number >= 1),
  record_count            bigint      NOT NULL DEFAULT 0,
  settings                jsonb       NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(settings) = 'object'),
  settings_schema_version smallint    NOT NULL DEFAULT 1,
  created_by              uuid,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_by              uuid,
  updated_at              timestamptz NOT NULL DEFAULT now(),
  deleted_at              timestamptz,
  deleted_by              uuid
);
CREATE INDEX tables_base_idx ON data.tables (base_id, order_key) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX tables_base_name_uq ON data.tables (base_id, lower(name)) WHERE deleted_at IS NULL;

CREATE TABLE data.fields (
  id                      uuid        PRIMARY KEY DEFAULT public.uuidv7(),
  workspace_id            uuid        NOT NULL,
  base_id                 uuid        NOT NULL REFERENCES data.bases(id) ON DELETE CASCADE,
  table_id                uuid        NOT NULL REFERENCES data.tables(id) ON DELETE CASCADE,
  slot                    smallint    NOT NULL CHECK (slot >= 1),
  name                    text        NOT NULL CHECK (length(name) BETWEEN 1 AND 255),
  description             text        NOT NULL DEFAULT '',
  type                    text        NOT NULL CHECK (data.is_field_type(type)),
  config                  jsonb       NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(config) = 'object'),
  config_schema_version   smallint    NOT NULL DEFAULT 1,
  order_key               text        NOT NULL,
  is_computed             boolean     NOT NULL DEFAULT false,
  created_by              uuid,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_by              uuid,
  updated_at              timestamptz NOT NULL DEFAULT now(),
  deleted_at              timestamptz,
  deleted_by              uuid,
  CHECK (is_computed = (type IN ('formula','lookup','rollup','count','ai_generated')))
);
CREATE UNIQUE INDEX fields_table_slot_uq ON data.fields (table_id, slot);
CREATE UNIQUE INDEX fields_table_name_uq ON data.fields (table_id, lower(name)) WHERE deleted_at IS NULL;

CREATE TABLE data.records (
  table_id           uuid        NOT NULL,
  id                 uuid        NOT NULL,
  workspace_id       uuid        NOT NULL,
  base_id            uuid        NOT NULL,
  row_number         bigint      NOT NULL,
  manual_order       text        NOT NULL,
  cells              jsonb       NOT NULL DEFAULT '{}'::jsonb,
  computed           jsonb       NOT NULL DEFAULT '{}'::jsonb,
  cell_meta          jsonb       NOT NULL DEFAULT '{}'::jsonb,
  version            bigint      NOT NULL DEFAULT 1,
  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid,
  created_via        text        NOT NULL DEFAULT 'ui' CHECK (data.is_via(created_via)),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  updated_by         uuid,
  last_change_seq    bigint      NOT NULL DEFAULT 0,
  deleted_at         timestamptz,
  deleted_by         uuid,
  PRIMARY KEY (table_id, id),
  CHECK (jsonb_typeof(cells) = 'object' AND jsonb_typeof(computed) = 'object' AND jsonb_typeof(cell_meta) = 'object')
);
CREATE UNIQUE INDEX records_row_number_uq ON data.records (table_id, row_number);
CREATE INDEX records_manual_order_idx ON data.records (table_id, manual_order, id) WHERE deleted_at IS NULL;

CREATE TABLE data.view_sections (
  id                 uuid        PRIMARY KEY DEFAULT public.uuidv7(),
  workspace_id       uuid        NOT NULL,
  base_id            uuid        NOT NULL REFERENCES data.bases(id) ON DELETE CASCADE,
  table_id           uuid        NOT NULL REFERENCES data.tables(id) ON DELETE CASCADE,
  name               text        NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  order_key          text        NOT NULL,
  owner_user_id      uuid,
  created_by         uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  deleted_at         timestamptz
);
CREATE INDEX view_sections_table_idx ON data.view_sections (table_id, order_key) WHERE deleted_at IS NULL;

CREATE TABLE data.views (
  id                     uuid        PRIMARY KEY DEFAULT public.uuidv7(),
  workspace_id           uuid        NOT NULL,
  base_id                uuid        NOT NULL REFERENCES data.bases(id) ON DELETE CASCADE,
  table_id               uuid        NOT NULL REFERENCES data.tables(id) ON DELETE CASCADE,
  section_id             uuid        REFERENCES data.view_sections(id) ON DELETE SET NULL,
  type                   text        NOT NULL CHECK (type IN ('grid','form','calendar','gallery','kanban','timeline','gantt','list')),
  name                   text        NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  description            text        NOT NULL DEFAULT '',
  visibility             text        NOT NULL DEFAULT 'collaborative' CHECK (visibility IN ('collaborative','personal','locked')),
  owner_user_id          uuid,
  config                 jsonb       NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(config) = 'object'),
  config_schema_version  smallint    NOT NULL DEFAULT 1,
  order_key              text        NOT NULL,
  is_default             boolean     NOT NULL DEFAULT false,
  version                bigint      NOT NULL DEFAULT 1,
  created_by             uuid,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_by             uuid,
  updated_at             timestamptz NOT NULL DEFAULT now(),
  deleted_at             timestamptz,
  deleted_by             uuid,
  CHECK ((visibility = 'personal') = (owner_user_id IS NOT NULL))
);
CREATE INDEX views_table_idx ON data.views (table_id, order_key) WHERE deleted_at IS NULL;
