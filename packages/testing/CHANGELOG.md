# @capybara-hq/testing

## 0.1.1

### Patch Changes

- 89b4521: Marketplace downloads refuse private addresses and redirects: every host must resolve to a public
  address (or be listed in `marketplaces.allowPrivateHosts`), and the connection is pinned to the
  checked address.
  
  Plugins can be read from git commits (smart HTTP over the same network rules: depth 1, no tags or
  submodules, size and file limits); `@capybara-hq/testing` adds `startFakeGitServer`.
  The SDK exports `hostSdkProblem` (the host SDK range check of `validatePluginPackageJsonFor`).
  
  Git marketplaces: a marketplace can be a git repository (`owner/repo`, an https `.git` URL or
  `form: "git"`, optional `ref`); a refresh reads `.capybara-plugin/marketplace.json` or treats a
  single-plugin repo as one entry, and skips an unchanged commit. `path` and `git` entries are
  imported from git (source `git`, with host, repo, path, commit and "follows a branch" recorded),
  `POST /api/v1/admin/catalog/import/git` imports one plugin straight from git, and
  `marketplaces.allowedHosts` limits the hosts entries may download from (migration 0046).
  
  Every catalog version records a content digest (sha256 over its files, the same for a tgz and a
  git tree). Re-importing an imported version with other content records `<version>+git.<sha12>` /
  `+sha256.<12>` (the same content is refused as already imported); versions are ordered by semver
  without build metadata, ties by import time. Marketplace entries and catalog items show
  `contentChanged` when an imported version's commit or integrity no longer matches the entry (a
  refresh resolves the branch heads of imported branch-following git entries, migration 0047; git
  sources compare the tree oid of the plugin's directory, so a monorepo commit elsewhere changes
  nothing, migration 0048). An
  archive without plugin.json is a skills-only plugin versioned `0.0.0-sha256.h<12>`.
  
  The import review shows npm provenance for npm and npm-backed marketplace imports (`provenance`:
  repository, commit, workflow and build type from the registry's SLSA attestation, signatures not
  verified; otherwise `checked: false` with a reason) and `provenanceWarning: "repository_mismatch"`
  when a git marketplace's repository differs from the attested one; `@capybara-hq/testing` serves
  attestations (`npmProvenanceAttestations`). An org install whose skill name exists as the org's own
  skill or another plugin's is refused with 409 `plugin.skill_conflict`, nothing written; a reinstall
  of the same plugin still adds a version.
  
  Org admins upgrade an installed plugin in place (spec §10): `POST
  /api/v1/orgs/:orgId/plugin-installs/:installId/upgrade/preview` returns the per-component diff,
  the inputs needed and a `diffHash`; `POST …/upgrade` applies it (409 `plugin.upgrade_stale` on
  another diff, 202 with a request for needs_approval items). An extension-bearing plugin can move
  only to the catalog version carrying the deployment's extension (`plugin.upgrade_target_invalid`);
  a declarative one to any imported version. Skills get new versions, connectors only their
  template-owned fields (credentials kept unless their shape changes), removals follow the uninstall
  rules; a failed step undoes the upgrade (502 `plugin.upgrade_failed`), an interrupted one is undone
  after `catalog.staleInstallMinutes`. Install views gain `upgradeAvailable` and `deploymentPending`
  (migration 0049: status `upgrading`, the upgrade journal, connector components' `template_id`, `dropped` for a component kept
  after leaving the plugin because an agent uses it).
  
  The web console adds git marketplaces (a repository with an optional ref), each entry's source
  (pinned commit or followed branch), "content changed at the same version", a version's origin, the
  import review's npm provenance, an "Import from git" source, and plugin upgrades from the installed
  plugins and the catalog item page (a preview of the changes and inputs, then confirm).
  
  The upgrade preview carries the target version's connector templates its inputs name
  (`templates`). The network, git and upgrade-target errors (`marketplace.host_not_allowed`,
  `private_address`, `redirect`, `git_*`, `path_unsupported`, `plugin.upgrade_target_invalid`) carry
  structured details (host, repo, ref or commit, refused entry, the version rule) next to the message.
  
  `capybara plugins import git:<url>[#<ref>][:<path>]` imports a plugin folder straight from a git
  repository under the same network rules; the CLI's review prints the git location and commit, the
  content digest and npm provenance.
