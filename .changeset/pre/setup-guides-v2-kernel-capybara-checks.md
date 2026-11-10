---
"@capybara-hq/kernel": patch
---

Setup guides v2 kernel checks: `capybara:public-url`, `capybara:webhook-public`,
`capybara:webhook-received` (the gateway marks an accepted webhook in Redis, at most once a minute
per connection, kept 7 days), `capybara:connection-active`, `capybara:oauth-client`,
`capybara:connector-tools`, `capybara:connector-connected` and `capybara:oauth-token-endpoint`, which
probes the token endpoint with the stored client and a fixed invalid code (through the kernel's
network rules, no redirects, nothing logged or stored). The guide route returns the guide's
`template`; check runs need the connector's live platform template, read the cache again after
taking the run lock, and redact the sent forms of a connector's credentials too.
