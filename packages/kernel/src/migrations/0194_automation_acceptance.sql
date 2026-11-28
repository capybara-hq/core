-- Directed events and acceptance (collaboration spec 2026-11-25 §4.4): what a person lets an
-- extension's directed events (an item assigned to them and their agent) do.
-- - `automation_acceptance`: a person's rule per trigger source in one org: `auto` (the kernel's
--   acceptance automation runs the work), `confirm` (an offer waits in their inbox) or `off`
--   (nothing runs). No row = the org's `automations.directedDefault` (default `auto`).
-- - `automation_offers`: work offered to a person under `confirm`, one per directed event: `open`
--   until the person accepts or declines it; one `open` past seven days counts as closed and is
--   set `expired` by the trigger event sweep (or when it is next read). `inbox_item_id` is the
--   push-carrying inbox item it resolves when decided; `automation_id` the acceptance automation
--   an accept delivered the event to.
-- - The acceptance automation of (org, person, source, agent) is one live row of `automations`
--   (`origin = 'acceptance'`): the partial unique index makes two directed events dispatched at
--   once create one.
-- Ids are text like every kernel id. Both tables carry `org_id` and their `org_scope` policies
-- (still dark: nothing enables row level security before phase 5).

CREATE TABLE IF NOT EXISTS automation_acceptance (
  org_id text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  account_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- the trigger source (extension name)
  source text NOT NULL,
  mode text NOT NULL CHECK (mode IN ('auto', 'confirm', 'off')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, account_id, source)
);

DROP POLICY IF EXISTS org_scope ON automation_acceptance;
CREATE POLICY org_scope ON automation_acceptance
  USING (rls_admits(org_id)) WITH CHECK (rls_admits(org_id));

CREATE TABLE IF NOT EXISTS automation_offers (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  -- the person the work is offered to (the event's audience account)
  account_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- the directed event; the offer goes when retention deletes it
  event_id text NOT NULL REFERENCES trigger_events(id) ON DELETE CASCADE,
  -- the trigger source and the audience agent (no foreign key: an agent deleted since is
  -- refused when the offer is accepted)
  source text NOT NULL,
  agent_id text NOT NULL,
  -- the acceptance automation an accept delivered the event to
  automation_id text,
  inbox_item_id text,
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'accepted', 'declined', 'expired')),
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz
);

-- one offer per directed event (a retried dispatch finds it)
CREATE UNIQUE INDEX IF NOT EXISTS automation_offers_event_uq ON automation_offers (event_id);

-- a person's open offers (the inbox read)
CREATE INDEX IF NOT EXISTS automation_offers_open_idx
  ON automation_offers (org_id, account_id) WHERE state = 'open';

DROP POLICY IF EXISTS org_scope ON automation_offers;
CREATE POLICY org_scope ON automation_offers
  USING (rls_admits(org_id)) WITH CHECK (rls_admits(org_id));

-- one live acceptance automation per (org, person, source, agent)
CREATE UNIQUE INDEX IF NOT EXISTS automations_acceptance_uq
  ON automations (org_id, account_id, agent_id, (trigger->>'source'))
  WHERE origin = 'acceptance' AND deleted_at IS NULL;

-- the trigger event sweep's look for directed events still pending (a dispatch passed them over)
CREATE INDEX IF NOT EXISTS trigger_events_pending_directed_idx
  ON trigger_events (created_at) WHERE state = 'pending' AND audience IS NOT NULL;

-- Directed events stored before this file were left `pending` by the dispatcher (it had no
-- acceptance routing yet), and their dispatch job is done: owe each its `trigger-dispatch` job
-- again through the outbox (the relay delivers it to the maintenance queue), with an id of its
-- own so a kept job of the first dispatch does not swallow it. The job routes them now. The
-- names are the kernel's constants: queue `MAINTENANCE_QUEUE_NAME`
-- (runtime/maintenance-queue.ts), job `TRIGGER_DISPATCH_JOB`, id `triggerDispatchJobId(id)` plus a
-- suffix and data `TriggerDispatchJobData` (automations/job-ids.ts). Events a worker from before
-- this release passes over during a rolling deploy are owed again by the trigger event sweep.
INSERT INTO outbox (queue, job_name, job_id, data, org_id)
SELECT 'cap-kernel-maintenance', 'trigger-dispatch', 'trigger-dispatch-' || id || '-acceptance',
  jsonb_build_object('orgId', org_id, 'eventId', id), org_id
FROM trigger_events
WHERE state = 'pending' AND audience IS NOT NULL
ON CONFLICT DO NOTHING;
