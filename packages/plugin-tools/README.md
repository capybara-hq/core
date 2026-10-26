# @capybara-hq/plugin-tools

The toolchain for [Capybara](https://github.com/capybara-hq/core) plugins: the `capybara-plugin`
CLI packs plugins into plugin tgz files, runs the plugin checks and publishes a workspace to npm.
Capybara's own repositories use it (core for its scripts and test extensions, the plugins
repository for the official plugins); any plugin repository can.

```bash
npm install --save-dev @capybara-hq/plugin-tools
```

## Commands

```bash
capybara-plugin pack [<dir>...] [--all <root>] [--out <dir>]
capybara-plugin pack --bootstrap <manifest> [--root <dir>] [--out <dir>] [--registry <url>]
capybara-plugin check [--root <dir>] [--plugins <glob>] [--base <ref>]
capybara-plugin sync-versions [--root <dir>] [--plugins <glob>]
capybara-plugin release [--dry-run] [--provenance] [--out <dir>] [--auto] [--root <dir>]
```

- **pack**: a plugin directory (`package.json` + `.capybara-plugin/plugin.json`, an optional
  extension in `src/index.ts`, `skills/`, `connectors/`, `migrations/`, `ui/`) becomes a
  byte-reproducible plugin tgz: the extension bundled by esbuild into single-file ESM, its static
  manifest written into `plugin.json`, LICENSE / NOTICE and the bundled dependencies' notices
  included. `--all <root>` packs every plugin of a repository; `--bootstrap` packs the entries of a
  bootstrap manifest (workspace entries from the repository, npm entries downloaded from
  `--registry`, default `CAPYBARA_PACKAGES__NPM_REGISTRY` or the public registry) and checks them
  against their pinned sha512. Output: `artifacts/plugins`.
- **check**: every plugin check, on the plugins under `<root>/plugins/*` (or `--plugins <glob>`, or
  the root itself when it is a plugin): the dependency boundary (a plugin depends only on
  `@capybara-hq/plugin-sdk` and third-party packages), extension state under multiple replicas (no
  timers, no module-level mutable state), the permission manifest (hooks, UI, storage, HTTP,
  secrets, tools), packing into a valid plugin package, the tool design rules (English
  descriptions, actionable errors) and the migrations (naming, idempotent, no unmarked destructive
  statements). `--base <ref>` also fails when the diff edits, deletes or renames an applied
  migration. No plugin found is an error. A plugin may list `@capybara-hq/plugin-tools` (like
  `@capybara-hq/testing`) in its devDependencies.
- **sync-versions**: after `changeset version` (which bumps only `package.json`), copies each
  plugin's version into its `.capybara-plugin/plugin.json` and its extension manifest
  (`src/index.ts`, `  version: "x"`), which the packer requires equal.
- **release**: publishes every non-private workspace package whose version is not on npm yet:
  plugins (the packages under `plugins/`) as their plugin tgz, libraries through `pnpm pack`, with
  the dist-tag rule (prerelease `next`, backport `release-<major>.<minor>`, else `latest`), then
  writes the plugins' `SHA512SUMS` and `integrity.json`. `--auto` is the push-to-main mode
  (committed tree only, never the first release). The workspace packages are the directories with a
  `package.json` in `packages/*`, `apps/*`, `plugins/*` and `tools/*` under `--root`; none found is
  an error.

Relative paths, the default root and the output directories resolve against the current directory
of the process: in a package script that is the package's directory, so `"pack": "capybara-plugin
pack ."` in a plugin's `package.json` packs that plugin. `capybara-plugin <command> --help` prints
one command's usage.

## Library

The same code as functions: `packPlugin`, `packBootstrap`, `pluginChecks` / `runChecks` and each
check (`checkDeps`, `checkPluginState`, `checkPluginPermissions`, `checkPluginPack`,
`checkToolDesign`, `checkMigrations`, `checkAppliedMigrations`), `syncPluginVersions` (after
`changeset version`), `planPublish`, `distTagFor`, `runPublish` and `integrityOf`. The subpaths
`@capybara-hq/plugin-tools/pack`, `/release` and `/source` load without the kernel.

- How plugins are written: [.agents/skills/writing-plugins](https://github.com/capybara-hq/core/tree/main/.agents/skills/writing-plugins).
- The repository: [capybara-hq/core](https://github.com/capybara-hq/core).
