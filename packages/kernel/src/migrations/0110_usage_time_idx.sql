-- The admin overview's seven-day usage aggregate (admin overview spec §4.3, §5.4) reads runs and
-- embedding usage of every org by time: runs by created_at (only (conversation_id, created_at)
-- existed) and model_usage by occurred_at (only (org_id, occurred_at) and a partial index on the
-- unreported rows existed). Chat usage events already have conversation_events_usage_idx (0040).
-- A plain CREATE INDEX: the migrator runs each file in a transaction, so not CONCURRENTLY; it
-- locks writes to the table while it builds (pre-0.1.0: no large deployments).
CREATE INDEX IF NOT EXISTS runs_created_idx ON runs (created_at);
CREATE INDEX IF NOT EXISTS model_usage_time_idx ON model_usage (occurred_at);
