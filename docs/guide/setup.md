# Setup (create the first super admin)

A fresh deployment starts uninitialized (the log has a warn). Use the setup wizard to create the first super admin, and optionally the first org at the same time:

```bash
curl -s localhost:8080/api/v1/setup                          # {"needsSetup":true}
curl -s -X POST localhost:8080/api/v1/setup \
  -H 'Content-Type: application/json' -H 'X-Capybara-Csrf: 1' \
  -c cookies.txt \
  -d '{"login":"admin","password":"change-me-please","displayName":"Admin","orgName":"Research"}'
# 201, returns the account and org, and sets the session cookies (cap_at / cap_rt)
curl -s localhost:8080/api/v1/me -b cookies.txt               # the current account and its orgs
curl -s localhost:8080/api/v1/setup                          # {"needsSetup":false}; a second POST returns 409 setup.already_completed
```

- POST requests to public endpoints must carry the `X-Capybara-Csrf: 1` header.
- Production deployments should set `CAPYBARA_AUTH__SETUP_TOKEN` and send the same value as `setupToken` in the setup body, so nobody can initialize the deployment before you.
- You can also create a super admin with the CLI, without HTTP (the password is read from stdin only): `echo "$PW" | pnpm capybara admin create --login admin --display-name Admin`.
- Grant or revoke super admin for an existing local account: `pnpm capybara admin grant <login>` / `pnpm capybara admin revoke <login>` (audited; the last active super admin cannot be revoked). Super admins manage accounts, orgs (run concurrency, sandbox CPU / memory), deployment settings (price currency, whether orgs may create their own connectors / skills), extensions (install, approve, deployment-level config), model prices and purpose mappings, and the catalog under "Admin" (`/admin`) in the web top bar. Super admins **cannot read conversations** by default: trajectories and evals are available only to org admins and agent owners.
- When trying the web app over plain http on a host other than localhost, set `CAPYBARA_AUTH__COOKIE_SECURE=false`; otherwise the browser won't store the session cookie. Keep the default `true` in production.
- **When the setup wizard reopens**: "needs setup" is decided as "no active (`status = active`) super admin exists", checked live against PG every time. If someone edits the database directly and disables or revokes every super admin, the deployment reopens to unauthenticated `POST /api/v1/setup`, and whoever calls it first becomes the new super admin. Production deployments should always set `CAPYBARA_AUTH__SETUP_TOKEN` (setup must carry the same value as `setupToken`); to recover an admin, prefer the CLI: `echo "$PW" | pnpm capybara admin create --login <name> --display-name <display name>`.
