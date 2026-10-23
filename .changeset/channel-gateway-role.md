---
"@capybara-hq/kernel": minor
"@capybara-hq/testing": minor
---

Channel long connections now run on the gateway role instead of the worker role: only replicas with
`gateway` in `roles` take part in the lease election and hold IM long connections; outbound delivery
and inbound jobs stay on `worker`. Deployments whose processes don't include `gateway` no longer hold
IM long connections. The dual-replica harness accepts per-replica `roles`, routes `request()` only to
replicas with the `api` role, adds `requestTo(index, path, init)`, and widens replica indexes to
`number`.
