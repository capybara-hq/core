-- the rename migration names the old column to rename it
ALTER TABLE accounts RENAME COLUMN is_enterprise_admin TO is_super_admin;
