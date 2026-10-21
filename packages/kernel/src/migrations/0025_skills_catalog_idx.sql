-- M5 T14：按会话取最新一份技能目录快照（skills_catalog，Ruling M17）。每次运行开始与每步工具执行都要查，
-- 部分索引让查询不必倒序扫完整个会话的事件。
CREATE INDEX IF NOT EXISTS conversation_events_skills_catalog_idx
  ON capybara.conversation_events (conversation_id, seq)
  WHERE type = 'skills_catalog';
