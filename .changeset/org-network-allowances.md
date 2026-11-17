---
"@capybara-hq/kernel": minor
---

Org network allowances: a per-org list of internal endpoints (hostname, `*.domain`, IP, CIDR or an
origin `http(s)://host:port`) stored in `org_network_allowances` (migration 0145), audited
`org.network_allowance_added` / `org.network_allowance_removed`, with the error code
`org.network_allowance_invalid`. Link-local, loopback, unspecified and IPv4-embedding IPv6
addresses are always refused, `localhost` names too, and so are wildcards over a public suffix.
New config `net.allowInsecureLoopback` (testing only).
