---
"@capybara-hq/kernel": patch
---

The device view reports a cloud device's reconcile marker (`reconcileRequired`), its outer network
and the exact networks Full access on and off give within it (`mode.outerNetwork`,
`mode.fullNetwork`, `mode.sandboxNetwork`), and the effective owner Full access
(`ownerCeiling.effectiveFullAccess`). A cloud ceiling PATCH before the migration is refused with
the new `device.permission_not_migrated`, and ceiling changes (`device.owner_ceiling_changed`) are
listed in the device's recent changes as `kind: "ceiling"` with their from and to.
A local device's effective Full follows the mode admission derives (an older program without a
report included). The Platform devices.list and devices.get report such a cloud device as
`reconcile_required` with the reason and the next step (devices.reset-files).
