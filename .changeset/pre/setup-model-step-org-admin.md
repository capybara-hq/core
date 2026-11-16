---
"@capybara-hq/kernel": patch
"@capybara-hq/web": patch
"@capybara-hq/capybara": patch
---

Setup checklist: when the platform offers a model provider the org can switch on or configure
(the preinstalled providers are opt-in per org), org admins and super admins go to the org's
extensions page (model tab) instead of being told to wait for a super admin; readiness gains
`orgCanAddModel`.
