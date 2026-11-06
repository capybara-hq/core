-- The deployment-level role "enterprise admin" becomes "super admin" (plugin and component
-- management spec §13.4b): accounts.is_enterprise_admin becomes is_super_admin, and the stored
-- deployment setting orgCreation "enterprise_admin" becomes "super_admin". Historical audit rows
-- are not rewritten. No compatibility layer (release candidate).

-- capybara:allow-destructive column rename; code is renamed in the same release (release candidate, no compatibility layer)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'capybara' AND table_name = 'accounts'
               AND column_name = 'is_enterprise_admin') THEN
    ALTER TABLE accounts RENAME COLUMN is_enterprise_admin TO is_super_admin;
  END IF;
END
$$;

UPDATE deployment_settings SET value = '"super_admin"'::jsonb
  WHERE key = 'orgCreation' AND value = '"enterprise_admin"'::jsonb;
