CREATE TABLE IF NOT EXISTS sandbox_operation_intents (
  operation_id text PRIMARY KEY,
  org_id text NOT NULL,
  account_id text NOT NULL,
  device_id text NOT NULL,
  root_conversation_id text,
  conversation_id text,
  run_id text,
  call_id text,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  method text NOT NULL CHECK (method IN ('exec','readFile','writeFile','stat','list','scan')),
  input_hash text NOT NULL,
  admission_hash text NOT NULL,
  granted_hosts jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(granted_hosts) = 'array'),
  input jsonb NOT NULL,
  scope jsonb NOT NULL,
  epochs jsonb NOT NULL,
  provider text NOT NULL,
  provider_version text NOT NULL,
  instance_generation text NOT NULL,
  deadline timestamptz NOT NULL,
  retain_until timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','admitted','dispatching','started-or-unknown','completed','revoked')),
  execution_id text NOT NULL,
  holder_token text NOT NULL DEFAULT '',
  result jsonb,
  outcome_unknown boolean NOT NULL DEFAULT false,
  reconcile_attempt integer NOT NULL DEFAULT 0,
  revoke_acknowledged boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(run_id, call_id, ordinal),
  CHECK (octet_length(input::text) <= 1048576),
  CHECK (result IS NULL OR octet_length(result::text) <= 1048576)
);
CREATE INDEX IF NOT EXISTS sandbox_operation_active_ceiling ON sandbox_operation_intents(org_id, device_id, state);
CREATE INDEX IF NOT EXISTS sandbox_operation_retention ON sandbox_operation_intents(retain_until);
CREATE TABLE IF NOT EXISTS permission_config_publication (
  id text PRIMARY KEY CHECK (id = 'platform'),
  fingerprint text NOT NULL,
  projection jsonb NOT NULL CHECK (jsonb_typeof(projection) = 'object' AND octet_length(projection::text) <= 131072),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE permission_authority_epochs ADD COLUMN IF NOT EXISTS full_revision integer NOT NULL DEFAULT 0 CHECK (full_revision >= 0);

ALTER TABLE device_instances ADD COLUMN IF NOT EXISTS permission_runtime_identity jsonb;
CREATE TABLE IF NOT EXISTS device_permission_reports (
  device_id text PRIMARY KEY,
  provider text NOT NULL,
  provider_version text NOT NULL,
  instance_generation text NOT NULL,
  identity_hash text NOT NULL,
  report jsonb NOT NULL CHECK (octet_length(report::text) <= 16384),
  observed_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE device_instances ADD COLUMN IF NOT EXISTS permission_roots jsonb;

CREATE TABLE IF NOT EXISTS sandbox_operation_payload_chunks (
  operation_id text NOT NULL REFERENCES sandbox_operation_intents(operation_id) ON DELETE CASCADE,
  slot text NOT NULL CHECK (slot IN ('input','result')),
  sequence integer NOT NULL CHECK (sequence >= 0),
  data bytea NOT NULL CHECK (octet_length(data) BETWEEN 1 AND 65536),
  PRIMARY KEY(operation_id, slot, sequence)
);
