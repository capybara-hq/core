-- Instance generation identity (permission runtime cutover B4). A device instance's generation is
-- the exact epoch millisecond of device_instances.created_at; operation refs, journals and spools
-- carry it. The high-water mark lives apart from device_instances (no foreign key to it or to
-- devices), so a deleted, reset or rebuilt instance row, a database clock that moved back, or two
-- creates within one millisecond can never hand out a generation already used for the device.
CREATE TABLE IF NOT EXISTS device_generation_high_water (
  device_id uuid PRIMARY KEY,
  high_water_ms bigint NOT NULL CHECK (high_water_ms >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- The post-commit binding of a local instance generation: committed with the instance row as
-- 'awaiting-device'; 'installed' only after the authenticated device's bindInstance answer was
-- verified. A record outlives its instance row (no foreign key), so an old generation and its
-- binding id are never reused or adopted by a replacement.
CREATE TABLE IF NOT EXISTS device_instance_bindings (
  device_id uuid NOT NULL,
  instance_generation text NOT NULL CHECK (instance_generation ~ '^[0-9]{1,16}$'),
  binding_id uuid NOT NULL UNIQUE,
  provider text NOT NULL,
  previous_generation text CHECK (previous_generation IS NULL
    OR previous_generation ~ '^[0-9]{1,16}$'),
  status text NOT NULL CHECK (status IN ('awaiting-device', 'installed')),
  machine_id uuid,
  -- the verified runtime identity the device answered with; a later report must match it
  runtime_identity jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  installed_at timestamptz,
  PRIMARY KEY (device_id, instance_generation)
);
