-- 同一会话同一时刻至多一个未结束（queued / running）的运行：RunQueue.ensureRun 已在会话行锁内检查，
-- 这里再由数据库兜底，任何代码路径都不可能插入第二个活跃运行。
CREATE UNIQUE INDEX IF NOT EXISTS runs_one_active_per_conversation
  ON capybara.runs (conversation_id) WHERE status IN ('queued', 'running');
