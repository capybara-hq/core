-- Preserve existing independent device/org ceilings; profiles grant no device authority.
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS permission_profile text NOT NULL DEFAULT 'approve-for-me' CHECK (permission_profile IN ('request-approval', 'approve-for-me', 'full-access'));
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS permission_revision integer NOT NULL DEFAULT 0;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS permission_consent jsonb;
