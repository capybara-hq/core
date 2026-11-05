---
"@capybara-hq/kernel": patch
"@capybara-hq/web": patch
---

Role pass: every page and action of the web app follows the viewer's org role.

- A page the role may not open shows one designed "no access" state (what it is, the role it
  needs, who to ask) and loads nothing; the admin console uses the same state.
- Navigation, ⌘K, the overview and agent actions only offer what the role may do; organization
  settings are open to members (read-only), never to guests.
- New: leave an organization, delete an organization (owners, a danger zone with a typed
  confirmation), service tokens in organization settings (admins; the token is shown once), and
  changing an agent's owner (admins).
- The kernel's readiness endpoint documents that `modelProvider` is deployment-wide and read per
  replica; role tests cover leaving, deleting an organization, service tokens and agent owners.
