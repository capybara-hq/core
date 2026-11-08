---
"@capybara-hq/kernel": minor
---

The extension host resolves each UI contribution's slot once per load: a contribution to an unknown
slot or slot version is dropped (the extension still loads), logged once, and listed as `uiDropped`
on the admin extension view. Contributions still on the deprecated `place` load unchanged (info
log). The contribution list no longer carries `legacyPlace`, and contributions to slots without a
place (agent, org settings, platform) are not listed or served through the org routes yet.
