---
"@capybara-hq/kernel": minor
---

`http.trustProxy` also accepts a comma-separated string of addresses / CIDRs (e.g.
`CAPYBARA_HTTP__TRUST_PROXY=172.18.0.1,10.0.0.0/8`), validates each entry (IPs, CIDRs with a prefix length or a contiguous dotted netmask), and refuses a `/0` range in any spelling,
which would trust every address. An empty `auth.setupToken` now means "not set", so compose can pass
`${CAPYBARA_SETUP_TOKEN:-}`.
