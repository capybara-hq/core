-- Platform tool (spec 2026-11-07-platform-tool-design.md §6.2, §6.3): an approval carries the
-- kernel-rendered summary of the call ({zh, en}) and the scopes the person may choose. Expand-only:
-- both columns are nullable; null keeps today's behavior (no summary; scopes derived from the row:
-- "once" for a role escalation, else once / session / always).
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS summary jsonb;
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS scopes text[];
