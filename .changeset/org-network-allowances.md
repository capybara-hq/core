---
"@capybara-hq/kernel": minor
---

Org network allowances: a per-org list of internal endpoints (hostname, `*.domain`, IP, CIDR or an
origin `http(s)://host:port`; link-local always refused) stored in `org_network_allowances`
(migration 0145), audited `org.network_allowance_added` / `org.network_allowance_removed`, with the
error code `org.network_allowance_invalid`. New config `net.allowInsecureLoopback` (testing only).
