-- Catalog display files kept in PG (bootstrap catalog files fix, 2026-11-08): a plugin's icon, its
-- connector templates' icons and its setup guide files, each capped at 64 KiB by the plugin format.
-- Content-addressed: one row per sha256, shared by every version (and org) whose
-- catalog_item_versions.files lists it; a reader only asks for the sha256 its version row records
-- and re-checks it. They are in PG, not object storage, so a bootstrap plugin's icon is stored
-- before any object-store extension runs (the object store's own icon included). touched_at: set
-- by every import that stores the file again; the staging cleanup removes rows no version or
-- staging lists once they are older than the staging TTL.
CREATE TABLE IF NOT EXISTS catalog_files (
  sha256 text PRIMARY KEY CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  data bytea NOT NULL,
  touched_at timestamptz NOT NULL DEFAULT now()
);
