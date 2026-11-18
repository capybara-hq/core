---
"@capybara-hq/device": patch
---

The published device package is now self-contained: packing bundles its whole runtime closure
(the SDK, the patched sandbox runtime, ws and their dependencies) into `dist/node_modules`, byte for
byte, and declares no dependencies, so an install gets exactly the bytes its runtime manifest names.
The pack scripts run with `node --experimental-strip-types`.
