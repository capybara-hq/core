---
"@capybara-hq/kernel": patch
---

Legacy background retirement barrier (dormant until the paired activation): a durable legacy-launch
freeze, published under the platform authority writer, that every SID background launch checks
right before it dispatches; durable retirement obligations per device, provider and exact instance
generation for every legacy task row whose processes may still exist and for revoked managed starts
on an incarnation that no longer runs. Every sandbox lifecycle acquisition (use, resume, rebuild,
provider switch) and the local instance bind check them under the exclusive lease: a cloud
incarnation is retired only by its provider's confirmed whole-instance destroy (files kept), a local
or unverifiable one stays quarantined and the device unavailable. A worker job enumerates, retires
and settles them with backoff. Migration 0156.
The freeze enumerates before it returns and the gate enumerates each device it serves, so neither
depends on the worker; once frozen, lost-task kills by SID stop and their marks are kept. Legacy
polls, stops and reads by SID and staged browsing are refused on a device under an obligation (exact
managed drains go on). A launch records the exact incarnation its dispatch was admitted for.
A cloud obligation that names no incarnation resolves once the device's current instance is
destroyed with confirmation (no earlier provider's instance kept, recorded under the freeze); one no
evidence can cover answers `device.recreate_required`. Obligations of deleted devices become
`abandoned` (reported apart; `cleanRetirement` requires none).
