-- Themes as a platform component kind (themes spec 2026-11-08-themes-design.md §6, §7): rows and
-- versions shaped like platform agent templates, with the owner columns of org-owned items; the
-- `theme` kind in the component scope, switch and install component tables; the person's pick on
-- the account. Expand-only: the only dropped objects are the three kind checks, re-added wider in
-- the next statement each.

CREATE TABLE IF NOT EXISTS platform_themes (
  id text PRIMARY KEY,
  catalog_item_id uuid REFERENCES catalog_items(id) ON DELETE SET NULL,
  plugin_name text,
  name text NOT NULL,
  description text,
  description_zh text,
  current_version integer NOT NULL CHECK (current_version >= 1),
  scope_mode text NOT NULL DEFAULT 'follow' CHECK (scope_mode IN ('follow', 'own')),
  scope text NOT NULL DEFAULT 'optional' CHECK (scope IN ('all', 'optional', 'named')),
  disabled boolean NOT NULL DEFAULT false,
  shown_to_others boolean NOT NULL DEFAULT true,
  scope_version integer NOT NULL DEFAULT 0,
  -- The owning org (NULL = the platform), the org it was created in (no FK, immutable) and the
  -- share switch, as on the other platform components (0084).
  owner_org_id text REFERENCES orgs(id) ON DELETE SET NULL,
  origin_org_id text,
  shareable boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS platform_themes_live_name_origin_uq
  ON platform_themes ((coalesce(plugin_name, '')), name, (coalesce(origin_org_id, '')))
  WHERE deleted_at IS NULL;

-- One version of a theme: `definition` is the parsed theme file (`ParsedTheme`); fonts and logo
-- live under `object_prefix` in `deployment/` (NULL for a theme without assets).
CREATE TABLE IF NOT EXISTS platform_theme_versions (
  theme_id text NOT NULL REFERENCES platform_themes(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version >= 1),
  definition jsonb NOT NULL,
  object_prefix text,
  catalog_version text,
  updated_on_own boolean NOT NULL DEFAULT false,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (theme_id, version)
);

-- 0081 declared these checks inline, so they carry the default names.
-- capybara:allow-destructive the check is added back with 'theme' in the next statement; existing rows satisfy it
ALTER TABLE component_scope_orgs DROP CONSTRAINT IF EXISTS component_scope_orgs_kind_check;
ALTER TABLE component_scope_orgs ADD CONSTRAINT component_scope_orgs_kind_check
  CHECK (kind IN ('skill', 'agent_template', 'connector_template', 'theme'));
-- capybara:allow-destructive the check is added back with 'theme' in the next statement; existing rows satisfy it
ALTER TABLE component_org_switches DROP CONSTRAINT IF EXISTS component_org_switches_kind_check;
ALTER TABLE component_org_switches ADD CONSTRAINT component_org_switches_kind_check
  CHECK (kind IN ('skill', 'agent_template', 'connector_template', 'theme'));
-- NOT VALID as in 0053: existing rows were checked by the narrower constraint already.
-- capybara:allow-destructive the check is added back with 'theme' in the next statement; existing rows satisfy it
ALTER TABLE plugin_install_components DROP CONSTRAINT IF EXISTS plugin_install_components_kind_check;
ALTER TABLE plugin_install_components ADD CONSTRAINT plugin_install_components_kind_check
  CHECK (kind IN ('extension', 'connector', 'skill', 'plugin', 'agent_template', 'theme')) NOT VALID;

-- The person's theme (§7): one value across all their orgs; NULL follows the org. No FK: a pick
-- that is not on in the current org (or no longer exists) is skipped, never an error.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS theme text;
