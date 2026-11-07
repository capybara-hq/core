-- Run context (spec 2026-11-08-run-context-design.md §3.4): a person's time zone setting (IANA
-- name). Null, the default, follows the browser's time zone sent with each message; a set value
-- overrides it. Expand-only.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS time_zone text;
