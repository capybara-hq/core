-- Org-owned items, sharing, pending uploads and notices (phase 3, plan
-- 2026-11-06-plugin-scope-phase-3.md Task 1; rulings P3-3, P3-5, P3-6, P3-8, F27). Expand-only:
-- every column is nullable or defaulted, and existing rows stay platform-owned (owner_org_id NULL)
-- and not shareable. The only dropped objects are the old live-name indexes and the old notice
-- kind check, replaced in the same file.

-- Owners and pending uploads of catalog items. `owner_org_id` NULL = the platform; an org's
-- upload that carries an extension waits for the super admin (`awaiting_confirmation`), with the
-- uploaded version in `pending_*` until confirmed (P3-9 to P3-13).
ALTER TABLE catalog_items ADD COLUMN IF NOT EXISTS owner_org_id text
  REFERENCES orgs(id) ON DELETE SET NULL;
ALTER TABLE catalog_items ADD COLUMN IF NOT EXISTS shareable boolean NOT NULL DEFAULT false;
ALTER TABLE catalog_items ADD COLUMN IF NOT EXISTS awaiting_confirmation boolean NOT NULL DEFAULT false;
ALTER TABLE catalog_items ADD COLUMN IF NOT EXISTS pending_version text;
ALTER TABLE catalog_items ADD COLUMN IF NOT EXISTS pending_by text
  REFERENCES accounts(id) ON DELETE SET NULL;
ALTER TABLE catalog_items ADD COLUMN IF NOT EXISTS pending_at timestamptz;
CREATE INDEX IF NOT EXISTS catalog_items_owner_idx
  ON catalog_items (owner_org_id)
  WHERE owner_org_id IS NOT NULL AND deleted_at IS NULL;

-- Whether a version may be used (ruling P3-52): `applied_at` is set when it was applied or
-- confirmed (a platform import is applied as it is written: the default; an org's upload writes
-- NULL until its owner applies it or the super admin confirms it), `rejected_at` when the super
-- admin rejected it. Readers serving other orgs or the generic update use only applied, not
-- rejected versions, whoever owns the item (a transfer keeps the version rows). Existing rows
-- are platform imports: applied.
ALTER TABLE catalog_item_versions ADD COLUMN IF NOT EXISTS applied_at timestamptz DEFAULT now();
ALTER TABLE catalog_item_versions ADD COLUMN IF NOT EXISTS rejected_at timestamptz;

-- Platform components: the owning org (NULL = platform), the org they were created in
-- (`origin_org_id`, no FK, immutable; F27) and the share switch (P3-3, P3-5).
ALTER TABLE platform_skills ADD COLUMN IF NOT EXISTS owner_org_id text
  REFERENCES orgs(id) ON DELETE SET NULL;
ALTER TABLE platform_skills ADD COLUMN IF NOT EXISTS origin_org_id text;
ALTER TABLE platform_skills ADD COLUMN IF NOT EXISTS shareable boolean NOT NULL DEFAULT false;
ALTER TABLE platform_agent_templates ADD COLUMN IF NOT EXISTS owner_org_id text
  REFERENCES orgs(id) ON DELETE SET NULL;
ALTER TABLE platform_agent_templates ADD COLUMN IF NOT EXISTS origin_org_id text;
ALTER TABLE platform_agent_templates ADD COLUMN IF NOT EXISTS shareable boolean NOT NULL DEFAULT false;
ALTER TABLE platform_connector_templates ADD COLUMN IF NOT EXISTS owner_org_id text
  REFERENCES orgs(id) ON DELETE SET NULL;
ALTER TABLE platform_connector_templates ADD COLUMN IF NOT EXISTS shareable boolean NOT NULL DEFAULT false;

-- Live names are unique per origin org (P3-5); the new indexes come first, then the old ones go
-- (F27: new names, so a re-run is a true no-op).
CREATE UNIQUE INDEX IF NOT EXISTS platform_skills_live_name_origin_uq
  ON platform_skills ((coalesce(plugin_name, '')), name, (coalesce(origin_org_id, '')))
  WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS platform_agent_templates_live_name_origin_uq
  ON platform_agent_templates ((coalesce(plugin_name, '')), name, (coalesce(origin_org_id, '')))
  WHERE deleted_at IS NULL;
-- capybara:allow-destructive replaced by platform_skills_live_name_origin_uq created above in this file; no data change
DROP INDEX IF EXISTS platform_skills_live_name_uq;
-- capybara:allow-destructive replaced by platform_agent_templates_live_name_origin_uq created above in this file; no data change
DROP INDEX IF EXISTS platform_agent_templates_live_name_uq;

-- Org copies: whether the owner shares the copy with other orgs (P3-3, P3-6).
ALTER TABLE skills ADD COLUMN IF NOT EXISTS shareable boolean NOT NULL DEFAULT false;
ALTER TABLE agent_templates ADD COLUMN IF NOT EXISTS shareable boolean NOT NULL DEFAULT false;

-- An org's upload waits in staging under its org (P3-8); deleting the org drops the staging.
ALTER TABLE plugin_import_staging ADD COLUMN IF NOT EXISTS org_id text
  REFERENCES orgs(id) ON DELETE CASCADE;

-- New org notice kinds. 0081 declared the CHECK inline, so it is named org_notices_kind_check.
-- capybara:allow-destructive the check is added back with the wider kind list in the next statement; existing rows (skill_renamed) satisfy it
ALTER TABLE org_notices DROP CONSTRAINT IF EXISTS org_notices_kind_check;
ALTER TABLE org_notices ADD CONSTRAINT org_notices_kind_check
  CHECK (kind IN ('skill_renamed', 'item_shared', 'shared_item_updated',
                  'upload_confirmed', 'upload_rejected'));

-- A notice for the super admins (platform inbox), until one of them dismisses it.
-- `ownership_transferred`: a deleted org's shared item now belongs to the platform.
CREATE TABLE IF NOT EXISTS platform_notices (
  id uuid PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('ownership_transferred')),
  detail jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  dismissed_at timestamptz,
  dismissed_by text REFERENCES accounts(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS platform_notices_open_idx
  ON platform_notices (created_at DESC)
  WHERE dismissed_at IS NULL;
