CREATE TABLE IF NOT EXISTS notes (id text PRIMARY KEY, org_id text, thing_id text NOT NULL);
-- a later migration may add the policy of an older table
ALTER TABLE IF EXISTS capybara.notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE notes FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_scope ON notes;
CREATE POLICY org_scope ON capybara.notes USING (rls_admits(org_id));
