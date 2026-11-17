---
"@capybara-hq/plugin-sdk": patch
"@capybara-hq/device": patch
"@capybara-hq/kernel": patch
---

The device hello can carry the host's OS boot identity (`bootId`; SDK `DEVICE_BOOT_ID_RE`,
`isDeviceBootId`): `capybara-device` reports Linux's `boot_id` or macOS's boot session UUID (else
its boot time) on the active and the staged hello. The kernel records it per machine from
authenticated hellos only; a local legacy retirement obligation keeps the boot its machine last
reported and resolves once a current machine of the device (a re-login counts) reports another boot
(the computer restarted). An obligation without a recorded boot never resolves by itself; the same
boot from a new credential, a stale or replayed boot and a revoked machine are no evidence. A local device waiting for that restart
answers `device.restart_required` ("Restart this computer to finish the upgrade").
