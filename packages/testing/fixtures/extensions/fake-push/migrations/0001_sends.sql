-- Runs with search_path "plugin_fake_push, public": table names carry no schema prefix.
-- Every send attempt (one row per registration per call), so dual-replica tests count across processes.
CREATE TABLE IF NOT EXISTS sends (
  id bigserial PRIMARY KEY,
  registration_id text NOT NULL,
  job_marker text NOT NULL DEFAULT '',
  message jsonb NOT NULL,
  at timestamptz NOT NULL DEFAULT now()
);
