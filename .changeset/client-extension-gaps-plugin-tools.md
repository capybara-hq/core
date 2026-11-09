---
"@capybara-hq/plugin-tools": patch
---

`capybara-plugin check`: `plugin-test-imports` lets a plugin's tests import
`@capybara-hq/plugin-client` (and `@capybara-hq/plugin-client/testing`) and judges a `#…` subpath
import by its targets in the package.json `imports` map (an unmapped one is reported), and
`plugin-timer` skips browser-only client modules (the files `src/client.ts[x]` reaches through
relative or `#…` imports and `src/index.ts` does not); server modules and modules both entries
reach are still refused.
