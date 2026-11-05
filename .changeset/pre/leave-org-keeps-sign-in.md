---
"@capybara-hq/kernel": patch
"@capybara-hq/web": patch
---

Leaving an organization (`POST /orgs/:id/leave`) keeps the account's sessions and personal tokens;
only that org's access ends. Removal by an admin and directory offboarding still revoke them.
