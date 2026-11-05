-- The agent profile (avatar, description, quick actions): display data stored beside the agent,
-- outside agent_versions, so changing it creates no version. Expand-only.
-- profile_updated_at is kept at millisecond precision so a client can send it back as expectedUpdatedAt.
ALTER TABLE capybara.agents ADD COLUMN IF NOT EXISTS profile_avatar jsonb;
ALTER TABLE capybara.agents ADD COLUMN IF NOT EXISTS profile_description text NOT NULL DEFAULT '';
ALTER TABLE capybara.agents
  ADD COLUMN IF NOT EXISTS profile_quick_actions jsonb NOT NULL DEFAULT '[]';
ALTER TABLE capybara.agents
  ADD COLUMN IF NOT EXISTS profile_updated_at timestamptz NOT NULL
  DEFAULT date_trunc('milliseconds', now());

-- A definition's avatarUrl becomes an external avatar (once: only where none is set yet).
UPDATE capybara.agents a
SET profile_avatar = jsonb_build_object('kind', 'external', 'url', v.definition->>'avatarUrl')
FROM capybara.agent_versions v
WHERE v.agent_id = a.id
  AND v.version = a.current_version
  AND a.profile_avatar IS NULL
  AND jsonb_typeof(v.definition->'avatarUrl') = 'string'
  AND v.definition->>'avatarUrl' <> '';
