---
"@capybara-hq/kernel": minor
"@capybara-hq/testing": minor
---

Gateway replicas share channel long connections fairly: each replica heartbeats into
`capk:gateway-replicas`, claims up to its share of the runnable connections plus
`channels.shareSlack` (default 1) and hands one back per scan round when above it, leaving a
`capk:channel-handoff:<id>` marker. A worker maintenance job warns (rate limited) when active
channel connections exist but no gateway replica is live. The dual-replica harness gains
`startExtraReplica(roles)` and `redisUrl`.
