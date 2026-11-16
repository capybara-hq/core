---
"@capybara-hq/plugin-sdk": minor
"@capybara-hq/testing": minor
---

Export an immutable, hashed Python 3 native-file helper source bundle and a fixture-owned ordinary
native API conformance harness. The helper preserves read/write/stat/list/scan semantics using
supplied pinned root descriptors. Each conformance invocation receives a fresh operation.

These exports establish portable native API compatibility only. They do not declare restricted
runtime support or provide a Linux launcher, network broker, or full permission conformance suite.
