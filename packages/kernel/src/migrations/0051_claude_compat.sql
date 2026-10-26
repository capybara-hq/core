-- Phase B: Claude Code plugin compatibility (package ecosystem spec §8, §9).
-- - catalog_item_versions.source_format: the format the version was read from ('capybara', or
--   'claude-code' for a translated Claude Code plugin); translation: its translation report (null
--   for a native plugin); license_text: the root LICENSE text (at most 64 KiB; any plugin).
-- - skill_versions.source_format: the format of the plugin the version came from (org skills and
--   agent skills stay 'capybara'); suggest_pinned: the plugin suggests pinning it (spec §9.1).
-- - marketplace_entries.claude: the Claude marketplace entry's overlay (strict, component fields,
--   publisher; null for a Capybara entry).
-- - marketplaces.skipped: the entries the last successful refresh could not store
--   ({ name, reason }[]), replaced on every refresh.
-- Additive only: every column is nullable or has a default, so a running older version keeps
-- working during a rolling upgrade.

ALTER TABLE catalog_item_versions ADD COLUMN IF NOT EXISTS source_format text NOT NULL DEFAULT 'capybara'
  CONSTRAINT catalog_item_versions_source_format_check CHECK (source_format IN ('capybara', 'claude-code'));
ALTER TABLE catalog_item_versions ADD COLUMN IF NOT EXISTS translation jsonb;
ALTER TABLE catalog_item_versions ADD COLUMN IF NOT EXISTS license_text text;

ALTER TABLE skill_versions ADD COLUMN IF NOT EXISTS source_format text NOT NULL DEFAULT 'capybara'
  CONSTRAINT skill_versions_source_format_check CHECK (source_format IN ('capybara', 'claude-code'));
ALTER TABLE skill_versions ADD COLUMN IF NOT EXISTS suggest_pinned boolean NOT NULL DEFAULT false;

ALTER TABLE marketplace_entries ADD COLUMN IF NOT EXISTS claude jsonb;
ALTER TABLE marketplaces ADD COLUMN IF NOT EXISTS skipped jsonb NOT NULL DEFAULT '[]'::jsonb;
