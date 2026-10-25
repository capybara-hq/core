-- Phase A1: git marketplaces and git plugin sources (package ecosystem spec §5.1, §5.3).
-- - marketplaces: the form (http = a marketplace.json URL, git = a repository), the git ref it
--   follows (NULL = the remote HEAD), the commit of the last refresh (an unchanged commit skips the
--   refresh) and the manifest's owner name (the publisher of skills-only plugins).
-- - catalog_item_versions: source 'git'; where the plugin came from (source_detail: host, repo,
--   path, ref, commit and followsBranch for git; the archive URL; the npm registry) and the content
--   digest of the imported files (filled from phase A1 task 4).
-- - catalog_items: package_name may be NULL (a git plugin without package.json).
-- Every statement is repeatable: columns are added with IF NOT EXISTS, the CHECKs are dropped and
-- added back under the same name in the same transaction.

ALTER TABLE marketplaces ADD COLUMN IF NOT EXISTS form text NOT NULL DEFAULT 'http';
ALTER TABLE marketplaces DROP CONSTRAINT IF EXISTS marketplaces_form_check;
ALTER TABLE marketplaces ADD CONSTRAINT marketplaces_form_check CHECK (form IN ('http', 'git'));
ALTER TABLE marketplaces ADD COLUMN IF NOT EXISTS ref text NULL;
ALTER TABLE marketplaces ADD COLUMN IF NOT EXISTS last_commit text NULL;
ALTER TABLE marketplaces ADD COLUMN IF NOT EXISTS owner_name text NULL;

ALTER TABLE catalog_item_versions ADD COLUMN IF NOT EXISTS source_detail jsonb NULL;
ALTER TABLE catalog_item_versions ADD COLUMN IF NOT EXISTS content_digest text NULL;
ALTER TABLE catalog_item_versions DROP CONSTRAINT IF EXISTS catalog_item_versions_source_check;
ALTER TABLE catalog_item_versions ADD CONSTRAINT catalog_item_versions_source_check
  CHECK (source IN ('file', 'npm', 'marketplace', 'git'));

ALTER TABLE catalog_items ALTER COLUMN package_name DROP NOT NULL;
