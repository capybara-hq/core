-- Git credentials for sandboxes (spec 2026-11-12-sandbox-git-credentials-design.md): a connector
-- may declare the git hosts it can serve, and an org-owned one may be used as the source of the
-- git gateway (personal connectors are always sources). `git_hosts` is null for connectors that
-- declare none.
ALTER TABLE connectors ADD COLUMN IF NOT EXISTS git_hosts jsonb;
ALTER TABLE connectors ADD COLUMN IF NOT EXISTS use_for_git boolean NOT NULL DEFAULT false;

-- An approval of kind 'git' asks for a git operation through the gateway (widening 0114's CHECK).
ALTER TABLE approvals DROP CONSTRAINT IF EXISTS approvals_kind_check;
ALTER TABLE approvals ADD CONSTRAINT approvals_kind_check CHECK (kind IN ('tool', 'network', 'git'));
