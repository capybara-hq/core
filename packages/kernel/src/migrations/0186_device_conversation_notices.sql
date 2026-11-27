-- The kernel's notices owed to a device's services about a conversation (browser close tabs on
-- delete design, docs/superpowers/specs/2026-11-27-browser-close-tabs-on-delete-design.md §4.1):
-- written in the transaction that deletes the conversation, delivered by the worker (a prompt
-- outbox job, then the sweep) to every running extension service of the device, deleted once
-- delivered. `acked_services` lists the service ids that answered; `claimed_until` is the row
-- lease of the attempt under way (one attempt per row across replicas).
CREATE TABLE IF NOT EXISTS device_conversation_notices (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  device_id text NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  conversation_id text NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('conversation_deleted')),
  created_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  claimed_until timestamptz,
  acked_services text[] NOT NULL DEFAULT '{}',
  last_failure text,
  UNIQUE (device_id, conversation_id, kind)
);

-- The sweep's scan: owed rows whose turn came, oldest turn first.
CREATE INDEX IF NOT EXISTS device_conversation_notices_due_idx
  ON device_conversation_notices (next_attempt_at);

DROP POLICY IF EXISTS org_scope ON device_conversation_notices;
CREATE POLICY org_scope ON device_conversation_notices USING (rls_admits(org_id)) WITH CHECK (rls_admits(org_id));
