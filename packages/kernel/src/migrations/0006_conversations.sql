-- 会话与事件日志：conversation_events 只追加，是 agent 运行的唯一事实来源；seq 由 conversations.last_seq 在行锁内连续分配。
-- runs 记录每次运行的状态（运行流水线在后续任务接入）。
CREATE TABLE IF NOT EXISTS capybara.conversations (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES capybara.orgs(id) ON DELETE CASCADE,
  agent_id text NOT NULL REFERENCES capybara.agents(id),
  account_id text NOT NULL REFERENCES capybara.accounts(id),
  title text,
  last_seq bigint NOT NULL DEFAULT 0,
  consumed_seq bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS conversations_account_idx ON capybara.conversations (org_id, account_id, updated_at DESC);
CREATE TABLE IF NOT EXISTS capybara.conversation_events (
  conversation_id text NOT NULL REFERENCES capybara.conversations(id) ON DELETE CASCADE,
  seq bigint NOT NULL,
  type text NOT NULL,
  run_id text,
  idem_key text,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, seq)
);
CREATE UNIQUE INDEX IF NOT EXISTS conversation_events_idem_uq
  ON capybara.conversation_events (conversation_id, idem_key) WHERE idem_key IS NOT NULL;
CREATE TABLE IF NOT EXISTS capybara.runs (
  id text PRIMARY KEY,
  conversation_id text NOT NULL REFERENCES capybara.conversations(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'aborted')),
  agent_version integer NOT NULL,
  trigger_account_id text NOT NULL REFERENCES capybara.accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS runs_conversation_idx ON capybara.runs (conversation_id, created_at DESC);
