-- A member's own tool policies for their own connection of a personal-credential connector
-- (maintainer decision 2026-11-09, the connector card's 权限): one row per account, connector and
-- tool name. They apply to every agent the account uses; an agent's tool policy overrides them, and
-- a tool the org switched off (or set to deny) stays denied whatever they say.
CREATE TABLE IF NOT EXISTS capybara.connector_tool_account_policies (
  org_id text NOT NULL REFERENCES capybara.orgs(id) ON DELETE CASCADE,
  connector_id text NOT NULL REFERENCES capybara.connectors(id) ON DELETE CASCADE,
  account_id text NOT NULL REFERENCES capybara.accounts(id) ON DELETE CASCADE,
  tool_name text NOT NULL,
  policy text NOT NULL CHECK (policy IN ('allow', 'ask', 'deny')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (connector_id, account_id, tool_name)
);

CREATE INDEX IF NOT EXISTS connector_tool_account_policies_account
  ON capybara.connector_tool_account_policies (account_id);
