# @capybara-hq/plugin-tools

## 0.1.1

### Patch Changes

- d682a55: The testing package ships fake extensions, one or more per extension point, that core tests load
  instead of the official plugins and the plugins repository can reuse: `fake-connector`
  (`connector@1`, a small MCP client for `startFakeMcpServer`), `fake-object-store` (`object-store@1`
  on the `startTestS3` container), `fake-tools-ui` (a tool, a conversation view, a migration, a skill
  and a connector template), `fake-storage-user` (tools that use `ctx.storage`), `fake-embed` (embeds
  with token-checked routes and SSE over the bus), `fake-bootstrap-a` / `fake-bootstrap-b` (a model
  provider and a PostgreSQL-backed object store that need deployment config) and the dependency pair
  `fake-dep-provider` / `fake-dep-requirer`. They live in `fixtures/extensions/<name>` in the pack
  layout (now in the package `files`); `fakeExtensionDir`, `fakeExtensionEntry` and
  `packFixture(name, outDir)` locate and pack them. `fake-im` (a whole IM platform for `startFakeChannelServer`: channel, login,
  directory and a write tool that asks) joins them.
  
  Kernel-level helpers for an extension's own tests, so a plugin's tests import only the SDK and this
  package: `startTestKernel` / `testKernelConfig` (one in-process kernel), `createLocalAccount`,
  `login`, `joinOrg`, `createOrg`, `createAgent`, `createConversation`, `postMessage`, `eventsOf`,
  `waitForEvent`, `waitForTerminal`, `waitFor`, `sleep`, `cardRecorded`, `truncateTables`, `openSse`,
  `pidOwningLocalPort`, `TEST_PASSWORD`, and re-exports of the kernel's `createDb`, `kernelDb`, its
  database and event types and the texts, queue names and keys tests assert on. The kernel exports
  `ConversationEvent`, `gatewayReplicasKey`, `UNKNOWN_RESULT_TEXT`, `MAINTENANCE_QUEUE_NAME`,
  `runJobId`, `SANDBOX_LOCK_TTL_MS`, `SANDBOX_STARTED_NOTICE` and `SANDBOX_RECREATED_NOTICE` for them.
  
  New package `@capybara-hq/plugin-tools`, the plugin toolchain with a `capybara-plugin` bin: `pack`
  (the plugin packer, `--all <root>` for a repository, `--bootstrap` for a bootstrap manifest),
  `check` (every plugin-scoped check: dependency boundary, extension state, permissions, pack, tool
  design, migrations, and with `--base` the applied-migrations rule; it finds `<root>/plugins/*` or a
  single-plugin repository), `sync-versions` (copies a plugin's package.json version into its
  plugin.json and extension manifest after `changeset version`) and `release` (the npm half of the release: publish plan, dist tags,
  publishing, checksums), also as library functions. Core's `pnpm pack-plugin`, `pack-plugins`,
  `pack-bootstrap`, `release` and the plugin checks of `pnpm check` run it. The testing package's
  `packFixture` now uses it, as an optional peer dependency.
  
  The official marketplace is now configured as the git repository
  `https://github.com/capybara-hq/plugins.git` (`marketplaces.official.url` default; still off by
  default, `marketplaces.official.enabled: false`, until it is published). The startup sync stores the
  form of the configured URL (git or http) and drops the ETag and last commit when the URL or form
  changes; mirrors on a git official URL are a config error naming `marketplaces.official.mirrors`.
  The kernel exports its git reader (`readGitTree`, `GitSourceError`, `ReadGitTreeOptions`).
  
  `capybara-plugin pack --bootstrap` supports `source: "npm"` entries: they are downloaded from
  `--registry` (default `CAPYBARA_PACKAGES__NPM_REGISTRY` or the public registry) and written only
  when their bytes match the pinned sha512, so a tampered tarball or an unpublished version fails the
  image build. The npm helpers (`fetchNpmTarball`, `downloadPinnedNpmPackage`, `NpmPackageError`) are
  exported from `@capybara-hq/plugin-tools/pack`.
- 7f9627d: The plugin packer ships agent templates (`agents/<name>.md`, listed in `plugin.json` `agents` or
  scanned), checks them with `parseAgentTemplate`, and refuses duplicate template names and more than
  64 scanned agent templates.
- Updated dependencies [dad2a4f]
- Updated dependencies [89b4521]
- Updated dependencies [c2c826b]
- Updated dependencies [d682a55]
- Updated dependencies [9a5a340]
- Updated dependencies [7f9627d]
- Updated dependencies [452b6e4]
- Updated dependencies [85d8d40]
- Updated dependencies [e07bdd4]
- Updated dependencies [141d834]
- Updated dependencies [329db81]
- Updated dependencies [b50154b]
- Updated dependencies [9493b97]
- Updated dependencies [21b1385]
- Updated dependencies [21b1385]
  - @capybara-hq/kernel@0.2.0
  - @capybara-hq/plugin-sdk@0.2.0
