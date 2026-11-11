-- Skill authoring via the Platform tool: an agent's owner shares an agent skill with the org. The
-- shared skill is an org skill (scope 'org') that remembers the agent it came from
-- (origin_agent_id, cleared when that agent is deleted; the skill stays) and the account that
-- maintains it (maintainer_account_id).
ALTER TABLE skills
  ADD COLUMN IF NOT EXISTS origin_agent_id text REFERENCES agents(id) ON DELETE SET NULL;
ALTER TABLE skills
  ADD COLUMN IF NOT EXISTS maintainer_account_id text REFERENCES accounts(id);
-- The skills an agent shared, for its skill list and for sharing again.
CREATE INDEX IF NOT EXISTS skills_origin_agent_idx
  ON skills (origin_agent_id)
  WHERE origin_agent_id IS NOT NULL AND deleted_at IS NULL;

-- A request is either a share of an agent skill with the org or a new version of a shared skill.
ALTER TABLE skill_change_requests
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'version'
    CHECK (kind IN ('share', 'version'));

-- The R4 owner-approved change flow ends. The draft objects of the cancelled rows are left to the
-- org data cleanup.
-- capybara:allow-destructive R4 owner-approved changes are removed; pending ones cannot be decided any more
UPDATE skill_change_requests SET status = 'cancelled', decided_at = now() WHERE status = 'pending';
