---
"@capybara-hq/plugin-sdk": patch
---

`isPlatformOnly` is true when any node along the wrapper chain carries `platformOnly: true`, like `secret`; an outer `false` never clears an inner `true`.
