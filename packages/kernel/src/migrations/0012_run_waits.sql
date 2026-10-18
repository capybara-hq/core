-- 运行等待人处理（审批 / 输入请求）时暂停、处理后续跑。

-- 进入 waiting 的时刻；续跑时把等待时长累加进 waited_ms 并清空。
ALTER TABLE runs ADD COLUMN IF NOT EXISTS waiting_since timestamptz;
-- 累计等待时长（毫秒）：运行截止时间 = started_at + waited_ms + maxRunSeconds，等人不计入运行时长。
ALTER TABLE runs ADD COLUMN IF NOT EXISTS waited_ms bigint NOT NULL DEFAULT 0;
-- 续跑任务的 jobId（`run-<conversationId>-resume-<waitId>`）；为空表示按触发消息生成的 jobId。孤儿判定用它查任务。
ALTER TABLE runs ADD COLUMN IF NOT EXISTS job_id text;
-- 最近一次回到 queued 的时刻（续跑）；孤儿判定的宽限期从它起算（为空时用 created_at）。
ALTER TABLE runs ADD COLUMN IF NOT EXISTS queued_at timestamptz;

-- 同一工具调用可以连续请求输入（最多 3 轮）：每轮一行，按 attempt 区分。
ALTER TABLE questions ADD COLUMN IF NOT EXISTS attempt integer NOT NULL DEFAULT 1;
CREATE UNIQUE INDEX IF NOT EXISTS questions_run_call_attempt_uniq
  ON questions (run_id, call_id, attempt);
-- 0010 的 (run_id, call_id) 唯一约束改由上面的唯一索引取代（questions 表在本版本新建，尚无代码依赖旧约束）。
ALTER TABLE questions DROP CONSTRAINT IF EXISTS questions_run_call_uniq;
