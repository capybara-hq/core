CREATE TABLE IF NOT EXISTS capybara.accounts (
  id text PRIMARY KEY,
  display_name text NOT NULL,
  email text,
  email_verified boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  is_enterprise_admin boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS capybara.identities (
  source text NOT NULL,
  external_id text NOT NULL,
  account_id text NOT NULL REFERENCES capybara.accounts(id) ON DELETE CASCADE,
  email text,
  email_verified boolean NOT NULL DEFAULT false,
  profile jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source, external_id)
);
CREATE INDEX IF NOT EXISTS identities_account_idx ON capybara.identities (account_id);
CREATE TABLE IF NOT EXISTS capybara.local_passwords (
  account_id text PRIMARY KEY REFERENCES capybara.accounts(id) ON DELETE CASCADE,
  password_hash text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS capybara.orgs (
  id text PRIMARY KEY,
  slug text NOT NULL,
  name text NOT NULL,
  created_by text REFERENCES capybara.accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS orgs_slug_live_uq ON capybara.orgs (slug) WHERE deleted_at IS NULL;
CREATE TABLE IF NOT EXISTS capybara.memberships (
  org_id text NOT NULL REFERENCES capybara.orgs(id) ON DELETE CASCADE,
  account_id text NOT NULL REFERENCES capybara.accounts(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'guest')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, account_id)
);
CREATE INDEX IF NOT EXISTS memberships_account_idx ON capybara.memberships (account_id);
CREATE TABLE IF NOT EXISTS capybara.invitations (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES capybara.orgs(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('admin', 'member', 'guest')),
  token_hash text NOT NULL UNIQUE,
  created_by text NOT NULL REFERENCES capybara.accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  accepted_by text REFERENCES capybara.accounts(id),
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS invitations_org_idx ON capybara.invitations (org_id);
CREATE TABLE IF NOT EXISTS capybara.sessions (
  id text PRIMARY KEY,
  account_id text NOT NULL REFERENCES capybara.accounts(id) ON DELETE CASCADE,
  current_org_id text REFERENCES capybara.orgs(id) ON DELETE SET NULL,
  refresh_hash text NOT NULL UNIQUE,
  prev_refresh_hash text,
  rotated_at timestamptz,
  user_agent text,
  ip text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS sessions_account_idx ON capybara.sessions (account_id);
CREATE INDEX IF NOT EXISTS sessions_prev_refresh_idx ON capybara.sessions (prev_refresh_hash);
CREATE TABLE IF NOT EXISTS capybara.api_tokens (
  id text PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('personal', 'service')),
  account_id text REFERENCES capybara.accounts(id) ON DELETE CASCADE,
  org_id text REFERENCES capybara.orgs(id) ON DELETE CASCADE,
  role text CHECK (role IN ('admin', 'member', 'guest')),
  name text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  created_by text NOT NULL REFERENCES capybara.accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz,
  CHECK (
    (kind = 'personal' AND account_id IS NOT NULL AND org_id IS NULL AND role IS NULL)
    OR (kind = 'service' AND account_id IS NULL AND org_id IS NOT NULL AND role IS NOT NULL)
  )
);
CREATE TABLE IF NOT EXISTS capybara.deployment_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_by text REFERENCES capybara.accounts(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS capybara.plugin_org_configs (
  plugin text NOT NULL,
  org_id text NOT NULL REFERENCES capybara.orgs(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_by text REFERENCES capybara.accounts(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (plugin, org_id)
);
CREATE TABLE IF NOT EXISTS capybara.audit_events (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  actor_account_id text,
  actor_token_id text,
  org_id text,
  action text NOT NULL,
  target text,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS audit_events_org_at_idx ON capybara.audit_events (org_id, at DESC);
