---
"@capybara-hq/web": patch
"@capybara-hq/capybara": patch
---

The purpose list no longer warns that extensions cannot call models yet under an extension's
purpose: extensions call `ctx.models.embed` / `generateImage` with their declared purposes.
