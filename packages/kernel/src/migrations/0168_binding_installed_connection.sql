-- The authenticated device connection whose bindInstance answer installed a binding. A connection
-- answers bind before its own hello is recorded (the hello is recorded after `ready`), so the
-- hello that would replace an unattested generation must not replace one installed on its own
-- connection: that hello predates the binding. Connection ids are unique per socket across
-- replicas, so the comparison needs no clock.
ALTER TABLE device_instance_bindings ADD COLUMN IF NOT EXISTS installed_connection_id text;
