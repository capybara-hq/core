-- 渠道（M4）：组织拥有的渠道连接（bot 凭据 + 绑定的 agent）、IM 话题 ↔ 会话映射、出站投递进度（Task 11），
-- 以及每个组织一个的匿名访客账号。连接配置里的密钥字段不在这里，存 capybara.secrets（kernel / channels:<id>:config）。
CREATE TABLE IF NOT EXISTS capybara.channel_connections (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES capybara.orgs(id) ON DELETE CASCADE,
  plugin text NOT NULL,
  name text NOT NULL,
  agent_id text NOT NULL REFERENCES capybara.agents(id),
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  unbound_policy text NOT NULL DEFAULT 'bind' CHECK (unbound_policy IN ('bind', 'anonymous')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'error')),
  last_error text,
  bot_user_id text,
  tenant_id text,
  created_by text NOT NULL REFERENCES capybara.accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX IF NOT EXISTS channel_connections_org_idx
  ON capybara.channel_connections (org_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS channel_connections_active_idx
  ON capybara.channel_connections (id) WHERE status = 'active' AND deleted_at IS NULL;
-- 私聊 thread_key = 'dm:<externalId>'，群聊 = 平台话题 id（新话题用起始消息 id）；匿名访客 account_id 为 NULL。
-- 私聊 /new 把当前行标记 archived_at 后新建，所以唯一性只约束未归档的行（部分唯一索引）。
CREATE TABLE IF NOT EXISTS capybara.channel_threads (
  id text PRIMARY KEY,
  connection_id text NOT NULL REFERENCES capybara.channel_connections(id) ON DELETE CASCADE,
  chat_id text NOT NULL,
  thread_key text NOT NULL,
  account_id text REFERENCES capybara.accounts(id) ON DELETE CASCADE,
  conversation_id text NOT NULL REFERENCES capybara.conversations(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS channel_threads_live_uq
  ON capybara.channel_threads (connection_id, chat_id, thread_key, coalesce(account_id::text, ''))
  WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS channel_threads_conversation_idx
  ON capybara.channel_threads (conversation_id);
-- 会话的 IM 投递目标与已投递到的事件序号（Task 11 的出站投递按 last_seq 续投）。
CREATE TABLE IF NOT EXISTS capybara.channel_deliveries (
  conversation_id text PRIMARY KEY REFERENCES capybara.conversations(id) ON DELETE CASCADE,
  connection_id text NOT NULL REFERENCES capybara.channel_connections(id) ON DELETE CASCADE,
  target jsonb NOT NULL,
  last_seq bigint NOT NULL DEFAULT 0,
  draft_message_id text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS channel_deliveries_connection_idx
  ON capybara.channel_deliveries (connection_id);
-- 每个组织一个匿名访客账号（无登录方式，组织角色 guest），渠道连接开启匿名策略时首次使用才创建。
CREATE TABLE IF NOT EXISTS capybara.org_anonymous_accounts (
  org_id text PRIMARY KEY REFERENCES capybara.orgs(id) ON DELETE CASCADE,
  account_id text NOT NULL UNIQUE REFERENCES capybara.accounts(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
