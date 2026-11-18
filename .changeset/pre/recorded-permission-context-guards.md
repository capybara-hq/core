---
"@capybara-hq/kernel": patch
"@capybara-hq/web": patch
---

Refuse unsupported recorded permission context markers the same way in request building and replay diagnostics, report a corrupt recorded permission context in a case snapshot as `eval.snapshot_invalid` instead of a provider error, and share the sandbox host coverage rule with the permission context schema.
