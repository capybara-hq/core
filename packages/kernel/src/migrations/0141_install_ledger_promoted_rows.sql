-- No compatibility before 0.1.0 (design review 2026-11-16, maintainer ruling): an uninstall or
-- rollback used to skip, at run time, a plugin install's ledger row for an org skill or agent
-- template the org had promoted to its own shared item (ruling P3-47). Such rows exist only from
-- installs recorded before ruling P3-46 (installs write no skill or agent template rows since
-- plugin scope phase 2), so the run-time guard goes and this migration makes it unnecessary:
--
-- Precondition the kernel now relies on: every remaining ledger row of kind `skill` /
-- `agent_template` names an org row with plugin provenance (a skill with `catalog_item_id`; an
-- agent template with `plugin_name` or `catalog_item_id`), which P3-46 refuses to promote
-- (`catalog.not_owned`), so no ledger row names a promoted row at the time this runs. It is
-- established here, not assumed: the ledger rows of org rows without plugin provenance (promoted
-- already, or rows the org has since uploaded its own version of) are deleted. A residue remains:
-- an install still `installing` from before plugin scope phase 2 whose skill the org later
-- re-uploads and promotes; its rollback would soft-delete the org row (the platform row stays).
-- Accepted as negligible: no such install can still be live on a deployment of this release. The only behaviour lost is a
-- rollback of such an old failed install reverting a version on the org's own row, which the org
-- may since have shared. Idempotent: a second run matches nothing.

-- capybara:allow-destructive ledger rows of rows the org owns; no current install writes such rows
DELETE FROM plugin_install_components AS c
USING plugin_installs AS i
WHERE i.id = c.install_id
  AND c.kind = 'skill'
  AND EXISTS (
    SELECT 1 FROM skills s
    WHERE s.id = c.ref AND s.org_id = i.org_id AND s.catalog_item_id IS NULL);

-- capybara:allow-destructive ledger rows of rows the org owns; no current install writes such rows
DELETE FROM plugin_install_components AS c
USING plugin_installs AS i
WHERE i.id = c.install_id
  AND c.kind = 'agent_template'
  AND EXISTS (
    SELECT 1 FROM agent_templates a
    WHERE a.id = c.ref AND a.org_id = i.org_id
      AND a.plugin_name IS NULL AND a.catalog_item_id IS NULL);
