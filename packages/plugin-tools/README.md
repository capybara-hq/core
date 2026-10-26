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
capybara-plugin pack --bootstrap <manifest> [--root <dir>] [--out <dir>]
capybara-plugin check [--root <dir>] [--plugins <glob>] [--base <ref>]
capybara-plugin release [--dry-run] [--provenance] [--out <dir>] [--auto] [--root <dir>]
```

- **pack**: a plugin directory (`package.json` + `.capybara-plugin/plugin.json`, an optional
  extension in `src/index.ts`, `skills/`, `connectors/`, `migrations/`, `ui/`) becomes a
  byte-reproducible plugin tgz: the extension bundled by esbuild into single-file ESM, its static
  manifest written into `plugin.json`, LICENSE / NOTICE and the bundled dependencies' notices
  included. `--all <root>` packs every plugin of a repository; `--bootstrap` packs the entries of a
  bootstrap manifest and checks them against their pinned sha512. Output: `artifacts/plugins`.
- **check**: every plugin check, on the plugins under `<root>/plugins/*` (or `--plugins <glob>`, or
  the root itself when it is a plugin): the dependency boundary (a plugin depends only on
  `@capybara-hq/plugin-sdk` and third-party packages), extension state under multiple replicas (no
  timers, no module-level mutable state), the permission manifest (hooks, UI, storage, HTTP,
  secrets, tools), packing into a valid plugin package, the tool design rules (English
  descriptions, actionable errors) and the migrations (naming, idempotent, no unmarked destructive
  statements). `--base <ref>` also fails when the diff edits, deletes or renames an applied
  migration. No plugin found is an error.
- **release**: publishes every non-private workspace package whose version is not on npm yet:
  plugins (the packages under `plugins/`) as their plugin tgz, libraries through `pnpm pack`, with
  the dist-tag rule (prerelease `next`, backport `release-<major>.<minor>`, else `latest`), then
  writes the plugins' `SHA512SUMS` and `integrity.json`. `--auto` is the push-to-main mode
  (committed tree only, never the first release).

Relative paths on the command line resolve against the directory you ran it from; the default root
and output directories are under the current directory of the process (the package root when run
from a package script).

## Library

The same code as functions: `packPlugin`, `packBootstrap`, `pluginChecks` / `runChecks` and each
check (`checkDeps`, `checkPluginState`, `checkPluginPermissions`, `checkPluginPack`,
`checkToolDesign`, `checkMigrations`, `checkAppliedMigrations`), `syncPluginVersions` (after
`changeset version`), `planPublish`, `distTagFor`, `runPublish` and `integrityOf`. The subpaths
`@capybara-hq/plugin-tools/pack`, `/release` and `/source` load without the kernel.

- How plugins are written: [.agents/skills/writing-plugins](https://github.com/capybara-hq/core/tree/main/.agents/skills/writing-plugins).
- The repository: [capybara-hq/core](https://github.com/capybara-hq/core).
