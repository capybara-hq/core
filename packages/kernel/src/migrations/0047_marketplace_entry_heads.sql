-- Phase A1: the branch head of a marketplace entry that follows a git branch (spec §5.3 "content
-- changed at the same version"). A refresh resolves it for entries already imported, so an
-- imported version whose recorded commit differs from the head shows the content changed; NULL
-- when not resolved (not imported, pinned to a commit, not git, or the lookup failed).
-- Repeatable: the column is added with IF NOT EXISTS.

ALTER TABLE marketplace_entries ADD COLUMN IF NOT EXISTS head_commit text NULL;
