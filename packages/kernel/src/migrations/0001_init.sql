CREATE SCHEMA IF NOT EXISTS capybara;

CREATE TABLE IF NOT EXISTS capybara.org_data_keys (
  org_id text PRIMARY KEY,
  wrapped_key bytea NOT NULL,
  master_key_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
