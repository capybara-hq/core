-- Marketplaces owned by the deployment config (bootstrap.extraManifest; 'config', else NULL) and
-- the Basic auth username sent with a marketplace's git token (NULL: x-access-token).
ALTER TABLE marketplaces ADD COLUMN IF NOT EXISTS managed text NULL;
ALTER TABLE marketplaces ADD COLUMN IF NOT EXISTS username text NULL;
