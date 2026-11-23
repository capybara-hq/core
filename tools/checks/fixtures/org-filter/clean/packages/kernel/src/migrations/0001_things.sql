CREATE TABLE IF NOT EXISTS things (id text PRIMARY KEY, org_id text NOT NULL);
ALTER TABLE things ENABLE ROW LEVEL SECURITY;
ALTER TABLE things FORCE ROW LEVEL SECURITY;
CREATE POLICY org_scope ON things USING (rls_admits(org_id)) WITH CHECK (rls_admits(org_id));
