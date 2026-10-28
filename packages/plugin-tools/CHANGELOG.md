# @capybara-hq/plugin-tools

## 0.1.0-rc.2

### Patch Changes

- 6ad094b: `capybara-plugin pack --bootstrap` (and its `--root`, `--registry` and `--npm-token` options) and
  `packBootstrap` are removed: a starting kernel downloads the bootstrap plugins itself. The pinned
  npm download `downloadPinnedNpmPackage` stays (`check:bootstrap --network` uses it).
- Updated dependencies [75d7a0c]
- Updated dependencies [e69c9d6]
  - @capybara-hq/kernel@0.1.0-rc.1

## 0.1.0-rc.1

### Patch Changes

- 1a22b92: `createDualReplicaHarness` works when `@capybara-hq/testing` is installed from npm: when an
  extension entry is a TypeScript file (the plugin under test by path, `fakeExtensionEntry(...)`),
  each replica runs under tsx, now a dependency of this package and resolved from it, so the
  plugin's `./x.js` imports map to `.ts` and the fake extensions under `node_modules` load. A plugin
  repository no longer needs `NODE_OPTIONS: "--import tsx"`; the plugin-tools README says so.
