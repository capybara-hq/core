CREATE TABLE IF NOT EXISTS permission_authority_epochs (
  kind text NOT NULL CHECK (kind IN ('platform', 'org', 'device', 'root')),
  id text NOT NULL,
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  PRIMARY KEY (kind, id)
);
