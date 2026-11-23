-- Bootstrap extra manifest follow-ups (spec 2026-11-20-bootstrap-extra-manifest, "As built" R18, R19).
-- - bootstrap_runs.extra_sha256: sha256 of what the extra manifest contributed to the run (NULL
--   without one, and in rows written before this column). A recorded run counts as done only while
--   the latest completed run has the same extra part, so re-adding an extra manifest after its
--   removal runs it again (R18).
-- - bootstrap_run_started: at most one row, the run that has written but not completed yet, with
--   the names of its extra entries. A process without an extra manifest reads it as a trace before
--   the first run with that manifest completes (R19); completing a run deletes it.
ALTER TABLE bootstrap_runs ADD COLUMN IF NOT EXISTS extra_sha256 text
  CHECK (extra_sha256 ~ '^[0-9a-f]{64}$');

CREATE TABLE IF NOT EXISTS bootstrap_run_started (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  manifest_sha256 text NOT NULL CHECK (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  extra_plugins jsonb NOT NULL,
  started_at timestamptz NOT NULL
);
