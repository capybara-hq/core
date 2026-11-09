# @capybara-hq/plugin-tools

The toolchain for [Capybara](https://github.com/capybara-hq/core) plugins: the `capybara-plugin`
CLI packs plugins into plugin tgz files, runs the plugin checks, keeps a marketplace manifest and
publishes a workspace to npm.
Capybara's own repositories use it (core for its scripts and test extensions, the plugins
repository for the official plugins); any plugin repository can.

```bash
npm install --save-dev @capybara-hq/plugin-tools
```

## Commands

```bash
capybara-plugin pack [<dir>...] [--all <root>] [--out <dir>]
capybara-plugin check [--root <dir>] [--plugins <glob>] [--base <ref>]
capybara-plugin sync-versions [--root <dir>] [--plugins <glob>]
capybara-plugin marketplace --write|--check [--base <rev>] [--root <dir>] [--file <path>]
                            [--plugins <glob>]
capybara-plugin release [--dry-run] [--provenance] [--out <dir>] [--auto] [--root <dir>]
                        [--plugins <pattern>]... [--marketplace <file>]
capybara-plugin guide <id> [--locale en|zh] [--mode <mode>] [--audience <audience>]
                      [--var <name>=<value>]...
```

- **pack**: a plugin directory (`package.json` + `.capybara-plugin/plugin.json`, an optional
  extension in `src/index.ts`, `skills/`, `connectors/`, `migrations/`, `ui/`) becomes a
  byte-reproducible plugin tgz: the extension bundled by esbuild into single-file ESM, its static
  manifest written into `plugin.json`, LICENSE / NOTICE and the bundled dependencies' notices
  included. A plugin with an extension gets `"main"` and `"exports": { ".": "./dist/index.mjs" }`,
  so once installed it resolves by package name (a test loads `@capybara-hq/plugin-model-fake`
  from npm). `--all <root>` packs every plugin of a repository. Output: `artifacts/plugins`. (The
  bootstrap plugins a kernel pins are no longer packed here: a starting kernel downloads them.)
  Each setup guide declared in `plugin.json` `setupGuides` ships as `guides/<id>.md` (required)
  and `guides/<id>.zh.md` (optional), validated with the SDK's `validateSetupGuide`: title,
  sections, check lines, variables known to the place and allowed where they stand, limits, the
  zh document's parity with the English one, and every plugin check id declared in the
  extension's `permissions.setupChecks` (a plugin without an extension may only use `capybara:`
  checks). Errors fail the pack; warnings (such as a text variable outside double quotes in a
  yaml block) are printed and fail neither `pack` nor `check` (`plugin-pack-guide`).
- **check**: every plugin check, on the plugins under `<root>/plugins/*` (or `--plugins <glob>`, or
  the root itself when it is a plugin): the dependency boundary (a plugin depends only on
  `@capybara-hq/plugin-sdk` and third-party packages), extension state under multiple replicas (no
  timers outside browser-only client modules, no module-level mutable state), the permission manifest (hooks, UI, storage, HTTP,
  secrets, tools), packing into a valid plugin package, the tool design rules (English
  descriptions, actionable errors), the migrations (naming, idempotent, no unmarked destructive
  statements, one file per number in a directory), the plugin tests' imports (`plugin-test-imports`: a file under `<plugin>/test` uses
  only `@capybara-hq/plugin-sdk`, `@capybara-hq/plugin-client` (and its `/testing` fake host),
  `@capybara-hq/testing`, `@capybara-hq/plugin-model-fake`, the plugin itself and files inside the plugin, by import, package-name string or path) and the
  release metadata (`plugin-release-metadata`: a public plugin has a `description`, a `license`, an
  https `homepage` and `repository` `{ type: "git", url: <the root package.json's
  repository.url>, directory: <its dir> }`; `example-*` plugins are private; its `plugin.json`
  has a `displayName`, and `release-description-zh` warns, without failing, when its `description`
  has no `zh`). Warnings are printed under `passed with N warning(s)`. `--base <ref>` also fails when the diff edits, deletes or renames an applied
  migration, or adds one numbered at or below the highest number of its directory at `<ref>`. No plugin found is an error. A plugin may list `@capybara-hq/plugin-tools` (like
  `@capybara-hq/testing`) in its devDependencies.
