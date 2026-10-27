-- Phase C: sub-agents (spec docs/superpowers/specs/2026-10-26-subagents-design.md §6, §16.3, §18).
-- - conversations: kind gains 'subagent' (a child conversation, read-only for people), with the
--   parent conversation (deleting it deletes its children) and the dispatched type name.
-- - runs.subagent_tokens_used: the parent run's sub-agent token counter (§8.3).
-- - subagent_dispatches: one row per dispatch (an `agent` call of a parent run).
-- - agent_templates / agent_template_versions: agent templates installed from plugins.
-- - plugin_install_components.kind gains 'agent_template'.
-- Additive only: new columns are nullable or have a default and the CHECKs only widen, so a
-- running older version keeps working during a rolling upgrade. 0052 is taken by another branch.
-- The widened CHECKs are re-added NOT VALID: the old CHECK implies the new one, so existing rows
-- need no scan under the ACCESS EXCLUSIVE lock; new writes are checked as usual.

-- capybara:allow-destructive the CHECK is re-added with one more allowed value in the same transaction
ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_kind_check;
ALTER TABLE conversations ADD CONSTRAINT conversations_kind_check
  CHECK (kind IN ('chat', 'eval', 'subagent')) NOT VALID;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS parent_conversation_id text
  REFERENCES conversations(id) ON DELETE CASCADE;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS subagent_type text;
CREATE INDEX IF NOT EXISTS conversations_parent_idx ON conversations (parent_conversation_id)
  WHERE kind = 'subagent';

ALTER TABLE runs ADD COLUMN IF NOT EXISTS subagent_tokens_used bigint NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS subagent_dispatches (
  parent_run_id text NOT NULL,
  parent_call_id text NOT NULL,
  parent_conversation_id text NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  step integer NOT NULL,
  child_conversation_id text NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  child_run_id text NOT NULL,
  resumed boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (parent_run_id, parent_call_id)
);
CREATE INDEX IF NOT EXISTS subagent_dispatches_child_run_idx ON subagent_dispatches (child_run_id);
CREATE INDEX IF NOT EXISTS subagent_dispatches_child_conv_idx
  ON subagent_dispatches (child_conversation_id);

-- catalog_item_id / plugin_name: the plugin the template came from (provenance); every template
-- is installed from a plugin, so plugin_name is required (NULLs would escape the unique index)
CREATE TABLE IF NOT EXISTS agent_templates (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name text NOT NULL,
  catalog_item_id text,
  plugin_name text NOT NULL,
  current_version integer NOT NULL CHECK (current_version >= 1),
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS agent_templates_live_name_uq
  ON agent_templates (org_id, plugin_name, name)
  WHERE deleted_at IS NULL;

-- definition: the parsed template (frontmatter and body); catalog_version: the plugin version
CREATE TABLE IF NOT EXISTS agent_template_versions (
  template_id text NOT NULL REFERENCES agent_templates(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version >= 1),
  definition jsonb NOT NULL,
  source_format text NOT NULL DEFAULT 'capybara'
    CONSTRAINT agent_template_versions_source_format_check
    CHECK (source_format IN ('capybara', 'claude-code')),
  catalog_version text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (template_id, version)
);

-- capybara:allow-destructive the CHECK is re-added with one more allowed value in the same transaction
ALTER TABLE plugin_install_components DROP CONSTRAINT IF EXISTS plugin_install_components_kind_check;
ALTER TABLE plugin_install_components ADD CONSTRAINT plugin_install_components_kind_check
  CHECK (kind IN ('extension', 'connector', 'skill', 'plugin', 'agent_template')) NOT VALID;
