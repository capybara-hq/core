---
"@capybara-hq/testing": patch
"@capybara-hq/plugin-tools": patch
---

`createDualReplicaHarness` works when `@capybara-hq/testing` is installed from npm: when an
extension entry is a TypeScript file (the plugin under test by path, `fakeExtensionEntry(...)`),
each replica runs under tsx, now a dependency of this package and resolved from it, so the
plugin's `./x.js` imports map to `.ts` and the fake extensions under `node_modules` load. A plugin
repository no longer needs `NODE_OPTIONS: "--import tsx"`; the plugin-tools README says so.
