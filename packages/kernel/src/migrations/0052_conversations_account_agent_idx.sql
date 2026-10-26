-- The sidebar's grouped conversation list (GET /conversations/groups, GET /conversations?agentId=):
-- my chat conversations per agent, newest first.
CREATE INDEX IF NOT EXISTS conversations_account_agent_idx
  ON capybara.conversations (org_id, account_id, agent_id, updated_at DESC, id DESC)
  WHERE kind = 'chat';
