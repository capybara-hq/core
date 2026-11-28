-- A grant letting one extension service of a person's own device reach one loopback port of that
-- device for one conversation tree (browser loopback port grants design,
-- docs/superpowers/specs/2026-11-28-browser-loopback-port-grants-design.md §4 and §6).
-- `conversation_id` is the root conversation; `source` says who decided (the person, the review
-- model, Full access, or the owner's panel). `run_id`, `call_id` and `attempt` name the call that
-- asked (null for the owner's panel), so a grant made without a person resumes as the rerun after a
-- crash. A grant ends by setting `revoked_at` with its `revoke_reason`; at most one live row exists
-- per (device, service, conversation, port).
CREATE TABLE IF NOT EXISTS device_loopback_grants (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  device_id text NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  service_id text NOT NULL,
  conversation_id text NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  port integer NOT NULL CHECK (port BETWEEN 1 AND 65535),
  source text NOT NULL CHECK (source IN ('human', 'review-model', 'full-access', 'owner-panel')),
  approval_id text REFERENCES approvals(id) ON DELETE SET NULL,
  run_id text,
  call_id text,
  attempt integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoke_reason text CHECK (
    revoke_reason IN ('revoked', 'expired', 'conversation-deleted', 'outside-sandbox-off')
  ),
  -- An ended grant always says why; a live one carries no reason.
  CHECK ((revoked_at IS NULL) = (revoke_reason IS NULL)),
  -- The owner's panel asks without a call; every other source names the call that asked.
  CHECK ((source = 'owner-panel') = (run_id IS NULL AND call_id IS NULL AND attempt IS NULL))
);

-- One live grant per (device, service, conversation, port).
CREATE UNIQUE INDEX IF NOT EXISTS device_loopback_grants_live_uidx
  ON device_loopback_grants (device_id, service_id, conversation_id, port)
  WHERE revoked_at IS NULL;

-- The sweep's scan of live grants past their expiry.
CREATE INDEX IF NOT EXISTS device_loopback_grants_expiry_idx
  ON device_loopback_grants (expires_at)
  WHERE revoked_at IS NULL;

-- The retention sweep's scan of ended grants (deleted 30 days after they end).
CREATE INDEX IF NOT EXISTS device_loopback_grants_ended_idx
  ON device_loopback_grants (revoked_at)
  WHERE revoked_at IS NOT NULL;

-- The by-root revocation (conversation deleted) and refresh scans of live grants.
CREATE INDEX IF NOT EXISTS device_loopback_grants_root_idx
  ON device_loopback_grants (conversation_id)
  WHERE revoked_at IS NULL;

-- The rerun's lookup of the grant its call made.
CREATE INDEX IF NOT EXISTS device_loopback_grants_call_idx
  ON device_loopback_grants (run_id, call_id)
  WHERE run_id IS NOT NULL;

DROP POLICY IF EXISTS org_scope ON device_loopback_grants;
CREATE POLICY org_scope ON device_loopback_grants USING (rls_admits(org_id)) WITH CHECK (rls_admits(org_id));
