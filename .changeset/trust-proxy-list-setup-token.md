---
"@capybara-hq/kernel": minor
---

`http.trustProxy` also accepts a comma-separated string of addresses / CIDRs (e.g.
`CAPYBARA_HTTP__TRUST_PROXY=172.18.0.1,10.0.0.0/8`), validates each entry, and refuses a `/0` prefix,
which would trust every address. An empty `auth.setupToken` now means "not set", so compose can pass
`${CAPYBARA_SETUP_TOKEN:-}`.
