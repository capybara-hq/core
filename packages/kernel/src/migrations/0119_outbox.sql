-- Transactional outbox (transactional outbox spec §4): work that must follow a commit is written
-- here in the same transaction as the state that owes it, and a relay delivers it to BullMQ. Rows are
-- deleted on delivery; only dead rows (`dead_at` set) stay.

CREATE TABLE IF NOT EXISTS outbox (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  queue text NOT NULL,
  job_name text NOT NULL,
  job_id text NOT NULL,
  data jsonb NOT NULL,
  run_at timestamptz,
  org_id text,                       -- for the overview and for org deletion; NULL for platform work
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  dead_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- one pending row per job: a second add of the same job before delivery is a no-op
CREATE UNIQUE INDEX IF NOT EXISTS outbox_job_uniq ON outbox (queue, job_id);
CREATE INDEX IF NOT EXISTS outbox_due ON outbox (next_attempt_at) WHERE dead_at IS NULL;
