---
"@capybara-hq/device": patch
---

A device service on macOS may register and look up Chromium's own Mach services
(`com.google.chrome.for.testing.MachPortRendezvousServer.*` and `com.google.chrome.for.testing.apps.*`), so the full Chromium
build starts under the local sandbox (core#843). Agent commands get none of it; the service's file and network confinement is
unchanged. The bundled sandbox runtime patch gains `allowMachRegister`.
