-- Legacy retirement and the fail-closed reuse barrier (permission runtime cutover phase 8.5).

-- The durable legacy-launch freeze: one row, written once under the platform authority writer
-- (the exclusive platform permission lock). A legacy SID launch checks it under the shared
-- platform lock immediately before its dispatch, so once the row is committed no replica running
-- this code can start another legacy task. It is never removed.
CREATE TABLE IF NOT EXISTS legacy_launch_freeze (
  id text PRIMARY KEY CHECK (id = 'platform'),
  frozen_at timestamptz NOT NULL DEFAULT now(),
  frozen_by text NOT NULL CHECK (length(frozen_by) BETWEEN 1 AND 200)
);

-- Whether a legacy launch may have dispatched its command. 'unknown': a row written by a replica
-- without this marker (every row before this migration, and any row of an old replica): it may
-- have dispatched. 'reserved': reserved by this code and not admitted for dispatch (yet).
-- 'dispatched': admitted by the freeze check; its command may run. The default stays 'unknown',
-- so a row inserted by an old, unfenced replica never reads as never dispatched.
ALTER TABLE background_tasks ADD COLUMN IF NOT EXISTS legacy_dispatch text NOT NULL DEFAULT 'unknown';
ALTER TABLE background_tasks DROP CONSTRAINT IF EXISTS background_tasks_legacy_dispatch_check;
ALTER TABLE background_tasks ADD CONSTRAINT background_tasks_legacy_dispatch_check
  CHECK (legacy_dispatch IN ('unknown', 'reserved', 'dispatched'));
-- The exact incarnation a dispatch was admitted for (provider and generation, read under the
-- launch's shared lease): a reservation that never got its sid still names where it may run. NULL
-- on historical rows: their incarnation is `unknown`, never guessed from the current instance.
ALTER TABLE background_tasks ADD COLUMN IF NOT EXISTS legacy_dispatch_provider text;
ALTER TABLE background_tasks ADD COLUMN IF NOT EXISTS legacy_dispatch_generation text;
ALTER TABLE background_tasks DROP CONSTRAINT IF EXISTS background_tasks_legacy_dispatch_generation_check;
ALTER TABLE background_tasks ADD CONSTRAINT background_tasks_legacy_dispatch_generation_check
  CHECK (legacy_dispatch_generation IS NULL OR legacy_dispatch_generation ~ '^[0-9]{1,16}$');

-- The physical no-reuse obligation of one old instance incarnation: the device, its provider and
-- the exact instance generation (the epoch millisecond of device_instances.created_at; 'unknown'
-- when a possibly dispatched legacy launch names no instance). No foreign key: it outlives the
-- task rows, the instance row and output retention. 'open': not yet retired; 'quarantined': no
-- trusted way to establish termination exists (a local machine, a replaced or unknown
-- incarnation without recorded destruction): the device stays unavailable; 'resolved': the
-- provider confirmed the incarnation destroyed. A quarantined device is not retired.
-- 'abandoned': the device was deleted while the obligation was unresolved; no device can reuse the
-- incarnation (device ids are never reused), but it is no evidence that its processes ended.
CREATE TABLE IF NOT EXISTS device_retirement_obligations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id text NOT NULL,
  org_id text NOT NULL,
  provider text NOT NULL CHECK (length(provider) BETWEEN 1 AND 200),
  instance_generation text NOT NULL
    CHECK (instance_generation = 'unknown' OR instance_generation ~ '^[0-9]{1,16}$'),
  state text NOT NULL DEFAULT 'open'
    CHECK (state IN ('open', 'quarantined', 'resolved', 'abandoned')),
  resolution text CHECK (resolution IS NULL OR resolution IN ('provider-destroyed', 'host-rebooted')),
  -- a local incarnation: the machine and its OS boot identity current when the obligation was
  -- recorded; NULL boot_id (none reported) never resolves by itself
  boot_machine_id uuid,
  boot_id text,
  reason text,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_attempt_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  abandoned_at timestamptz,
  CHECK ((state = 'abandoned') = (abandoned_at IS NOT NULL)),
  CHECK ((state = 'resolved') = (resolution IS NOT NULL AND resolved_at IS NOT NULL)),
  UNIQUE (device_id, provider, instance_generation)
);
CREATE INDEX IF NOT EXISTS device_retirement_obligations_unresolved_idx
  ON device_retirement_obligations (device_id) WHERE state IN ('open', 'quarantined');

-- What put an obligation there: a legacy task row (by task id) or a revoked managed background
-- start whose recorded generation no longer runs (by operation id). Kept apart from the task and
-- intent rows; `settled`: the member's own record was settled after the obligation resolved
-- (the intent's revocation acknowledged, the task's owed cancellation settled).
CREATE TABLE IF NOT EXISTS device_retirement_members (
  obligation_id uuid NOT NULL REFERENCES device_retirement_obligations(id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN ('legacy-task', 'revoked-start')),
  ref_id text NOT NULL,
  settled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, ref_id, obligation_id)
);
CREATE INDEX IF NOT EXISTS device_retirement_members_obligation_idx
  ON device_retirement_members (obligation_id);

-- Provider-confirmed destruction of a cloud instance incarnation, recorded by the kernel's own
-- whole-instance destroy when the provider's destroy resolved. A local destroy is a no-op and is
-- never recorded. No foreign key: it outlives the instance row.
CREATE TABLE IF NOT EXISTS device_instance_destructions (
  device_id text NOT NULL,
  provider text NOT NULL,
  instance_generation text NOT NULL CHECK (instance_generation ~ '^[0-9]{1,16}$'),
  destroyed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (device_id, provider, instance_generation)
);

-- The worker's enumeration runs every tick: only the rows it may select are indexed.
CREATE INDEX IF NOT EXISTS background_tasks_legacy_retirement_idx
  ON background_tasks (device_id)
  WHERE launch_state = 'legacy' AND device_id IS NOT NULL
    AND (status = 'running' OR kill_pending OR sid IS NULL);
CREATE INDEX IF NOT EXISTS sandbox_operation_intents_owed_background_revoke_idx
  ON sandbox_operation_intents (device_id)
  WHERE method = 'backgroundStart' AND state = 'revoked' AND NOT revoke_acknowledged
    AND execution_ref IS NOT NULL;

-- The OS boot identities a machine reported in its authenticated hellos, in the order first seen.
-- A later boot of the same machine proves the host restarted since an earlier one, so no process of
-- the earlier boot can exist (a local legacy obligation resolves). A boot reported again after a
-- later one (a stale or replayed report) is ignored. Kept with the machine row.
CREATE TABLE IF NOT EXISTS device_machine_boots (
  machine_id uuid NOT NULL REFERENCES device_machines(id) ON DELETE CASCADE,
  boot_id text NOT NULL CHECK (boot_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  seq bigserial NOT NULL,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (machine_id, boot_id)
);
-- the machine's current boot: the latest first seen
ALTER TABLE device_machines ADD COLUMN IF NOT EXISTS boot_id text;
