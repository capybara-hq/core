-- Plugin scope sync (spec 2026-11-05-plugin-component-management-design.md §5): the kernel installs
-- plugins in an org as no person (the worker job that converges orgs to a plugin's scope), so a
-- skill or skill version it creates has no creator. Relaxing NOT NULL is expand-only: rows written
-- before keep their creator, and dropping NOT NULL on a nullable column is a no-op.
ALTER TABLE skills ALTER COLUMN created_by DROP NOT NULL;
ALTER TABLE skill_versions ALTER COLUMN created_by DROP NOT NULL;
