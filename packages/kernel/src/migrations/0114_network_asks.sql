-- Network asks (network ask-to-allow spec §6.1): an approval of kind 'network' asks the device owner
-- to allow domains a command was refused. `detail` holds the hosts, the command, the kept command
-- result and, once decided, what took effect. A network ask shares the (run_id, call_id, attempt)
-- numbering of its call with the call's tool approvals: it takes the next attempt after them, and
-- is only asked after the command ran, so no tool approval of the call can follow it.
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'tool';
ALTER TABLE approvals DROP CONSTRAINT IF EXISTS approvals_kind_check;
ALTER TABLE approvals ADD CONSTRAINT approvals_kind_check CHECK (kind IN ('tool', 'network'));
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS detail jsonb;

-- A message from the run's starter skips a pending network ask (spec §6.7). Widening the inline
-- CHECK of 0010 (PG's default name approvals_status_check), like 0108 did for questions.
ALTER TABLE approvals DROP CONSTRAINT IF EXISTS approvals_status_check;
ALTER TABLE approvals ADD CONSTRAINT approvals_status_check
  CHECK (status IN ('pending', 'approved', 'denied', 'expired', 'cancelled', 'skipped'));

-- Run grants and the per-run caps read the network asks of a run tree.
CREATE INDEX IF NOT EXISTS approvals_network_run_idx ON approvals (run_id) WHERE kind = 'network';

-- What the machine's program reported in its hello (spec §5.4): the features it supports and a
-- summary of its local network policy, refreshed by each `policy` operation.
ALTER TABLE device_machines ADD COLUMN IF NOT EXISTS features text[] NOT NULL DEFAULT '{}';
ALTER TABLE device_machines ADD COLUMN IF NOT EXISTS local_policy jsonb;
