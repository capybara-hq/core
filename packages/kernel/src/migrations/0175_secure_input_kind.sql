-- Secure input (profiles govern every approval, ruling R4): a request for a call's secret fields is
-- an approval of kind 'secure_input', so it reuses waiting, expiry, the inbox, the decision route
-- and the sealed input store. Widen the kind CHECK, the same pattern as 0114, 0126 and 0130.
-- Dropping and re-adding it in one transaction is safe: every existing row satisfies the new
-- definition.
ALTER TABLE approvals DROP CONSTRAINT IF EXISTS approvals_kind_check;
ALTER TABLE approvals ADD CONSTRAINT approvals_kind_check
  CHECK (kind IN ('tool', 'network', 'git', 'command', 'secure_input'));
