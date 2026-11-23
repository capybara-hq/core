---
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
"@capybara-hq/web": patch
---

Rename the deployment config key `marketplaces.allowPrivateHosts` to `net.allowPrivateHosts`
(environment variable `CAPYBARA_NET__ALLOW_PRIVATE_HOSTS`, was
`CAPYBARA_MARKETPLACES__ALLOW_PRIVATE_HOSTS`). It is the one list of internal hosts for every
outbound request the kernel resolves itself (marketplace, archive and git downloads, npm registry
downloads, OAuth discovery, registration and token requests, git identity), so it now sits next to
`net.httpsProxy` and `net.noProxy`. Refusal hints and the web's download error name the new key.
A config file that still sets `marketplaces.allowPrivateHosts` fails startup as an unknown key:
move the list to `net.allowPrivateHosts`.
