-- Preserve exact starting grants for consumed retries; null historical rows remain unavailable.
ALTER TABLE sandbox_operation_intents ADD COLUMN IF NOT EXISTS execution_grants jsonb;
ALTER TABLE sandbox_operation_intents DROP CONSTRAINT IF EXISTS sandbox_operation_intents_method_check;
ALTER TABLE sandbox_operation_intents ADD CONSTRAINT sandbox_operation_intents_method_check
  CHECK (method IN ('exec','backgroundStart','readFile','writeFile','stat','list','scan'));
ALTER TABLE sandbox_operation_intents DROP CONSTRAINT IF EXISTS sandbox_operation_intents_execution_grants_check;
ALTER TABLE sandbox_operation_intents ADD CONSTRAINT sandbox_operation_intents_execution_grants_check
  CHECK (execution_grants IS NULL OR (method IN ('exec','backgroundStart') AND jsonb_typeof(execution_grants) = 'object'));
