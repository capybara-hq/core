-- Approval-only profiles (design 2026-11-19, "Kernel: decision, admission and records"): Full
-- access grants a crossing within the device's ceilings by itself, so a call grant's evidence may
-- also be a Full access auto-grant, recorded like the review model's by its `permission_reviewed`
-- event (`review_event_seq`), with no approval and no deciding account.
ALTER TABLE permission_call_grants DROP CONSTRAINT IF EXISTS permission_call_grants_source_check;
ALTER TABLE permission_call_grants ADD CONSTRAINT permission_call_grants_source_check
  CHECK (source IN ('human', 'review-model', 'full-access'));
-- the evidence shape of each source (0150 created it unnamed: PostgreSQL named it `_check`)
ALTER TABLE permission_call_grants DROP CONSTRAINT IF EXISTS permission_call_grants_check;
ALTER TABLE permission_call_grants DROP CONSTRAINT IF EXISTS permission_call_grants_evidence_check;
ALTER TABLE permission_call_grants ADD CONSTRAINT permission_call_grants_evidence_check
  CHECK ((source = 'human' AND approval_id IS NOT NULL AND decided_by IS NOT NULL AND review_event_seq IS NULL)
    OR (source IN ('review-model', 'full-access') AND approval_id IS NULL AND decided_by IS NULL
      AND review_event_seq IS NOT NULL));
