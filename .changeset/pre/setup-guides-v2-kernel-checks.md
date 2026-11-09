---
"@capybara-hq/kernel": patch
---

Setup guides v2 checks: extensions register setup checks with `ctx.setup.check` (only during
setup, ids from `permissions.setupChecks`, recorded in the permission snapshot without blocking
loading). `GET …/catalog/:itemId/guides/:guideId/checks` reads the cached state of a guide's checks
and `POST …/checks/:checkId/run` runs one (30 a minute per account): results cached in Redis per
target, mode and (for member checks) account, single flight across replicas, a 10 s force cooldown,
8 concurrent runs per org, a 10 s time limit, and every result validated, redacted by the target's
and the extension's secrets and validated again. The `Platform` tool gains `setup.status` and
`setup.check`. Guide acks of channel connections and connectors follow the guide read's catalog
visibility.
