-- The organization an account last chose as its current one: a new web session (login, SSO, setup,
-- an accepted invitation) starts in it while the account is still a member and the org is not
-- deleted, so people don't pick their org again at every sign-in. Written with the session's
-- current org by `PUT /me/current-org`; NULL = never chosen (a new session then starts in the only
-- org when there is exactly one). Additive: older replicas never read or write it.
ALTER TABLE capybara.accounts
  ADD COLUMN IF NOT EXISTS last_org_id text REFERENCES capybara.orgs(id) ON DELETE SET NULL;
