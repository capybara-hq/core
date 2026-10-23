---
"@capybara-hq/kernel": minor
"@capybara-hq/testing": minor
---

Gateway replicas share channel long connections fairly, per channel plugin: each replica
heartbeats (Redis server time) into `capk:gateway-replicas:<plugin>` for the channel plugins it
has loaded, claims up to its share of that plugin's runnable connections plus
`channels.shareSlack` (default 1) and hands one back per scan round when above it, leaving a
`capk:channel-handoff:<id>` marker and nudging the other replicas to claim it. A worker
maintenance job warns (rate limited, after a startup grace period) when a plugin has holdable
channel connections but no live gateway replica with it loaded. The dual-replica harness gains
`startExtraReplica(roles)` and `redisUrl`.
