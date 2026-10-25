---
"@capybara-hq/kernel": patch
"@capybara-hq/testing": patch
"@capybara-hq/capybara": patch
---

Marketplace downloads refuse private addresses and redirects: every host must resolve to a public
address (or be listed in `marketplaces.allowPrivateHosts`), and the connection is pinned to the
checked address.

Plugins can be read from git commits (smart HTTP over the same network rules: depth 1, no tags or
submodules, size and file limits); `@capybara-hq/testing` adds `startFakeGitServer`.