- **guide**: prints a setup guide of the plugin in the current directory as the kernel renders
  it for one locale (`en` default, `zh` falling back to English), mode (default: the place's
  first) and audience (default: the place's first), with `--var name=value` for the place's
  variables (`{{mode}}` is the mode rendered, so `--var mode` is refused): the title, each block (Markdown as is, code fenced with its title, a check as
  `[check <id>] <label>`), then `unresolved: …` (variables the text uses without a value, or
  `none`). An invalid guide prints its issues and exits 1; warnings go to stderr.
- **sync-versions**: after `changeset version` (which bumps only `package.json`), copies each
  plugin's version into its `.capybara-plugin/plugin.json` and its extension manifest
  (`src/index.ts`, `  version: "x"`), which the packer requires equal.
- **marketplace**: `--write` keeps one npm entry per public plugin in
  `.capybara-plugin/marketplace.json` (`--file`), its current version (`name`, `version`,
  `summary` from the `plugin.json` `description`, `displayName` from `plugin.json`, `homepage`,
  `permissions`, `source.npm` with the sha512 of a reproducible pack), formatted as Biome formats
  it: a plugin whose version moved gets its entry replaced in place, its other versions are
  dropped, a listed entry's `summary` / `displayName` are refreshed from `plugin.json`
  (`marketplace-display-stale` in `--check`; source and integrity untouched), and entries of
  plugins not in the tree are kept. `--check` fails when a plugin's
  current version is missing or not its only entry (`marketplace-missing`) or the file does not
  parse (`marketplace-invalid`). A version already listed is not compared with the tree: once
  published, its bytes are the release gate's business. `--check --base <rev>` (pull requests)
  also requires a plugin's version to only increase over the versions `<rev>` lists
  (`marketplace-version-decrease`), a version `<rev>` lists to keep its integrity, and the entries
  added since to match their packs (`marketplace-integrity`).
- **release**: publishes every non-private workspace package whose version is not on npm yet:
  plugins (the packages under `plugins/`) as their plugin tgz, libraries through `pnpm pack`, with
  the dist-tag rule (prerelease `next`, backport `release-<major>.<minor>`, else `latest`), then
  writes the plugins' `SHA512SUMS` and `integrity.json`. `--auto` is the push-to-main mode
  (committed tree only, never the first release). The workspace packages are the directories with a
  `package.json` in `packages/*`, `apps/*`, `plugins/*` and `tools/*` under `--root`; none found is
  an error. `--plugins <pattern>` (repeatable) plans only the matching plugins (libraries are unaffected; a pattern matching none is an error);
  `--marketplace <file>` (default `.capybara-plugin/marketplace.json` under the root when it
  exists) packs every planned plugin and checks its sha512 against that version's entry before the
  first publish; a mismatch or a missing entry stops the run with nothing published
  (`release.integrity_mismatch`).

Relative paths, the default root and the output directories resolve against the current directory
of the process: in a package script that is the package's directory, so `"pack": "capybara-plugin
pack ."` in a plugin's `package.json` packs that plugin. `capybara-plugin <command> --help` prints
one command's usage.

## Testing plugins against the published kernel

A plugin's kernel-level tests load the plugin by path (`plugins/<name>/src/index.ts`, imports
written `./x.js`) into a kernel installed from npm. Vitest externalizes `node_modules`, so the
kernel's `import()` would run in plain Node, which does not map `./x.js` to `./x.ts`. Inline the
core packages in `vitest.config.ts` (the pattern is matched against the resolved file path, not
the package name):

```ts
export default defineConfig({
  test: { server: { deps: { inline: [/\/node_modules\/@capybara-hq\//] } } },
});
```

Dual-replica tests (`createDualReplicaHarness`) need nothing more: each replica is a child
process outside vitest, and `@capybara-hq/testing` runs it under its own tsx when an extension
entry is a TypeScript file (the plugin under test by path, `fakeExtensionEntry(...)`). Do not set
`NODE_OPTIONS: "--import tsx"` in the vitest config: it reaches every worker and child process
and hides packaging bugs.

## Library

The same code as functions: `packPlugin`, `downloadPinnedNpmPackage`, `pluginChecks` / `runChecks` and each
check (`checkDeps`, `checkPluginState`, `checkPluginPermissions`, `checkPluginPack`,
`checkToolDesign`, `checkMigrations`, `checkAppliedMigrations`, `checkPluginTestImports`,
`checkPluginReleaseMetadata`), `syncPluginVersions` (after `changeset version`),
`syncMarketplace`, `planPublish`, `distTagFor`, `runPublish` and `integrityOf`. The subpaths
`@capybara-hq/plugin-tools/pack`, `/release` and `/source` load without the kernel.

- How plugins are written: [.agents/skills/writing-plugins](https://github.com/capybara-hq/core/tree/main/.agents/skills/writing-plugins).
- The repository: [capybara-hq/core](https://github.com/capybara-hq/core).
