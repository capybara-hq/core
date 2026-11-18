---
"@capybara-hq/device": patch
"@capybara-hq/kernel": patch
---

Staged protocol 3: the device binds an instance generation only through the authenticated
`bindInstance` request. It checks its stored previous binding, verifies the installed manifest and
refuses while another generation's work is live or uncertain, then writes the binding durably
before enabling that generation's operation backend. An unbound session admits no operation; a
restart recovers the same generation's journal only when the installed runtime is unchanged. The
kernel names as previous binding only one the current machine acknowledged.
