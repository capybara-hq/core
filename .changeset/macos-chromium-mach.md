---
"@capybara-hq/device": patch
"@capybara-hq/plugin-sdk": patch
---

A device service on macOS may register and look up Chromium's rendezvous server
(`com.google.chrome.for.testing.MachPortRendezvousServer.*`), so the full Chromium build starts under the local sandbox
(core#843); the profile's app-shim listener (`…apps.*`) stays closed. The launcher tells the service with
`CAPYBARA_SERVICE_MACH=chromium` (`DEVICE_SERVICE_MACH_ENV`, `DEVICE_SERVICE_MACH_CHROMIUM`). Agent commands get none of it;
the service's file and network confinement is unchanged. The bundled sandbox runtime patch gains `allowMachRegister` (names
of at least three dotted labels).
