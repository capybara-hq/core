-- 0120, transactional outbox spec §8.1 / §8.2: a `usage.report` delivery is owed in the outbox
-- with the usage it reports, so the usage sweeper is gone, and with it its watermark table and the
-- index it found unreported `model_usage` rows by. (`conversation_events_usage_idx` stays: the
-- admin usage aggregate reads usage events by time.)
-- capybara:allow-destructive the sweeper that read and wrote this single-row watermark is removed in this release (project not released, no compatibility layer)
DROP TABLE IF EXISTS usage_report_sweep;
DROP INDEX IF EXISTS model_usage_unreported;
