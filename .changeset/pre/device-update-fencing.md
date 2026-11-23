---
"@capybara-hq/plugin-sdk": patch
"@capybara-hq/kernel": patch
---

Device provider lifecycle calls carry a fence token (device update fencing design, #748). The SDK
adds `DeviceFence` and `StaleFenceError` (with `isStaleFenceError`): `update` and `create` get the
device's fencing generation as the calling holder last committed it, `destroy` and `destroyByName`
get it too (`null` when the kernel holds no device lease). A provider that keeps per-instance state
stores the highest token next to it and refuses a lower one, so a replica whose lease ended while
its call was in flight can no longer apply an older network list. The kernel records the target of
an `update` before sending it (`instance_limits.pending`), so the next exclusive holder applies the
desired limits again even when the record of what succeeded already matches them; it handles
`StaleFenceError` as a lost lease and never recreates for it; and a failed record write after an
`updated` answer no longer falls into the recreate branch (it used to let a stale holder destroy the
instance a newer holder was using).
