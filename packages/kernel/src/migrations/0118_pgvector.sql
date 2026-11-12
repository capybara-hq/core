-- pgvector, when the server offers it (memory plugin spec §6.4). Plugins store embeddings in a
-- `vector` column when the type is visible from their search_path (`plugin_<name>, public`) and fall
-- back to `real[]` otherwise, so pgvector is recommended, not required:
-- - not offered by the server (no row in pg_available_extensions): nothing to do;
-- - already installed, in whatever schema a DBA put it: left where it is;
-- - not creatable by the migrating role (insufficient_privilege): a notice, the migration succeeds.
-- `SCHEMA public` matters: the migrator's search_path is `capybara, public`, and a bare
-- CREATE EXTENSION would put the type and `<=>` in `capybara`, invisible to plugin schemas.
-- capybara:allow-destructive not destructive: a DO block is the only way to make CREATE EXTENSION conditional on availability and to turn a missing privilege into a notice
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'vector') THEN
    RAISE NOTICE 'pgvector is not available on this server; plugins fall back to real[] embeddings';
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    RETURN;
  END IF;
  BEGIN
    EXECUTE 'CREATE EXTENSION IF NOT EXISTS vector SCHEMA public';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'pgvector not installed: the migrating role may not create it (%); plugins fall back to real[] embeddings', SQLERRM;
  END;
END
$$;
