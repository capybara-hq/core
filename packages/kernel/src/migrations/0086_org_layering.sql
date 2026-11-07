-- Platform / org layering (spec 2026-11-07-platform-org-layering-design.md). Expand-only: two new
-- tables, nothing existing changes.

-- 0086, spec §5.4 / §5.8: an org's copy of an extension's overridable deployment config fields. A
-- row is a copy; no row means the org follows the platform ("no copy" and "a copy equal to the
-- platform" stay distinct). `config` holds the copy's non-secret values; its secrets live in
-- `secrets` under the org (namespace `kernel`, key `plugin-override:<plugin>:<path>`). Rows are kept
-- when the extension is disabled or uninstalled, like `extension_org_configs`.
CREATE TABLE IF NOT EXISTS extension_org_overrides (
  plugin text NOT NULL,
  org_id text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by text REFERENCES accounts(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by text REFERENCES accounts(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (plugin, org_id)
);

-- 0086, spec §7: an org admin's switch of one tool of an extension that is on in the org. No row
-- means the tool follows the extension (on).
CREATE TABLE IF NOT EXISTS org_tool_switches (
  org_id text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  plugin text NOT NULL,
  tool text NOT NULL,
  enabled boolean NOT NULL,
  updated_by text REFERENCES accounts(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, plugin, tool)
);