- c2c826b: Marketplace, archive and git downloads can go through an HTTP(S) egress proxy: set `net.httpsProxy`
  (credentials in the URL are sent as Basic proxy auth and never logged) and `net.noProxy` for hosts
  that go direct. Behind the proxy the kernel no longer resolves the target (the proxy does and owns
  SSRF protection for DNS names); IP-literal private targets are still refused, and a proxy refusing
  `CONNECT` is reported as `net.proxy_refused`.
  
  The plugin SDK adds the bootstrap manifest (`parseBootstrapManifest`, `bootstrapFileName`, JSON
  Schema `schemas/bootstrap.v1.schema.json`) for `packages/kernel/bootstrap.json`, the plugins a
  deployment installs at init, each pinned to an exact version and sha512.
  
  Bootstrap plugins replace the builtin extensions. The kernel runs the bootstrap step at start
  (`KernelOptions.bootstrapDir`, optional `bootstrapManifest`; once per manifest across replicas, under
  an advisory lock) before loading extensions: every package is checked against its pinned sha512
  (`bootstrap.integrity_mismatch`, `bootstrap.missing_file`), imported into the catalog and installed
  with source `bootstrap`, pre-approved (snapshot source `bootstrap`) and enabled; a raised version
  upgrades a plugin still at its bootstrap version, a higher one is never downgraded, and an entry
  that left the manifest only loses `required`. A required plugin is enabled in every organization
  without an org config row and cannot be disabled or uninstalled (409 `extension.required`); `start()`
  refuses to serve when a required entry cannot be installed. `KernelOptions.builtinExtensions`, the
  `builtin` extension source and `extension.builtin` are removed. The testing harness takes
  `bootstrap: { dir, manifest }` instead of `builtinExtensions`.
  
  The CLI no longer depends on `@capybara-hq/plugin-openai-compatible` or
  `@capybara-hq/plugin-object-store-s3`. `capybara bootstrap [--dir <path>] [--manifest <path>]` runs
  the bootstrap step from the packages in `/app/bootstrap`, which the kernel image now carries (packed
  from the workspace and checked against `bootstrap.json` at build time); compose `init` runs it
  between `migrate` and `admin create`, and `capybara start` runs it too when it finds the step not
  done (`--bootstrap-dir`, else `/app/bootstrap` when it exists). The CLI's object store (plugin
  imports with files) may now be an enabled, approved install record such as the bootstrap
  object-store-s3, and `capybara extensions list` shows bootstrap plugins with source `bootstrap` and
  desired state `required`.
  `capybara bootstrap` exits 1 when a required entry fails or a package is missing or tampered, and
  exits 0 with warnings when only optional entries still fail after its second pass (as `start` does).
  The org extensions page shows required plugins as "Required" with a read-only switch.
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
- 85d8d40: Rename to extension terms before the first release
- e07bdd4: Package formats: plugin.json and marketplace.json replace the `capybara` package.json section,
  the bundle manifest and the catalog index.json, which are removed from the SDK.
- a5eec95: `startFakeGitServer` spawns git less: a commit is one `git fast-import` (it was five or more git
  commands), and a ref advertisement is answered by `git http-backend` once per repository state and
  repeated until the next commit. Every answer still comes from git.
- Updated dependencies [dad2a4f]
- Updated dependencies [89b4521]
- Updated dependencies [c2c826b]
- Updated dependencies [d682a55]
- Updated dependencies [9a5a340]
- Updated dependencies [7f9627d]
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
  - @capybara-hq/plugin-tools@0.1.1
