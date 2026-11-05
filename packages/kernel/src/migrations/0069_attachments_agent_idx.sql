-- The agent avatar lookup and the cleanup of an agent's uploads filter attachments by agent_id;
-- a partial index keeps it small, since most attachments belong to no agent.
CREATE INDEX IF NOT EXISTS attachments_agent_idx ON capybara.attachments (agent_id) WHERE agent_id IS NOT NULL;
