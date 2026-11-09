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
  org_id uuid NULL,
  contribution text NULL,
  kind text NOT NULL CHECK (kind IN ('load', 'render', 'event', 'api', 'budget')),
  count int NOT NULL DEFAULT 1,
  first_at timestamptz NOT NULL DEFAULT now(),
  last_at timestamptz NOT NULL DEFAULT now(),
  last_message text NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS extension_client_reports_key_uq
  ON extension_client_reports (
    plugin, build, (coalesce(org_id::text, '')), (coalesce(contribution, '')), kind
  );

CREATE INDEX IF NOT EXISTS extension_client_reports_last_at
  ON extension_client_reports (last_at);
