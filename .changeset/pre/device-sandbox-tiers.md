---
"@capybara-hq/device": minor
---

`policy.json` replaces `network` with `tier` (absent = the organization's default), `isolation`
(`sandbox` by default) and `localhost` (`auto` by default). The old keys `network`,
`allowLocalBinding` and `allowUnixSockets` are ignored and dropped on the next write; a policy with
tier `open` behaves as the old `network: "open"`, every other tier as before.
