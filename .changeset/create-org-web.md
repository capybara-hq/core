---
"@capybara-hq/kernel": patch
"@capybara-hq/web": patch
---

Create an organization from the web app. Skipping the organization in the setup wizard used to
leave no way to create one in the UI.

- `GET /api/v1/me` returns `canCreateOrg` (the deployment's `orgCreation` setting for this account).
- With no organization and `canCreateOrg`, the status page offers "Create organization" (a name,
  then the new organization becomes the current one); the overview's header offers it too.
- A page that needs an organization keeps its own title (e.g. Agents) instead of showing the status
  text as the title.
