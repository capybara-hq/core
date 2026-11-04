# @capybara-hq/plugin-tools

## 0.1.0-rc.3

### Patch Changes

- f2317ec: `capybara-plugin check` reports `plugin-tool-key-length`: the key `plugin__<extension>__<tool>` of
  every `ctx.tools.register` must fit in 64 characters (a name that is not a literal cannot be
  confirmed, like `perm-tools`).
- 72bada5: The `tool-error-actionable` check accepts `read` as an action verb in a `ToolError` message.
- Updated dependencies [8bf0b04]
- Updated dependencies [e1127f5]
- Updated dependencies [307c611]
- Updated dependencies [1beea7e]
- Updated dependencies [56e83dd]
- Updated dependencies [48d3983]
- Updated dependencies [a1bfe76]
- Updated dependencies [0f4b28a]
- Updated dependencies [8881b9a]
- Updated dependencies [32580d3]
- Updated dependencies [75b1aaf]
  - @capybara-hq/plugin-sdk@0.1.0-rc.1
  - @capybara-hq/kernel@0.1.0-rc.3

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
