-- M7 T16 (Ruling R13): the usage.report sweeper re-enqueues recent `usage` events so a delivery is
-- never lost when the fast-path enqueue fails. It scans by created_at; the partial index keeps that
-- cheap. The single-row table holds the sweep watermark (advanced by the maintenance job).
CREATE INDEX IF NOT EXISTS conversation_events_usage_idx
  ON conversation_events (created_at) WHERE type = 'usage';
CREATE TABLE IF NOT EXISTS usage_report_sweep (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  watermark timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
