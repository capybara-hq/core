-- Setup guides v2 (spec 2026-11-09-setup-guides-v2-design.md §11, §15).
-- A connector made from a connector template records the setup guide it was set up with:
-- { guideId, version, hash, mode } (mode null: the place has no modes), recorded when the
-- connector is created from the template and when an org admin confirms the third-party app was
-- updated. NULL = unknown (connectors before this column, custom ones): no drift notice for those.
ALTER TABLE connectors ADD COLUMN IF NOT EXISTS guide_ack jsonb;
-- The v1 acks of channel connections hold v1 template hashes that no v2 hash can equal; keeping
-- them would show every existing connection a false update notice. Cleared ("no ack, no notice"):
-- those connections start tracking again at their next mode switch or ack.
UPDATE channel_connections SET guide_ack = NULL WHERE guide_ack IS NOT NULL;
