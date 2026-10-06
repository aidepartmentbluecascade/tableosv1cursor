-- Workstream G: auth hardening.
--  * short-lived auth challenges (MFA login step, pending MFA enrollment, OAuth state)
--    stored in Postgres instead of process memory
--  * sessions may be minted for automation runs (service sessions)

CREATE TABLE IF NOT EXISTS core.auth_challenges (
  id          uuid        PRIMARY KEY DEFAULT public.uuidv7(),
  kind        text        NOT NULL CHECK (kind IN ('mfa_login','mfa_enroll','oauth_state')),
  token_hash  bytea       NOT NULL CHECK (length(token_hash) = 32),
  user_id     uuid        REFERENCES core.users(id) ON DELETE CASCADE,
  data        jsonb       NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(data) = 'object'),
  attempts    integer     NOT NULL DEFAULT 0,
  expires_at  timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS auth_challenges_token_uq ON core.auth_challenges (kind, token_hash);
CREATE INDEX IF NOT EXISTS auth_challenges_user_idx ON core.auth_challenges (user_id, kind);
CREATE INDEX IF NOT EXISTS auth_challenges_expiry_idx ON core.auth_challenges (expires_at);

ALTER TABLE core.sessions DROP CONSTRAINT IF EXISTS sessions_auth_method_check;
ALTER TABLE core.sessions ADD CONSTRAINT sessions_auth_method_check
  CHECK (auth_method IN ('password','oauth','saml','oidc','magic_link','support_impersonation','automation'));
