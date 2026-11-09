---
"@capybara-hq/plugin-tools": patch
---

`capybara-plugin check`: `plugin-test-imports` lets a plugin's tests import
`@capybara-hq/plugin-client` (and `@capybara-hq/plugin-client/testing`) and judges a `#…` subpath
import by its targets in the package.json `imports` map (an unmapped one is reported), and
`plugin-timer` and `plugin-module-state` skip browser-only client modules (the files
`src/client.ts[x]` reaches through relative or `#…` imports that the packer's esbuild build of
`src/index.ts` does not bundle); when that build fails, every module is checked.
`checkPluginState` is now async.
