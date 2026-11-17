---
"@capybara-hq/kernel": patch
---

A cloud device can carry an explicit owner Full ceiling and outer network (migration 0145),
snapshotted once from its old effective auto-mode authority under its exclusive lifecycle lease
and device authority lock: old auto becomes Full on the open network (an empty allowlist under
`egress: none`), old sandbox keeps its exact network, and known applied limits only narrow it. A
snapshotted false stays explicit after a later widening, and the outer network caps the device's
network. Unknown, stale, wider or pending applied limits block every operation with
`device.permission_reconcile_required` until a file reset establishes them.
