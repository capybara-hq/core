-- Platform components (phase 2, plan 2026-11-06-plugin-scope-phase-2.md rulings A2-C2, E2): skills,
-- agent templates and connector templates owned by the deployment instead of an org, with their own
-- scope (follow the plugin's, or their own), an org list (named) and per-org switches. Org copies
-- link to them. Expand-only: nothing existing is changed except `agent_templates.plugin_name`
-- losing NOT NULL (a template without a plugin is the bare `<name>`).

CREATE TABLE IF NOT EXISTS platform_skills (
  id text PRIMARY KEY,
  catalog_item_id uuid REFERENCES catalog_items(id) ON DELETE SET NULL,
  plugin_name text,
  name text NOT NULL,
  description text NOT NULL,
  description_zh text,
  current_version integer NOT NULL CHECK (current_version >= 1),
  scope_mode text NOT NULL DEFAULT 'follow' CHECK (scope_mode IN ('follow', 'own')),
  scope text NOT NULL DEFAULT 'optional' CHECK (scope IN ('all', 'optional', 'named')),
  disabled boolean NOT NULL DEFAULT false,
  shown_to_others boolean NOT NULL DEFAULT true,
  scope_version integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS platform_skills_live_name_uq
  ON platform_skills ((coalesce(plugin_name, '')), name)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS platform_skill_versions (
  skill_id text NOT NULL REFERENCES platform_skills(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version >= 1),
  manifest jsonb NOT NULL,
  object_prefix text NOT NULL,
  catalog_version text,
  source_format text NOT NULL DEFAULT 'capybara' CHECK (source_format IN ('capybara', 'claude-code')),
  suggest_pinned boolean NOT NULL DEFAULT false,
  updated_on_own boolean NOT NULL DEFAULT false,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (skill_id, version)
);

CREATE TABLE IF NOT EXISTS platform_agent_templates (
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
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS platform_agent_templates_live_name_uq
  ON platform_agent_templates ((coalesce(plugin_name, '')), name)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS platform_agent_template_versions (
  template_id text NOT NULL REFERENCES platform_agent_templates(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version >= 1),
  definition jsonb NOT NULL,
  object_prefix text,
  catalog_version text,
  source_format text NOT NULL DEFAULT 'capybara' CHECK (source_format IN ('capybara', 'claude-code')),
  suggest_pinned boolean NOT NULL DEFAULT false,
  updated_on_own boolean NOT NULL DEFAULT false,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (template_id, version)
);

CREATE TABLE IF NOT EXISTS platform_connector_templates (
  id text PRIMARY KEY,
  catalog_item_id uuid NOT NULL REFERENCES catalog_items(id) ON DELETE CASCADE,
  template_id text NOT NULL,
  current_version text NOT NULL,
  file jsonb NOT NULL,
  scope_mode text NOT NULL DEFAULT 'follow' CHECK (scope_mode IN ('follow', 'own')),
  scope text NOT NULL DEFAULT 'optional' CHECK (scope IN ('all', 'optional', 'named')),
  disabled boolean NOT NULL DEFAULT false,
  shown_to_others boolean NOT NULL DEFAULT true,
  scope_version integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS platform_connector_templates_live_uq
  ON platform_connector_templates (catalog_item_id, template_id)
  WHERE deleted_at IS NULL;

-- Scope of an own-scope component: the orgs it is offered to (named) and each org's switch.
CREATE TABLE IF NOT EXISTS component_scope_orgs (
  kind text NOT NULL CHECK (kind IN ('skill', 'agent_template', 'connector_template')),
  component_id text NOT NULL,
  org_id text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  PRIMARY KEY (kind, component_id, org_id)
);
CREATE TABLE IF NOT EXISTS component_org_switches (
  kind text NOT NULL CHECK (kind IN ('skill', 'agent_template', 'connector_template')),
  component_id text NOT NULL,
  org_id text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  enabled boolean NOT NULL,
  updated_by text REFERENCES accounts(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, component_id, org_id)
);

-- Links from the org copies (ruling B2): a pin keeps the copy on its own stored version.
ALTER TABLE skills ADD COLUMN IF NOT EXISTS platform_skill_id text
  REFERENCES platform_skills(id) ON DELETE SET NULL;
ALTER TABLE skills ADD COLUMN IF NOT EXISTS pinned_version integer;
ALTER TABLE agent_templates ADD COLUMN IF NOT EXISTS platform_template_id text
  REFERENCES platform_agent_templates(id) ON DELETE SET NULL;
ALTER TABLE agent_templates ADD COLUMN IF NOT EXISTS pinned_version integer;
ALTER TABLE connectors ADD COLUMN IF NOT EXISTS platform_template_id text
  REFERENCES platform_connector_templates(id) ON DELETE SET NULL;

-- A template without a plugin is the bare `<name>`; the live-name index must still hold for NULLs.
ALTER TABLE agent_templates ALTER COLUMN plugin_name DROP NOT NULL;
-- capybara:allow-destructive the index is recreated in the same transaction over coalesce(plugin_name, '') so NULL plugin names stay unique; no data change
DROP INDEX IF EXISTS agent_templates_live_name_uq;
CREATE UNIQUE INDEX IF NOT EXISTS agent_templates_live_name_uq
  ON agent_templates (org_id, (coalesce(plugin_name, '')), name)
  WHERE deleted_at IS NULL;
