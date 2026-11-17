-- Durable launch identity for managed background tasks (permission runtime cutover phase 8.2).
-- An acknowledged backgroundStart keeps its intent as live running authority
-- ('background-running') with the exact typed execution reference; foreground completion never
-- retires it. Legacy SID rows keep launch_state 'legacy' and are never converted.
ALTER TABLE sandbox_operation_intents ADD COLUMN IF NOT EXISTS execution_ref jsonb;
ALTER TABLE sandbox_operation_intents DROP CONSTRAINT IF EXISTS sandbox_operation_intents_state_check;
ALTER TABLE sandbox_operation_intents ADD CONSTRAINT sandbox_operation_intents_state_check
  CHECK (state IN ('pending','admitted','dispatching','started-or-unknown','background-running','completed','revoked'));
ALTER TABLE sandbox_operation_intents DROP CONSTRAINT IF EXISTS sandbox_operation_intents_execution_ref_check;
ALTER TABLE sandbox_operation_intents ADD CONSTRAINT sandbox_operation_intents_execution_ref_check
  CHECK (
    (execution_ref IS NULL OR (method = 'backgroundStart' AND jsonb_typeof(execution_ref) = 'object'))
    AND (state <> 'background-running' OR (method = 'backgroundStart' AND execution_ref IS NOT NULL))
  );

-- The launch reservation of a managed task, persisted before dispatch. pending: pre-effect;
-- dispatched: dispatched or consumed with an unknown outcome (a null ref is no proof of no
-- launch); acknowledged: exact ref recorded; cancel-pending: cancellation owed for a launched or
-- possibly launched task; terminal: settled.
ALTER TABLE background_tasks ADD COLUMN IF NOT EXISTS launch_state text NOT NULL DEFAULT 'legacy';
ALTER TABLE background_tasks ADD COLUMN IF NOT EXISTS operation_id text;
ALTER TABLE background_tasks ADD COLUMN IF NOT EXISTS input_digest text;
ALTER TABLE background_tasks ADD COLUMN IF NOT EXISTS run_execution_id text;
ALTER TABLE background_tasks ADD COLUMN IF NOT EXISTS task_tag text;
ALTER TABLE background_tasks ADD COLUMN IF NOT EXISTS instance_id text;
ALTER TABLE background_tasks ADD COLUMN IF NOT EXISTS instance_provider text;
ALTER TABLE background_tasks ADD COLUMN IF NOT EXISTS instance_provider_version text;
ALTER TABLE background_tasks ADD COLUMN IF NOT EXISTS instance_generation text;
ALTER TABLE background_tasks ADD COLUMN IF NOT EXISTS profile_revision integer;
ALTER TABLE background_tasks ADD COLUMN IF NOT EXISTS ceiling_revision text;
ALTER TABLE background_tasks ADD COLUMN IF NOT EXISTS permission_grant_id text;
ALTER TABLE background_tasks ADD COLUMN IF NOT EXISTS network_authority jsonb;
ALTER TABLE background_tasks ADD COLUMN IF NOT EXISTS working_root text;
ALTER TABLE background_tasks ADD COLUMN IF NOT EXISTS retain_until timestamptz;
ALTER TABLE background_tasks ADD COLUMN IF NOT EXISTS execution_ref jsonb;
ALTER TABLE background_tasks ADD COLUMN IF NOT EXISTS cancel_requested_at timestamptz;
ALTER TABLE background_tasks DROP CONSTRAINT IF EXISTS background_tasks_launch_state_check;
ALTER TABLE background_tasks ADD CONSTRAINT background_tasks_launch_state_check
  CHECK (launch_state IN ('legacy','pending','dispatched','acknowledged','cancel-pending','terminal'));
ALTER TABLE background_tasks DROP CONSTRAINT IF EXISTS background_tasks_managed_reservation_check;
ALTER TABLE background_tasks ADD CONSTRAINT background_tasks_managed_reservation_check
  CHECK (
    launch_state = 'legacy'
    OR (operation_id IS NOT NULL AND working_root IS NOT NULL AND retain_until IS NOT NULL
        AND left(output_path, 1) = '/')
  );
ALTER TABLE background_tasks DROP CONSTRAINT IF EXISTS background_tasks_managed_dispatch_check;
ALTER TABLE background_tasks ADD CONSTRAINT background_tasks_managed_dispatch_check
  CHECK (
    launch_state IN ('legacy','pending','terminal')
    OR (input_digest IS NOT NULL AND run_execution_id IS NOT NULL AND task_tag IS NOT NULL
        AND instance_id IS NOT NULL AND instance_provider IS NOT NULL
        AND instance_provider_version IS NOT NULL AND instance_generation IS NOT NULL
        AND profile_revision IS NOT NULL AND ceiling_revision IS NOT NULL)
  );
ALTER TABLE background_tasks DROP CONSTRAINT IF EXISTS background_tasks_execution_ref_check;
ALTER TABLE background_tasks ADD CONSTRAINT background_tasks_execution_ref_check
  CHECK (
    (execution_ref IS NULL OR (launch_state IN ('acknowledged','cancel-pending','terminal')
      AND jsonb_typeof(execution_ref) = 'object'))
    AND (launch_state <> 'acknowledged' OR execution_ref IS NOT NULL)
  );
CREATE UNIQUE INDEX IF NOT EXISTS background_tasks_operation_idx
  ON background_tasks (operation_id) WHERE operation_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS background_tasks_managed_call_idx
  ON background_tasks (run_id, call_id) WHERE launch_state <> 'legacy';
