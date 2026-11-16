-- No compatibility before 0.1.0 (design review 2026-11-16, maintainer ruling): a plugin install's
-- ledger row for an org skill or agent template the org has since promoted to its own shared item
-- (ruling P3-47) was skipped by every uninstall and rollback at run time. Such rows exist only from
-- installs recorded before ruling P3-46 kept plugin content from being promoted (installs write no
-- skill or agent template rows since plugin scope phase 2), so they go once, here, and the run-time
-- guard with them. Idempotent: a second run matches nothing.

-- capybara:allow-destructive ledger rows of the org's own promoted items, which no uninstall or rollback acted on
DELETE FROM plugin_install_components AS c
USING plugin_installs AS i
WHERE i.id = c.install_id
  AND c.kind = 'skill'
  AND EXISTS (
    SELECT 1 FROM skills s
    JOIN platform_skills p ON p.id = s.platform_skill_id
    WHERE s.id = c.ref
      AND s.org_id = i.org_id
      AND s.pinned_version IS NULL
      AND p.owner_org_id = i.org_id
      AND p.catalog_item_id IS NULL
      AND p.deleted_at IS NULL);

-- capybara:allow-destructive ledger rows of the org's own promoted items, which no uninstall or rollback acted on
DELETE FROM plugin_install_components AS c
USING plugin_installs AS i
WHERE i.id = c.install_id
  AND c.kind = 'agent_template'
  AND EXISTS (
    SELECT 1 FROM agent_templates a
    JOIN platform_agent_templates p ON p.id = a.platform_template_id
    WHERE a.id = c.ref
      AND a.org_id = i.org_id
      AND a.pinned_version IS NULL
      AND p.owner_org_id = i.org_id
      AND p.catalog_item_id IS NULL
      AND p.deleted_at IS NULL);
