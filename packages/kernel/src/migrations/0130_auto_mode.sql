-- Auto mode (auto mode spec §4.3, §4.4): the approval kind 'command', the device's mode replacing
-- the device tier, and stored settings moving from the sandbox tiers and egress to autoMode /
-- cloudNetwork.

-- A command review ask (spec §5.4) is an approval of kind 'command': widen the kind CHECK, the same
-- pattern as 0114 and 0126. Dropping and re-adding it in one transaction is safe: every existing
-- row satisfies the new definition.
ALTER TABLE approvals DROP CONSTRAINT IF EXISTS approvals_kind_check;
ALTER TABLE approvals ADD CONSTRAINT approvals_kind_check
  CHECK (kind IN ('tool', 'network', 'git', 'command'));

-- capybara:allow-destructive nothing reads devices.tier after this version; a local device's mode lives in its machine's local policy.json and a cloud device's mode is derived from the platform and org switches
ALTER TABLE devices DROP COLUMN IF EXISTS tier;

-- Orgs: sandboxTier -> autoMode (a stored max of open allowed auto mode, anything lower turned it
-- off, absent follows the platform) and sandboxEgress -> cloudNetwork (allowlist keeps its hosts,
-- none becomes an empty allowlist, absent becomes open, the new default).
UPDATE orgs
SET settings = (settings #- '{sandboxTier}' #- '{sandboxEgress}')
  || CASE
       WHEN settings->'sandboxTier'->>'max' = 'open' THEN '{"autoMode":"allowed"}'::jsonb
       WHEN settings ? 'sandboxTier' THEN '{"autoMode":"off"}'::jsonb
       ELSE '{}'::jsonb
     END
  || CASE
       WHEN settings->'sandboxEgress'->>'mode' = 'allowlist'
         THEN jsonb_build_object('cloudNetwork', settings->'sandboxEgress')
       WHEN settings ? 'sandboxEgress'
         THEN '{"cloudNetwork":{"mode":"allowlist","allowHosts":[]}}'::jsonb
       ELSE '{}'::jsonb
     END
WHERE settings ? 'sandboxTier' OR settings ? 'sandboxEgress';

-- The platform's choice moves to the auto-mode switch: a stored max of open (or no max inside a
-- stored sandboxTiers) allowed auto mode, anything lower turned it off. A deployment that never
-- stored sandboxTiers keeps the new default (allowed).
INSERT INTO deployment_settings (key, value)
SELECT 'devicesAutoMode',
       CASE WHEN value->>'max' = 'open' OR value->>'max' IS NULL
            THEN '{"mode":"allowed"}'::jsonb
            ELSE '{"mode":"off"}'::jsonb
       END
FROM deployment_settings
WHERE key = 'sandboxTiers'
ON CONFLICT (key) DO NOTHING;

-- capybara:allow-destructive sandboxTiers is replaced by devicesAutoMode above (its only reader is gone in this version); the row must not linger and override the migrated choice
DELETE FROM deployment_settings WHERE key = 'sandboxTiers';
