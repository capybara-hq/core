-- UI refresh B (final review I1): a queued message carries the model / effort pick it was queued
-- with. At dispatch the kernel writes the `model_switched` before the message, as a direct send
-- does. { "provider", "model" } / the effort value; NULL = the message picks nothing.
ALTER TABLE capybara.conversation_queue ADD COLUMN IF NOT EXISTS model jsonb;
ALTER TABLE capybara.conversation_queue ADD COLUMN IF NOT EXISTS effort text;
