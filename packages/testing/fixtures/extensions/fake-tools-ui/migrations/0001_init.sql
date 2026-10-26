-- Runs with search_path "plugin_fake_tools_ui, public": table names carry no schema prefix.
-- One item list per conversation (replaced as a whole on every write).
CREATE TABLE IF NOT EXISTS items (
  conversation_id text PRIMARY KEY,
  items jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
