-- Phase D (Task 9): a queued message can invoke a skill. It is rendered when queued (like queued
-- `@` resources), so `content` starts with the rendered text and `skill` holds the
-- user_message.skill record `{ id, version, source, name, plugin?, arguments, mode, agentType? }`;
-- NULL = a plain message. queue_pause_reason says why the queue paused: `run_ended` (a run failed
-- or was stopped), `author_cannot_send`, `skill_not_invocable` (re-checked at dispatch); NULL when
-- not paused or paused by an older replica. Additive: older replicas never write either column.
ALTER TABLE capybara.conversation_queue ADD COLUMN IF NOT EXISTS skill jsonb;
ALTER TABLE capybara.conversations ADD COLUMN IF NOT EXISTS queue_pause_reason text;
