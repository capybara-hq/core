-- The setup guide a channel connection was last set up with (plugin setup guides spec
-- 2026-11-08-plugin-setup-guides-design.md §6): { guideId, version, hash, mode } of the plugin's
-- channel-connection guide, recorded on create, on an inbound mode switch and when an admin
-- confirms the platform app was updated. NULL = unknown (rows before this column, or a plugin
-- without a guide): no drift notice for those.
ALTER TABLE channel_connections ADD COLUMN IF NOT EXISTS guide_ack jsonb;
