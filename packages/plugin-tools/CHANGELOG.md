# @capybara-hq/plugin-tools

## 0.1.0-rc.4

### Minor Changes

- 517ca1e: The packer writes an extension's config schemas into `plugin.json` as `extension.configSchemas`
  (`configJsonSchema`, with the `x-ui` hints) and refuses invalid hints, including `options` /
  `presets` on a secret. `capybara-plugin check` gains "Config forms" (`plugin-config-ui`,
  `plugin-config-labels`: a published plugin labels every rendered config field in zh and en) and
  `release-display-name` (a published plugin's `plugin.json` needs `displayName`).
  `importPluginExtension`, `extensionConfigSchemas` and `missingConfigLabels` are exported.
  
  Compatibility (pre-1.0 ruling): a plugin packed by this version that declares config carries
  `extension.configSchemas`, which an older kernel refuses ("unrecognized key" from its strict
  section parser) rather than through the SDK range. Kernel and plugins move together before 1.0,
  so upgrade the kernel before importing plugins packed by this version.

### Patch Changes

- 9e9ce5b: Config forms review fixes. Kernel: a config UI hint conversion that throws (a hand-made package)
  no longer fails the org extension list, the org config refusal or the channel connection schema:
  one never-throwing conversion serves the plain schema (hints stripped), else none, with one
  warning per schema. Plugin-tools: the packer refuses a packed `plugin.json` whose text is over
  `PLUGIN_MANIFEST_LIMITS.manifestChars`. Web: saving a replaced secret resets the deployment config
  form even when the view comes back unchanged; the install wizard and the upgrade dialog title the
  extension config card with its display name.
- f015dff: Two migration numbering rules: `capybara-plugin check` reports two files of one migrations
  directory that share a number (`migration-duplicate-number`), and `--base <ref>` also fails when
  the diff adds a migration numbered at or below the highest number of its directory at `<ref>`
  (`migration-number-behind-base`; `checkMigrationNumbers` / `diffMigrationNumbers`).
- Updated dependencies [ce0e90c]
- Updated dependencies [9d134ee]
- Updated dependencies [0344386]
- Updated dependencies [1e092a6]
- Updated dependencies [9e9ce5b]
- Updated dependencies [0ec51d1]
- Updated dependencies [8e43ed7]
- Updated dependencies [9b89920]
- Updated dependencies [258d286]
- Updated dependencies [69b3bbe]
- Updated dependencies [489d640]
- Updated dependencies [58d08b1]
- Updated dependencies [70688ca]
- Updated dependencies [49fa38b]
- Updated dependencies [0f1507e]
- Updated dependencies [80f4844]
- Updated dependencies [76da814]
- Updated dependencies [8e928cb]
- Updated dependencies [3455513]
- Updated dependencies [81adaff]
- Updated dependencies [4ef89b8]
- Updated dependencies [c01c117]
- Updated dependencies [f28ed05]
- Updated dependencies [2bd8351]
- Updated dependencies [c9c8625]
- Updated dependencies [8f7ba64]
- Updated dependencies [8892d50]
  - @capybara-hq/kernel@0.1.0-rc.4
  - @capybara-hq/plugin-sdk@0.1.0-rc.2

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
