---
"@capybara-hq/plugin-sdk": patch
---

Declare `"sideEffects": false`: the package has no import-time side effects, so a bundler that imports
one export no longer pulls in the whole SDK.
