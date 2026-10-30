---
"@capybara-hq/kernel": patch
"@capybara-hq/web": patch
---

The current organization is remembered, and choosing or creating one covers the app until done.

- **Remembered org:** choosing an org (`PUT /api/v1/me/current-org`) also stores it on the account
  (migration `0063_account_last_org`: `accounts.last_org_id`). A new web session (login, SSO, setup,
  an accepted invitation) starts in it while the account is still a member and the org is not
  deleted, else in the only org when there is exactly one. Setup with an organization name signs
  in with that org current. `GET /api/v1/me` reports no current org for an org the account left.
- **Org chooser:** signed in without a current org, a full-page chooser (on the auth layout)
  replaces the shell: open one of your orgs or create one; the admin console stays reachable for
  enterprise admins. Creating another org later is at the end of the account menu's Organization
  submenu (it left the overview's header).
