---
"@capybara-hq/kernel": patch
"@capybara-hq/plugin-sdk": patch
"@capybara-hq/web": patch
"@capybara-hq/capybara": patch
---

The Platform tool creates connectors, sets their credentials, installs catalog items with their
connector and config secrets, and creates channels, with every secret typed by the person on the
confirmation card. Org admins' agents invite, revoke and manage members (never self, never an owner,
never above the actor); an invitation link is sealed for the approver and revealed once on the web.
Platform results can pop up a handoff card (a link to a web page, or a Connect button for OAuth).
