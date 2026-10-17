CREATE TABLE IF NOT EXISTS capybara.secrets (
  namespace text NOT NULL,
  org_id text NOT NULL,
  key text NOT NULL,
  ciphertext bytea NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (namespace, org_id, key)
);
