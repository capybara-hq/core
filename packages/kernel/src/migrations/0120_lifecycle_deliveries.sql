-- Durable lifecycle hook deliveries (memory plugin spec §6.3): one row per (event, subscribing
-- plugin), written in the transaction that removes the member, the agent or the org, and delivered
-- by the `cap-kernel-lifecycle` queue after the commit. The sweeper re-enqueues undelivered rows and
-- deletes delivered ones after 7 days.

CREATE TABLE IF NOT EXISTS lifecycle_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mount text NOT NULL CHECK (mount IN ('org.member_removed', 'agent.deleted', 'org.deleted')),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  plugin text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  attempts int NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS lifecycle_deliveries_undelivered_idx
  ON lifecycle_deliveries (delivered_at)
  WHERE delivered_at IS NULL;
