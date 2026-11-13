---
"@capybara-hq/device": patch
---

Explain blocked network access: in OS mode a refused domain gets a reason from the proxy, and each
command's stderr ends with a trailer naming every refused host and the layer that refused it (this
device's allowed domains, the organization's allowlist, or a private address). Local policy changes
apply at the next command without a restart (an invalid `policy.json` keeps the last valid policy),
writes take `policy.json.lock`, and `capybara-device policy add|remove allowedDomains <host>` edits
the list one host at a time.
