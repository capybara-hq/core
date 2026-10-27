-- UI refresh B (Task 8): the model / effort a person switched the conversation to, as of the latest
-- `model_switched` event (the log is the source of truth; this column serves the conversation view).
-- { "model": { "provider", "model" } | null, "effort": string | null }; NULL = never switched.
ALTER TABLE capybara.conversations ADD COLUMN IF NOT EXISTS selection jsonb;
