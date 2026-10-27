-- UI refresh B (Task 11): an org's order of file-preview@1 previewers. A previewer without a row comes
-- after every ordered one, in provider order; `disabled` hides it from the org's file previews.
CREATE TABLE IF NOT EXISTS capybara.file_previewers (
  org_id text NOT NULL REFERENCES capybara.orgs(id) ON DELETE CASCADE,
  plugin text NOT NULL,
  previewer_id text NOT NULL,
  position int NOT NULL,
  disabled boolean NOT NULL DEFAULT false,
  PRIMARY KEY (org_id, plugin, previewer_id)
);
