-- Per-call sandbox escalation (approval profiles design, "Per-call sandbox escalation"): a call
-- grant may run one Bash call outside the OS sandbox; its justification is part of the evidence.
ALTER TABLE permission_call_grants ADD COLUMN IF NOT EXISTS escalation jsonb;
ALTER TABLE permission_call_grants DROP CONSTRAINT IF EXISTS permission_call_grants_scope_kind_check;
ALTER TABLE permission_call_grants ADD CONSTRAINT permission_call_grants_scope_kind_check
  CHECK (scope_kind IN ('directories-and-hosts', 'sandbox-escalation'));
ALTER TABLE permission_call_grants DROP CONSTRAINT IF EXISTS permission_call_grants_escalation_check;
ALTER TABLE permission_call_grants ADD CONSTRAINT permission_call_grants_escalation_check
  CHECK ((scope_kind = 'sandbox-escalation') = (escalation IS NOT NULL));
