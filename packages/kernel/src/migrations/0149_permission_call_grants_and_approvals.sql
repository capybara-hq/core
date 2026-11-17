CREATE TABLE IF NOT EXISTS permission_call_grants (
  id uuid PRIMARY KEY,
  org_id text NOT NULL REFERENCES orgs(id),
  root_conversation_id text NOT NULL REFERENCES conversations(id),
  conversation_id text NOT NULL REFERENCES conversations(id),
  device_id text NOT NULL REFERENCES devices(id),
  account_id text NOT NULL REFERENCES accounts(id),
  run_id text NOT NULL REFERENCES runs(id),
  call_id text NOT NULL,
  tool_key text NOT NULL,
  spec_hash text NOT NULL,
  call_input_hash text NOT NULL,
  resolved_input_hash text NOT NULL,
  profile text NOT NULL CHECK (profile IN ('request-approval', 'approve-for-me', 'full-access')),
  profile_revision integer NOT NULL,
  scope_revision text NOT NULL,
  authority_revision text NOT NULL,
  binding_hash text NOT NULL UNIQUE,
  expansion jsonb NOT NULL,
  expansion_hash text NOT NULL,
  candidate_hash text NOT NULL,
  target_path text,
  scope_kind text NOT NULL CHECK (scope_kind = 'directories-and-hosts'),
  source text NOT NULL CHECK (source IN ('human', 'review-model')),
  approval_id text UNIQUE REFERENCES approvals(id),
  review_event_seq integer,
  decided_by text REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((source = 'human' AND approval_id IS NOT NULL AND decided_by IS NOT NULL AND review_event_seq IS NULL)
    OR (source = 'review-model' AND approval_id IS NULL AND decided_by IS NULL AND review_event_seq IS NOT NULL))
);
ALTER TABLE sandbox_operation_intents ADD COLUMN IF NOT EXISTS permission_grant_id uuid REFERENCES permission_call_grants(id);
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS superseded_revision integer;
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS superseded_reason text;
ALTER TABLE approvals DROP CONSTRAINT IF EXISTS approvals_status_check;
ALTER TABLE approvals ADD CONSTRAINT approvals_status_check CHECK (status IN ('pending', 'approved', 'denied', 'expired', 'cancelled', 'skipped', 'superseded'));
