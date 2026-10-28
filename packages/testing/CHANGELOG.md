# @capybara-hq/testing

## 0.1.0-rc.2

### Patch Changes

- e69c9d6: The bootstrap step obtains its packages itself: once it is not done for the manifest, under the
  advisory lock and before writing anything, each pinned plugin comes from a `*.tgz` of the offline
  directory whose sha512 matches (any file name), else from `packages.npmRegistry`, verified against
  the pin (new error `bootstrap.download_failed`, 502). A done run reads no directory and no network.
  New config key `bootstrap.dir` (`CAPYBARA_BOOTSTRAP__DIR`, default `bootstrap`). `createKernel`
  takes `bootstrap: { dir? }` instead of `bootstrapDir`, and the dual-replica harness's
  `bootstrap.dir` is optional.
- Updated dependencies [75d7a0c]
- Updated dependencies [e69c9d6]
- Updated dependencies [6ad094b]
  - @capybara-hq/kernel@0.1.0-rc.1
  - @capybara-hq/plugin-tools@0.1.0-rc.2

## 0.1.0-rc.1

### Patch Changes

- 1a22b92: `createDualReplicaHarness` works when `@capybara-hq/testing` is installed from npm: when an
  extension entry is a TypeScript file (the plugin under test by path, `fakeExtensionEntry(...)`),
  each replica runs under tsx, now a dependency of this package and resolved from it, so the
  plugin's `./x.js` imports map to `.ts` and the fake extensions under `node_modules` load. A plugin
  repository no longer needs `NODE_OPTIONS: "--import tsx"`; the plugin-tools README says so.
- Updated dependencies [1a22b92]
  - @capybara-hq/plugin-tools@0.1.0-rc.1
