---
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
"@capybara-hq/plugin-sdk": patch
---

The super admin sets the platform's sandbox levels (`sandbox.tiers.max`, `default`,
`allowUnsandboxed`) on the admin settings page (`PUT /api/v1/admin/settings` `sandboxTiers`). A field
set in the startup config (env, file or Nacos) wins and is read-only there; an API token or the
Platform tool may only lower them. The dev hosts preset (`DEV_HOSTS`) adds `storage.googleapis.com`,
where Playwright's Chromium download (Chrome for Testing) is served from.
