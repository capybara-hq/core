-- Runs with search_path "plugin_fake_bootstrap_b, public": table names carry no schema prefix.
-- The objects of the fake store, per configured bucket.
CREATE TABLE IF NOT EXISTS objects (
  bucket text NOT NULL,
  key text NOT NULL,
  content_type text NOT NULL,
  data bytea NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (bucket, key)
);
