-- Runs with search_path "plugin_fake_lifecycle, public": table names carry no schema prefix.
-- Every call of a lifecycle hook (one row per call, failed ones too).
CREATE TABLE IF NOT EXISTS calls (
  id bigserial PRIMARY KEY,
  mount text NOT NULL,
  payload jsonb NOT NULL,
  at timestamptz NOT NULL DEFAULT now()
);

-- Every successful delivery (one row per call that did not throw).
CREATE TABLE IF NOT EXISTS deliveries (
  id bigserial PRIMARY KEY,
  mount text NOT NULL,
  payload jsonb NOT NULL,
  at timestamptz NOT NULL DEFAULT now()
);
