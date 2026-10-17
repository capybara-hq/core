-- Agent 定义与版本：agents 为当前元数据，agent_versions 只追加（定义每变化一次一个版本），agent_members 为 visibility='members' 的名单。
CREATE TABLE IF NOT EXISTS capybara.agents (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES capybara.orgs(id) ON DELETE CASCADE,
  owner_account_id text NOT NULL REFERENCES capybara.accounts(id),
  visibility text NOT NULL CHECK (visibility IN ('private', 'org', 'members')),
  org_role text NOT NULL DEFAULT 'member' CHECK (org_role IN ('admin', 'member', 'guest')),
  current_version integer NOT NULL,
  needs_reassignment boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX IF NOT EXISTS agents_org_idx ON capybara.agents (org_id) WHERE deleted_at IS NULL;
CREATE TABLE IF NOT EXISTS capybara.agent_versions (
  agent_id text NOT NULL REFERENCES capybara.agents(id) ON DELETE CASCADE,
  version integer NOT NULL,
  definition jsonb NOT NULL,
  created_by text NOT NULL REFERENCES capybara.accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, version)
);
CREATE TABLE IF NOT EXISTS capybara.agent_members (
  agent_id text NOT NULL REFERENCES capybara.agents(id) ON DELETE CASCADE,
  account_id text NOT NULL REFERENCES capybara.accounts(id) ON DELETE CASCADE,
  PRIMARY KEY (agent_id, account_id)
);
