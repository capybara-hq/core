-- Marketplace entry icons (maintainer decision 2026-11-08): the svg / png an entry's `icon` names
-- (an https URL, or a path in a git marketplace's repository), downloaded on refresh through the
-- marketplace network rules and kept here so the market list never hits the network per request
-- and every replica serves the same bytes. One row per (marketplace, icon as the entry writes it);
-- entries naming the same icon share it. Each is at most 64 KiB (the plugin icon limit). A URL's
-- content is treated as fixed (fetched once); a repository path is read again at every new commit.
-- Rows no entry names any more are removed by the refresh; deleting the marketplace removes them.
CREATE TABLE IF NOT EXISTS marketplace_icons (
  source_id text NOT NULL REFERENCES marketplaces(id) ON DELETE CASCADE,
  ref text NOT NULL,
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  content_type text NOT NULL CHECK (content_type IN ('image/svg+xml', 'image/png')),
  data bytea NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_id, ref)
);
