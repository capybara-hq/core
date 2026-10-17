-- runs.trigger_seq：创建该运行时最新 user_message 的 seq（投递点）。运行以任何终态结束时 consumed_seq
-- 至少推进到它，触发消息不会因运行失败 / 中止 / 超时而被无限重试，会话也不会卡住。
ALTER TABLE capybara.runs ADD COLUMN IF NOT EXISTS trigger_seq bigint NOT NULL DEFAULT 0;
