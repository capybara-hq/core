CREATE TABLE IF NOT EXISTS things (id text PRIMARY KEY, org_id text NOT NULL);
CREATE POLICY org_scope ON things USING (rls_admits(org_id)) WITH CHECK (rls_admits(org_id));
