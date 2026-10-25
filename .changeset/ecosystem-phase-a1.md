---
"@capybara-hq/kernel": patch
"@capybara-hq/testing": patch
"@capybara-hq/capybara": patch
---

Marketplace downloads refuse private addresses and redirects: every host must resolve to a public
address (or be listed in `marketplaces.allowPrivateHosts`), and the connection is pinned to the
checked address.
