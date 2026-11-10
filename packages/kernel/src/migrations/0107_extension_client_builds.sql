-- Client extensions (spec 2026-11-09-client-extensions-design.md §9.1, §10.4).
-- extension_client_builds: the client files of an extension package, keyed by the package sha256
-- (the build id). The files live in object storage under `deployment/<object_prefix>`; the
-- integrity values delivered to browsers come from this row, never from the object store.
CREATE TABLE IF NOT EXISTS extension_client_builds (
  package_sha256 text PRIMARY KEY REFERENCES extension_packages(sha256) ON DELETE CASCADE,
  plugin text NOT NULL,
  entry text,
  styles text[] NOT NULL,
  assets text[] NOT NULL,
  integrity jsonb NOT NULL,
  sizes jsonb NOT NULL,
  api_version int NOT NULL,
  object_prefix text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- extension_client_reports: crash and load reports of client code, one row per
-- (plugin, build, org, contribution, kind); org_id is null for admin pages. Upserted, pruned after
-- 30 days.
CREATE TABLE IF NOT EXISTS extension_client_reports (
  plugin text NOT NULL,
  build text NOT NULL,
  org_id text NULL,
  contribution text NULL,
  kind text NOT NULL CHECK (kind IN ('load', 'render', 'event', 'api', 'budget')),
  count int NOT NULL DEFAULT 1,
  first_at timestamptz NOT NULL DEFAULT now(),
  last_at timestamptz NOT NULL DEFAULT now(),
  last_message text NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS extension_client_reports_key_uq
  ON extension_client_reports (
    plugin, build, (coalesce(org_id, '')), (coalesce(contribution, '')), kind
  );

CREATE INDEX IF NOT EXISTS extension_client_reports_last_at
  ON extension_client_reports (last_at);

-- extension_replica_status.serving_sha256: the package a replica actually serves for the plugin
-- (the row's own sha256 when loaded; the older package still running when the row's version is
-- pending approval or failed; null when none runs). Client code follows the server code that runs
-- (spec §9.3): a build is delivered while a live replica serves its package.
ALTER TABLE extension_replica_status ADD COLUMN IF NOT EXISTS serving_sha256 text NULL;

-- catalog_item_versions.appearance_order: the keys of plugin.json's
-- suggestedAppearance.replacements in the author's order (a jsonb object does not keep key order),
-- so the suggestion is listed and applied in that order (spec §6.5); null without replacements.
ALTER TABLE catalog_item_versions ADD COLUMN IF NOT EXISTS appearance_order text[] NULL;
