-- A shared rotating cursor bounds each recovery pass without starving later active runs.
CREATE TABLE IF NOT EXISTS run_recovery_cursors (
  name text PRIMARY KEY,
  since timestamptz,
  run_id text
);
