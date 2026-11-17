-- When the legacy-launch freeze's own enumeration last completed with a stable pass (permission
-- runtime cutover B-26). NULL: the freeze was published but its enumeration never finished (a
-- crash, or an old unfenced replica kept writing legacy rows); the cloud snapshot driver refuses
-- until `capybara permissions cutover freeze` is run again and settles.
ALTER TABLE legacy_launch_freeze ADD COLUMN IF NOT EXISTS enumerated_at timestamptz;
