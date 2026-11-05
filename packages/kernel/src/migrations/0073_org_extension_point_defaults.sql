-- Web tools (spec §6): an org's default provider of an extension point with `selection:
-- "org-default"` (`point` is the name without the major, e.g. `web-search`). A row naming an
-- extension that is disabled or uninstalled stays and is ignored until it is a candidate again.
CREATE TABLE IF NOT EXISTS capybara.org_extension_point_defaults (
  org_id text NOT NULL REFERENCES capybara.orgs(id) ON DELETE CASCADE,
  point text NOT NULL,
  extension text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text REFERENCES capybara.accounts(id) ON DELETE SET NULL,
  PRIMARY KEY (org_id, point)
);
