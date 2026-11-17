-- A retirement obligation whose members are all revoked managed starts on a suspended cloud
-- incarnation resolves without destroying that incarnation once its provider confirms the exact
-- cancellation of every revoked ref after a resume (permission activation B-22): the resolution
-- `exact-cancelled`. Widens the allowed values only; every existing row stays valid.
ALTER TABLE device_retirement_obligations
  DROP CONSTRAINT IF EXISTS device_retirement_obligations_resolution_check;
ALTER TABLE device_retirement_obligations
  ADD CONSTRAINT device_retirement_obligations_resolution_check
  CHECK (resolution IS NULL OR resolution IN ('provider-destroyed', 'host-rebooted', 'exact-cancelled'));
