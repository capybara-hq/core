---
"@capybara-hq/testing": patch
---

Add `enableModelProviders(req, orgId, only?)`: switches the loaded model providers on in an org
through its extension switch. A model provider is now on only in the orgs that enabled it, so a
plugin's kernel test calls it before saving or running an agent in a new org.
