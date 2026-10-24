-- M7 T4 (E11-D): per-connection inbound mode. 'long_connection' (default) is held by a gateway
-- replica's supervisor; 'webhook' receives platform callbacks on the gateway route
-- POST /channels/webhook/<id> and is skipped by the supervisor scan.
ALTER TABLE channel_connections
  ADD COLUMN IF NOT EXISTS inbound_mode text NOT NULL DEFAULT 'long_connection'
    CHECK (inbound_mode IN ('long_connection', 'webhook'));
