-- 工具与连接器（M3）：应用、应用工具、授权、审批、提问、工具输出存档；runs 增加 waiting 状态；orgs.settings。

-- 已安装的应用（一个连接器实例）。auth 只存 {type, ownership, ...非密钥字段}，凭据在 capybara.secrets。
CREATE TABLE IF NOT EXISTS capybara.apps (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES capybara.orgs(id) ON DELETE CASCADE,
  slug text NOT NULL,
  name text NOT NULL,
  connector text NOT NULL,
  endpoint jsonb NOT NULL DEFAULT '{}'::jsonb,
  auth jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_by text NOT NULL REFERENCES capybara.accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS apps_org_slug_uniq
  ON capybara.apps (org_id, slug) WHERE deleted_at IS NULL;

-- 应用暴露的工具；spec_hash 变化后回到 pending_review，由管理员重新审阅。
CREATE TABLE IF NOT EXISTS capybara.app_tools (
  app_id text NOT NULL REFERENCES capybara.apps(id) ON DELETE CASCADE,
  name text NOT NULL,
  spec jsonb NOT NULL,
  spec_hash text NOT NULL,
  status text NOT NULL CHECK (status IN ('enabled', 'disabled', 'pending_review')),
  default_policy text NOT NULL CHECK (default_policy IN ('allow', 'ask', 'deny')),
  reviewed_at timestamptz,
  PRIMARY KEY (app_id, name)
);

-- 「以后都允许」：按 (账号, agent, 工具) 记住，spec_hash 变化后失效。
CREATE TABLE IF NOT EXISTS capybara.tool_grants (
  org_id text NOT NULL REFERENCES capybara.orgs(id) ON DELETE CASCADE,
  account_id text NOT NULL REFERENCES capybara.accounts(id) ON DELETE CASCADE,
  agent_id text NOT NULL REFERENCES capybara.agents(id) ON DELETE CASCADE,
  tool_key text NOT NULL,
  spec_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, account_id, agent_id, tool_key)
);

-- 「本会话都允许」。
CREATE TABLE IF NOT EXISTS capybara.conversation_tool_grants (
  conversation_id text NOT NULL REFERENCES capybara.conversations(id) ON DELETE CASCADE,
  tool_key text NOT NULL,
  spec_hash text NOT NULL,
  PRIMARY KEY (conversation_id, tool_key)
);

-- 工具调用审批。requested_for（指定账号）与 approver_role（指定角色）至少一个非空。
CREATE TABLE IF NOT EXISTS capybara.approvals (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES capybara.orgs(id) ON DELETE CASCADE,
  conversation_id text NOT NULL REFERENCES capybara.conversations(id) ON DELETE CASCADE,
  run_id text NOT NULL REFERENCES capybara.runs(id) ON DELETE CASCADE,
  call_id text NOT NULL,
  tool_key text NOT NULL,
  input jsonb NOT NULL DEFAULT '{}'::jsonb,
  requested_for text REFERENCES capybara.accounts(id) ON DELETE SET NULL,
  approver_role text,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'denied', 'expired', 'cancelled')),
  scope text CHECK (scope IS NULL OR scope IN ('once', 'session', 'always')),
  decided_by text REFERENCES capybara.accounts(id) ON DELETE SET NULL,
  decided_at timestamptz,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT approvals_run_call_uniq UNIQUE (run_id, call_id),
  CONSTRAINT approvals_target_chk CHECK (requested_for IS NOT NULL OR approver_role IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS approvals_pending_for_idx
  ON capybara.approvals (requested_for) WHERE status = 'pending';

-- ask_user 提问。
CREATE TABLE IF NOT EXISTS capybara.questions (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES capybara.orgs(id) ON DELETE CASCADE,
  conversation_id text NOT NULL REFERENCES capybara.conversations(id) ON DELETE CASCADE,
  run_id text NOT NULL REFERENCES capybara.runs(id) ON DELETE CASCADE,
  call_id text NOT NULL,
  spec jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'answered', 'expired', 'cancelled')),
  answer jsonb,
  answered_by text REFERENCES capybara.accounts(id) ON DELETE SET NULL,
  answered_at timestamptz,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT questions_run_call_uniq UNIQUE (run_id, call_id)
);

-- 超大工具输出的存档（read_tool_output 读取），到期清理。
CREATE TABLE IF NOT EXISTS capybara.tool_outputs (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES capybara.orgs(id) ON DELETE CASCADE,
  conversation_id text NOT NULL REFERENCES capybara.conversations(id) ON DELETE CASCADE,
  call_id text NOT NULL,
  size_chars integer NOT NULL,
  line_count integer NOT NULL,
  content text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS tool_outputs_expires_idx ON capybara.tool_outputs (expires_at);

-- runs 增加 waiting（等待审批 / 回答）；约束名为 PG 对 0006 内联 CHECK 的默认命名。
ALTER TABLE capybara.runs DROP CONSTRAINT IF EXISTS runs_status_check;
ALTER TABLE capybara.runs ADD CONSTRAINT runs_status_check
  CHECK (status IN ('queued', 'running', 'waiting', 'completed', 'failed', 'aborted'));

-- 每会话至多一个活动运行：waiting 也算活动。
DROP INDEX IF EXISTS capybara.runs_one_active_per_conversation;
CREATE UNIQUE INDEX IF NOT EXISTS runs_one_active_per_conversation
  ON capybara.runs (conversation_id) WHERE status IN ('queued', 'running', 'waiting');

-- 组织级设置（如工具策略）。
ALTER TABLE capybara.orgs ADD COLUMN IF NOT EXISTS settings jsonb NOT NULL DEFAULT '{}'::jsonb;
