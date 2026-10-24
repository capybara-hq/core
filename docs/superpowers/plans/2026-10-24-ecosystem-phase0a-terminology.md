# Package Ecosystem Phase 0a: Terminology Rename Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename every externally visible and internal name to the package ecosystem terms (extension, extension point, plugin = bundle, catalog, marketplace) before the first public release, with no compatibility aliases.

**Architecture:** Three domain passes, in a fixed order so names never collide mid-rename: (1) the old in-process "plugin" becomes **extension** (frees `plugin`), (2) enterprise directory becomes **catalog** after catalog sources become **marketplaces** (frees `catalog`), (3) the app bundle becomes **plugin**. Then the cross-cutting surfaces (HTTP, config, CLI, web, docs) follow, and a new check keeps old names from coming back. Package formats are NOT changed here; that is plan 0b.

**Tech Stack:** TypeScript, pnpm monorepo, NestJS + Fastify kernel, Kysely + PG migrations, Next web app, vitest, Playwright, api-extractor.

**Spec:** `docs/superpowers/specs/2026-10-22-package-ecosystem-design.md` (§1, §12 phase 0, §13). Plan 0b (package formats: `plugin.json`, `marketplace.json`, one catalog kind, org plugin install) follows this plan and is written separately.

## Global Constraints

- No compatibility aliases, no dual names, no deprecation shims (spec §13, decided 2026-10-24). Nothing is published yet.
- **Frozen (never renamed)** — replay and data locations (spec §13):
  - event payload fields and types in `packages/kernel/src/conversations/events.ts` (`hook_denied.plugin`, `appId` / `appName`, `catalog: [{key, specHash}]`, `skills_catalog`), stored agent tool refs `{kind:"plugin", plugin, name}`, tool source ids `plugin:<plugin>:<name>`, tool keys, the bus message `{ kind: "ui"; plugin; contribution }`;
  - model-visible text: `PLUGIN_UNLOADED_TOOL_ERROR`, `TOOLS_UNAVAILABLE_PREFIX`, "Plugin <name> is not enabled in this organization" (`tools/registry.ts`), `Tool call blocked by the "<plugin>" policy hook` (`tools/pipeline.ts`);
  - PG schemas `plugin_<name>`, storage prefixes `plugins/<plugin>/<orgId>/` and `kernel/<orgId>/`, kv / queue / Redis prefixes, `/plugin-ui` proxy path and embed tokens, `/var/lib/capybara/plugins`, the extension HTTP route prefix `/plugins/<name>/…` (designer's call: the extension's name is its plugin's name, so the path stays correct), the web route `/p/[plugin]/[id]`;
  - `directory@1` (directory sync) and everything belonging to it: SDK `Directory`, `DirectoryMember`, `DIRECTORY_*` sync names, table `directory_exclusions`, `/orgs/:orgId/…/directory/sync` keeps the `directory` segment;
  - `apps/web/src/dev/catalog/*`, `apps/web/visual/catalog.spec.ts`, `apps/web/test/catalog.test.tsx` (the `/dev/ui` component catalog);
  - model attributes `capabilities.vision` / `documents` (`ModelInfo.capabilities`);
  - `packages/design` `AppShell`; the `plugins/*` directory and plugin npm names `@capybara-hq/plugin-*`; `@capybara-hq/plugin-sdk`; fixture directory names `packages/kernel/test/fixtures/plugins/*`;
  - migration files `0001`–`0040` (never edit an applied migration); the synced skills `onboarding` / `contributing` / `reviewing-prs`; historical plans in `docs/superpowers/plans/` dated before 2026-10-24.
- **Left for plan 0b** (it deletes or replaces them, so 0a does not rename them): SDK `CatalogIndex*`, `parseCatalogIndex`, `CATALOG_*`, `CatalogEntry`, `CatalogVersion`, `AppManifest*`, `parseAppManifest`, `APP_MANIFEST_*`, `App*Section`, `PACKAGE_KINDS`, `PackageKind`, `PackageSection`, `parsePackageSection`, `CapybaraPackageSection`, `PluginPackageSection`, `SkillPackageSection`, `ConnectorTemplateSection`, `validatePluginPackageJson`, `staticManifestOf`, `PLUGIN_PACKAGE_ENTRY`, the JSON Schemas `app.v1` / `catalog-index.v1`, the catalog `kind` CHECK values, `app.yaml` handling.
- Every rename keeps behaviour: no logic change in this plan. A test that changes beyond names is a red flag.
- Migrations follow `.agents/skills/writing-migrations/SKILL.md` and the precedent `0033_rename_apps_to_connectors.sql`: `ALTER TABLE IF EXISTS … RENAME TO`, column renames inside an `information_schema`-guarded `DO` loop, each destructive statement preceded by `-- capybara:allow-destructive <reason>`; index, FK and PK names are not renamed (as 0033); idempotent.
- Audit actions written from now on use the new names; existing rows are not rewritten. `LEGACY_AUDIT_ACTIONS` (connector aliases in `identity/audit.ts`) stays as is.
- English for new comments; translate comments and test titles you edit (AGENTS.md "Language").
- Commits: Conventional Commits, body lines ≤ 100, `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. One changeset for the branch (Task 1) covering `@capybara-hq/plugin-sdk`, `@capybara-hq/kernel`, `@capybara-hq/testing`, `@capybara-hq/capybara` (patch); it is cleared before the first manual publish (spec §12).
- Run single tests from the repo root: `pnpm exec vitest run <path>`. Before each commit: `pnpm lint && pnpm typecheck`; `pnpm check` where the task touches checked areas.

## Naming tables (the decisions every task uses)

### Extension domain (Task 1–2)

| Old | New |
|---|---|
| SDK `definePlugin`, `PluginManifest`, `PluginContext`, `StaticPluginManifest`, `PluginManifestError`, `PluginPermissions`, `PluginPermissionError`, `PluginStorage`, `PLUGIN_NAME_RE`, `PLUGIN_TOOL_NAME` | `defineExtension`, `ExtensionManifest`, `ExtensionContext`, `StaticExtensionManifest`, `ExtensionManifestError`, `ExtensionPermissions`, `ExtensionPermissionError`, `ExtensionStorage`, `EXTENSION_NAME_RE`, `EXTENSION_TOOL_NAME` |
| SDK `CapabilityRef`, `CapabilityInfo`, `CAPABILITIES`, `CAPABILITY_CARDINALITY`, `parseCapability`, `CapabilityUnavailableError`, `ctx.capabilities` | `ExtensionPointRef`, `ExtensionPointInfo`, `EXTENSION_POINTS`, `EXTENSION_POINT_CARDINALITY`, `parseExtensionPoint`, `ExtensionPointUnavailableError`, `ctx.extensionPoints` |
| SDK `<X>_CAPABILITY` (`CONNECTOR`, `CHANNEL`, `DIRECTORY`, `IDENTITY_SOURCE`, `SANDBOX`, `OBJECT_STORE`, `MODEL_PROVIDER`, `MODEL_PROVIDER_CAPABILITY_V2`) | `<X>_EXTENSION_POINT` (`MODEL_PROVIDER_EXTENSION_POINT_V2`) |
| SDK files `define-plugin.ts`, `capability.ts` | `define-extension.ts`, `extension-point.ts` |
| Kernel `src/plugins/` (dir), classes `PluginHost`, `PluginInstalls`, `PluginAdminOps`, `PluginApprovals`, `PluginDeploymentConfigs`, … (every `Plugin*` class, type and file in that dir) | `src/extensions/`, `ExtensionHost`, `ExtensionInstalls`, `ExtensionAdminOps`, `ExtensionApprovals`, `ExtensionDeploymentConfigs`, … ; test dir `test/plugins/` → `test/extensions/` |
| Tables `plugin_installs`, `plugin_packages`, `plugin_blobs`, `plugin_name_owners`, `plugin_replica_status`, `plugin_permission_snapshots`, `plugin_org_configs`, `plugin_deployment_configs`, `plugin_directory_sources` | `extension_installs`, `extension_packages`, `extension_blobs`, `extension_name_owners`, `extension_replica_status`, `extension_permission_snapshots`, `extension_org_configs`, `extension_deployment_configs`, `extension_catalog_sources` |
| CHECK values `plugin_packages.source` / `plugin_installs.source` `'directory'` | `'catalog'` |
| `plugin text` columns (in `extension_*` tables, `channel_connections`, …) | unchanged (designer's call: the value is the extension's name, which equals its plugin's name) |
| Error codes `plugin.*` (20) | `extension.*` |
| Audit actions `plugin.*` (10) | `extension.*` |

### Catalog and marketplace domain (Task 3)

| Old | New |
|---|---|
| Kernel `src/directory/` (dir) | `src/catalog/`; `catalogs.*` files in it → `marketplaces.*`; test dir `test/directory/` → `test/catalog/` |
| Classes `DirectoryService`, `OrgDirectoryService`, `CatalogsService`, `CatalogFetch…`, `RequestsService` (directory requests) | `CatalogService`, `OrgCatalogService`, `MarketplacesService`, `MarketplaceFetch…`, `CatalogRequestsService` |
| Tables `catalog_sources`, `catalog_entries` (first) | `marketplaces`, `marketplace_entries` |
| Tables `directory_items`, `directory_item_versions`, `directory_requests`, `directory_org_grants` (after) | `catalog_items`, `catalog_item_versions`, `catalog_requests`, `catalog_org_grants` |
| Columns `directory_item_id` (`connectors`, `skills`, `skill_versions`, `extension_installs`), `directory_version` (`connectors`, `skills`, `skill_versions`), `catalog_source_id` (`catalog_item_versions`) | `catalog_item_id`, `catalog_version`, `marketplace_id` |
| CHECK value `directory_item_versions.source` `'catalog'` | `'marketplace'` |
| Error codes `catalog.*` (8, first) then `directory.*` (13) | `marketplace.*`, then `catalog.*` |
| Audit `catalog.*` (4) then `directory.*` (8) | `marketplace.*`, then `catalog.*` |
| SDK `DIRECTORY_ITEM_NAME_RE` | `CATALOG_ITEM_NAME_RE` |

### Bundle domain (Task 4)

| Old | New |
|---|---|
| Kernel `AppImport`, `AppInstaller`, `app-import.ts`, `app-install.ts` and their types | `PluginImport`, `PluginInstaller`, `plugin-import.ts`, `plugin-install.ts` (inside `src/catalog/`) |
| Tables `app_installs`, `app_install_components`, `app_import_staging` | `plugin_installs`, `plugin_install_components`, `plugin_import_staging` (only after Task 2 freed `plugin_installs`) |
| CHECK value `app_install_components.kind` `'plugin'` | `'extension'` |
| Error codes `app.*` (10) | `plugin.*` (`app.plugin_conflict` → `plugin.extension_conflict`) |
| Audit `app.*` bundle (3) | `plugin.*` (`plugin.org_installed`, `plugin.org_install_failed`, `plugin.org_uninstalled`) |

### Cross-cutting (Task 5–9)

| Old | New |
|---|---|
| HTTP `/api/v1/admin/plugins` | `/api/v1/admin/extensions` |
| `/api/v1/admin/catalogs` | `/api/v1/admin/marketplaces` |
| `/api/v1/admin/directory` (incl. `/requests`, `/apps/…`) | `/api/v1/admin/catalog` (`/requests`; `/apps/…` → `/plugins/…`) |
| `/api/v1/orgs/:orgId/directory…`, `/directory-requests/:id/decide` | `/api/v1/orgs/:orgId/catalog…`, `/catalog-requests/:id/decide` |
| `/api/v1/orgs/:orgId/app-installs` | `/api/v1/orgs/:orgId/plugin-installs` |
| `/api/v1/orgs/:orgId/plugins` (org extension config) | `/api/v1/orgs/:orgId/extensions` |
| `/api/v1/orgs/:orgId/plugins/:plugin/directory/sync` | `/api/v1/orgs/:orgId/extensions/:extension/directory/sync` |
| Kernel constants `PACKAGE_UPLOAD_ROUTE`, `DIRECTORY_UPLOAD_ROUTE`, `APP_UPLOAD_ROUTE` | values follow the routes; names `EXTENSION_PACKAGE_UPLOAD_ROUTE`, `CATALOG_UPLOAD_ROUTE`, `PLUGIN_UPLOAD_ROUTE` |
| Config `plugins`, `pluginConfig`, `pluginHost.*`, `pluginPermissions.*` | `extensions`, `extensionConfig`, `extensionHost.*`, `extensionPermissions.*` |
| `directory.maxBundleBytes`, `directory.staleInstallMinutes` | `catalog.maxBundleBytes`, `catalog.staleInstallMinutes` |
| `catalogs.*` (incl. `catalogs.official.*`) | `marketplaces.*` |
| CLI `capybara plugins list / install / enable / disable / uninstall / review / approve` | `capybara extensions …` (same subcommands); `capybara plugins` is left unused until plan 0b (designer's call) |
| Web pages `/admin/plugins`, `/admin/directory`, `/admin/directory/sources`, `/admin/directory/catalog`, `/admin/directory/requests`, `/admin/directory/apps/review`, `/directory/…`, `/settings/plugins`, `/settings/apps` | `/admin/extensions`, `/admin/catalog`, `/admin/marketplaces`, `/admin/marketplaces/entries`, `/admin/catalog/requests`, `/admin/catalog/plugins/review`, `/catalog/…`, `/settings/extensions`, `/settings/plugins` |
| Skill folders `writing-plugins`, `writing-plugin-ui` | `writing-extensions`, `writing-extension-ui` (`writing-apps` stays until plan 0b) |

## Review Focus

1. **Replay drift**: a renamed identifier that leaks into request building changes recorded requests. `packages/kernel/test/evals/reconstruct.test.ts` and `test/tools/rename-compat.test.ts` must pass unchanged in Task 2 and Task 5 (only setup URLs may change).
2. **A development database at M7 `main` with data** migrates forward and keeps its rows, FKs and CHECKs working; running the migrations twice is a no-op. Tested in Tasks 2–4.
3. **Blind replacements**: `skills_catalog`, the `/dev/ui` catalog, `directory@1`, `directory_exclusions`, `/plugin-ui`, `plugin_<name>` schemas, model `capabilities`. Task 10's guard has an explicit allowlist for these, and each domain task greps for them before committing.
4. **Error code ↔ UI copy**: a renamed code whose `errors.<prefix>.<code>` key was not renamed shows a raw code to users. Task 8 adds a test that every `ERROR_CODES` key has en and zh copy.
5. **Env derivation**: `CAPYBARA_EXTENSION_CONFIG__OBJECT_STORE_S3__BUCKET` must reach `extensionConfig["object-store-s3"].bucket` (the kebab-case special case in `config/env.ts`). Task 6 pins it.

---

### Task 1: SDK extension-point and extension names

**Files:**
- Modify: `packages/plugin-sdk/src/*` per the extension-domain table; rename `define-plugin.ts` → `define-extension.ts`, `capability.ts` → `extension-point.ts` (and their tests); `packages/plugin-sdk/src/index.ts` exports.
- Modify: every consumer outside the SDK (≈145 files for `definePlugin`, ≈48 for `PluginContext`, ≈15 for `CapabilityRef`; kernel src and tests and fixtures, `plugins/*/src/index.ts`, `packages/testing`, `tools/pack-plugin`, `tools/checks` and its fixtures, `apps/web` uses of `PACKAGE_KINDS` stay for 0b).
- Modify: `tools/checks/src/plugin-permissions.ts` (static analysis looks for `defineExtension` and `ctx.extensionPoints`) and its `plugin-perm-*` fixtures.
- Regenerate: `packages/plugin-sdk/api/plugin-sdk.api.md` (`pnpm gen:sdk-api`).
- Create: `.changeset/ecosystem-phase0a.md`.

**Interfaces:**
- Produces: the extension-domain SDK names (table above), used by every later task.

- [ ] **Step 1:** In `tools/checks/test/plugin-permissions.test.ts`, change the fixtures to `defineExtension` / `ctx.extensionPoints` and run `pnpm exec vitest run tools/checks/test/plugin-permissions.test.ts`. Expected: FAIL (the analyser still looks for the old names).
- [ ] **Step 2:** Rename in the SDK (types, functions, constants, files, doc comments), update `index.ts`, then every consumer. Mechanical; use the compiler (`pnpm typecheck`) to find what's left.
- [ ] **Step 3:** Update `plugin-permissions.ts` to the new names. Run the Step 1 test. Expected: PASS.
- [ ] **Step 4:** `pnpm gen:sdk-api`; confirm the report has no `Plugin`/`Capabilit` names except those Global Constraints leaves for 0b: `grep -nE "Plugin|Capabilit" packages/plugin-sdk/api/plugin-sdk.api.md` lists only 0b names.
- [ ] **Step 5:** Changeset (patch, the four packages, body "Rename to extension terms before the first release").
- [ ] **Step 6:** `pnpm lint && pnpm typecheck && pnpm check && pnpm exec vitest run packages/plugin-sdk tools/checks plugins` ; commit `refactor(sdk)!: rename plugin and capability to extension and extension point`.

### Task 2: Kernel extension domain (module, tables, errors, audit)

**Files:**
- Move: `packages/kernel/src/plugins/` → `src/extensions/`, `test/plugins/` → `test/extensions/`; rename `Plugin*` classes, types, files inside per the table; update imports repo-wide (`packages/testing`, `apps/capybara` included).
- Create: `packages/kernel/src/migrations/0041_rename_plugins_to_extensions.sql`.
- Modify: `packages/kernel/src/db/kernel-schema.ts` (table types and `Database` keys), every query on those tables.
- Modify: `packages/kernel/src/errors.ts` (`plugin.*` → `extension.*`), throw sites, test assertions, `apps/web/messages/{en,zh}.json` `errors.plugin` → `errors.extension`.
- Modify: audit action strings `plugin.*` → `extension.*` (sites: `extensions/deployment-config.ts`, `installs.ts`, `approvals.ts`, `admin-ops.ts`, `ctx/create-ctx.ts`, `catalog`'s `permissions_restored`).
- Test: `packages/kernel/test/db/rename-extensions-migration.test.ts` (copy the shape of `rename-connectors-migration.test.ts`).

**Interfaces:**
- Consumes: Task 1 SDK names.
- Produces: `extension_*` tables; error prefix `extension.`; `plugin.` error and audit prefixes are free for Task 4.

- [ ] **Step 1: Write the failing migration test** `rename-extensions-migration.test.ts`: on a database migrated to 0040 with one row in each of the nine tables (a package + blob + install + name owner + replica status + snapshot + org config + deployment config + directory source, FK-consistent), running all migrations leaves: the nine `extension_*` tables with the same rows; no `plugin_installs` / `plugin_packages` / … table; `extension_packages.source` CHECK accepts `'catalog'` and rejects `'directory'`; a second migrator run is a no-op.
- [ ] **Step 2:** Run it. Expected: FAIL (`extension_installs` does not exist).
- [ ] **Step 3:** Write `0041` (renames; CHECK constraints on `source` dropped and re-added with `'catalog'` and existing `'directory'` rows updated to `'catalog'`, inside the guarded style), update `kernel-schema.ts`, queries, module move, classes, error codes, audit strings, web error copy keys.
- [ ] **Step 4:** Run `pnpm exec vitest run packages/kernel/test/db packages/kernel/test/extensions packages/kernel/test/evals/reconstruct.test.ts packages/kernel/test/tools/rename-compat.test.ts`. Expected: PASS; reconstruct and rename-compat unchanged (Review Focus 1).
- [ ] **Step 5:** `git grep -nE "plugin_(installs|packages|blobs|name_owners|replica_status|permission_snapshots|org_configs|deployment_configs|directory_sources)" -- packages apps tools ':!packages/kernel/src/migrations/00[0-3]*' ':!packages/kernel/src/migrations/0040*'` is empty except `0041` itself. Full kernel suite: `pnpm exec vitest run packages/kernel`. Commit `refactor(kernel)!: rename the plugin domain to extensions`.

### Task 3: Catalog and marketplace domain

**Files:**
- Move: `packages/kernel/src/directory/` → `src/catalog/` (marketplace files → `marketplaces.*`), `test/directory/` → `test/catalog/`; class renames per table; `packages/testing/src/fake-catalog.ts` → `fake-marketplace.ts` (`startFakeCatalog` → `startFakeMarketplace`).
- Create: `packages/kernel/src/migrations/0042_rename_directory_to_catalog.sql` (marketplaces first, then catalog, then columns, then the `'catalog'` → `'marketplace'` CHECK value).
- Modify: `kernel-schema.ts`, queries, `errors.ts` (`catalog.*` → `marketplace.*` first, then `directory.*` → `catalog.*`), audit strings, web `errors.catalog` / `errors.directory` keys, SDK `DIRECTORY_ITEM_NAME_RE` → `CATALOG_ITEM_NAME_RE` (+ `pnpm gen:sdk-api`).
- Test: `packages/kernel/test/db/rename-catalog-migration.test.ts`.

**Interfaces:**
- Consumes: Task 2 (`extension_catalog_sources` references `catalog_items`).
- Produces: `catalog_items` / `catalog_item_versions` / `catalog_requests` / `catalog_org_grants`, `marketplaces` / `marketplace_entries`, columns `catalog_item_id` / `catalog_version` / `marketplace_id`; error prefixes `catalog.` and `marketplace.`.

- [ ] **Step 1: Failing migration test**: at 0041 with a marketplace + entry, a catalog item + version (sourced from the marketplace, `source = 'catalog'`), a request, an org grant, and a connector + skill + skill version + extension install pointing at the item: after migrating, rows survive under the new table and column names; FKs hold (deleting the item is still blocked/cascades exactly as before); `catalog_item_versions.source` is `'marketplace'`; `directory_exclusions` still exists untouched; second run no-op.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement (migration, schema, module move, classes, codes in the stated order, audit, web error keys, SDK regex, api report).
- [ ] **Step 4:** `pnpm exec vitest run packages/kernel/test/db packages/kernel/test/catalog packages/testing`. Expected: PASS.
- [ ] **Step 5:** Grep guard: `git grep -nwE "directory_items|directory_item_versions|directory_requests|directory_org_grants|catalog_sources|catalog_entries|directory_item_id|directory_version|catalog_source_id" -- packages apps tools ':!packages/kernel/src/migrations/00[0-3]*' ':!packages/kernel/src/migrations/004[01]*'` empty except `0042`. Full kernel suite; commit `refactor(kernel)!: rename the directory to catalog and catalog sources to marketplaces`.

### Task 4: Bundle domain (app → plugin)

**Files:**
- Rename: `src/catalog/app-import.ts` → `plugin-import.ts`, `app-install.ts` → `plugin-install.ts`, classes and types per table; tests `app-import.test.ts` / `app-install.test.ts` → `plugin-*.test.ts`.
- Create: `packages/kernel/src/migrations/0043_rename_app_installs_to_plugin_installs.sql`.
- Modify: `kernel-schema.ts`, queries, `errors.ts` (`app.*` → `plugin.*`), audit (`plugin.org_installed` / `plugin.org_install_failed` / `plugin.org_uninstalled`), web `errors.app` → `errors.plugin` keys.
- Test: `packages/kernel/test/db/rename-plugin-installs-migration.test.ts`.

**Interfaces:**
- Consumes: Task 2 (freed `plugin_installs`, `plugin.` prefix), Task 3 (`catalog_items`).
- Produces: `plugin_installs` (bundle meaning), `plugin_install_components`, `plugin_import_staging`; error prefix `plugin.` meaning bundle.

- [ ] **Step 1: Failing migration test**: at 0042 with an app install (`app_installs`) with three components (`kind` `plugin` / `connector` / `skill`) and a staging row: after migrating, `plugin_installs` holds that install (and is NOT the extension table: `extension_installs` still has its own rows), components have kinds `extension` / `connector` / `skill`, staging survives; second run no-op.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `pnpm exec vitest run packages/kernel/test/db packages/kernel/test/catalog`. Expected: PASS.
- [ ] **Step 5:** `git grep -nwE "app_installs|app_install_components|app_import_staging|AppInstaller|AppImport" -- packages apps tools ':!packages/kernel/src/migrations/00[0-3]*' ':!packages/kernel/src/migrations/004[0-2]*'` empty except `0043`. Commit `refactor(kernel)!: rename app installs to plugin installs`.

### Task 5: HTTP routes

**Files:**
- Modify: controllers `src/extensions/…admin controller`, `src/catalog/admin-catalog.controller.ts`, `org-catalog.controller.ts` (both controllers), `marketplaces.controller.ts`, `src/extensions/org-config.controller.ts`, `src/orgs/directory-sync.controller.ts`; `src/http/app.ts` upload constants; `src/http/api.module.ts`; `src/config/docs.ts`.
- Modify: `apps/web/src/app/api/[...path]/route.ts` (the three upload paths and comment), `apps/web/src/lib/{admin-plugins,directory,plugins}.ts` (rename files to `admin-extensions.ts`, `catalog.ts`, `extensions.ts`).
- Modify: kernel tests (≈30 files with org-config setup URLs, 12 / 7 / 3 / 6 / 2 / 8 files for the other routes), web tests (`admin-plugins.test.tsx` → `admin-extensions.test.tsx`, `directory.test.tsx` → `catalog.test.tsx`, `proxy.test.ts`, `pages.test.tsx`, `plugins-identities.test.tsx`), e2e (`admin-plugins.spec.ts`, `directory.spec.ts`, `global-setup.ts`).

**Interfaces:**
- Produces: the HTTP table above; the web client modules `lib/admin-extensions.ts`, `lib/catalog.ts`, `lib/extensions.ts`.

- [ ] **Step 1:** In `packages/kernel/test/http` (or the existing route-inventory test), add `old routes are gone`: requesting `GET /api/v1/admin/plugins`, `/api/v1/admin/directory/items`, `/api/v1/admin/catalogs`, `/api/v1/orgs/:id/directory`, `/api/v1/orgs/:id/app-installs` as an enterprise admin returns 404; `GET /api/v1/admin/extensions` returns 200. Run; expected FAIL.
- [ ] **Step 2:** Rename controller paths, constants, web clients, proxy, tests.
- [ ] **Step 3:** `pnpm exec vitest run packages/kernel apps/web/test` and `pnpm exec vitest run packages/kernel/test/evals/reconstruct.test.ts`. Expected: PASS (Review Focus 1).
- [ ] **Step 4:** Commit `refactor!: rename the extension, catalog and plugin HTTP routes`.

### Task 6: Config keys

**Files:**
- Modify: `packages/kernel/src/config/schema.ts` (keys per table; descriptions mention extensions / catalog / marketplaces), `config/env.ts` (the kebab-case special case keys on `extensionConfig`), every reader, test helpers (`packages/testing/src/{dual-replica,replica-runner}.ts`, `packages/kernel/test/helpers/*`, `test/catalog/org-env.ts`, `apps/web/e2e/global-setup.ts`, `apps/capybara/test/*`).
- Regenerate: `docs/config.md` (`pnpm gen:config-docs`; the `CAPYBARA_WEB_MAX_PACKAGE_BYTES` route list follows Task 5).
- Modify: `docker/compose.yaml` (`CAPYBARA_EXTENSION_CONFIG__OBJECT_STORE_S3__*`, comment about `extensionHost.drainSeconds`), `docker/kernel.Dockerfile` (`CAPYBARA_EXTENSION_HOST__DIR`, value unchanged), `docker/web.Dockerfile` comment if it lists routes.
- Test: `packages/kernel/test/config/env.test.ts` (or the existing env test).

- [ ] **Step 1: Failing test** `extension config env keeps the kebab-case extension name`: env `CAPYBARA_EXTENSION_CONFIG__OBJECT_STORE_S3__BUCKET=b` → `config.extensionConfig["object-store-s3"].bucket === "b"`; env `CAPYBARA_PLUGIN_CONFIG__OBJECT_STORE_S3__BUCKET=b` → rejected as an unknown key (same behaviour as any unknown key today); `CAPYBARA_MARKETPLACES__OFFICIAL__ENABLED=false` → `config.marketplaces.official.enabled === false`; `CAPYBARA_CATALOG__STALE_INSTALL_MINUTES=5` → `config.catalog.staleInstallMinutes === 5`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Rename keys, special case, readers, helpers, docker; `pnpm gen:config-docs`.
- [ ] **Step 4:** `pnpm exec vitest run packages/kernel/test/config tools/checks/test/config-docs.test.ts` and `pnpm check`. Expected: PASS.
- [ ] **Step 5:** Commit `refactor(config)!: rename plugin and catalog config keys`.

### Task 7: CLI

**Files:**
- Modify: `apps/capybara/src/args.ts` (command union `extensions-review` / `extensions-approve` / `extensions-list` / `extensions-install` / `extensions-state`, help text, usage errors), `src/cli.ts`, `src/commands/plugins.ts` → `extensions.ts`, `packages/kernel/src/extensions/cli.ts` (`openPluginCli` → `openExtensionCli`), `src/commands/builtin-plugins.ts` (names only).
- Modify: `apps/capybara/test/{plugins,args}.test.ts` (→ `extensions.test.ts`), `docker/test/compose-smoke.sh`, `docker/test/kernel-image.sh`, `docker/compose.yaml` comments.

- [ ] **Step 1: Failing test** in `args.test.ts`: `parseArgs(["extensions", "approve", "slack", "--yes"])` returns `{ cmd: "extensions-approve", name: "slack", yes: true }`; `parseArgs(["plugins", "list"])` throws the unknown-command usage error; `--help` output contains `capybara extensions install` and not `capybara plugins`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement; update the two docker scripts.
- [ ] **Step 4:** `pnpm exec vitest run apps/capybara`; `bash -n docker/test/compose-smoke.sh docker/test/kernel-image.sh`. Expected: PASS.
- [ ] **Step 5:** Commit `refactor(cli)!: rename capybara plugins to capybara extensions`.

### Task 8: Web pages, navigation and copy

**Files:**
- Move: pages per the web table under `apps/web/src/app/[locale]/(app)/`; nav (`components/admin-nav.ts`, `settings-nav.ts`, `shell/nav.tsx`); components `AdminPluginParts.tsx` → `AdminExtensionParts.tsx`, `PluginDeploymentConfig.tsx` → `ExtensionDeploymentConfig.tsx`, `Directory*.tsx` → `Catalog*.tsx`; links from `admin/page.tsx`, `channels/new`, `connectors/install`, `inbox`.
- Modify: `apps/web/messages/{en,zh}.json` — namespaces `plugins.*` → `extensions.*`, `directory.*` → `catalog.*`, `admin.plugins` → `admin.extensions`, `nav.directory` → `nav.catalog`, copy values per spec §1 (en: extension, extension point, plugin, catalog, marketplace, embed; zh: 扩展, 扩展点, 插件, 企业目录, 市场, 嵌入页面), the 7 conversation-meaning 会话 → 对话 (`chat.inspectorTitle`, `chatPanel.conversation`, `approval.scope.session`, `approval.scopeHint.session`, `inbox.conversation`, `inbox.openConversation`, `trajectories.detail.tool.scopes.session`; the 5 login-session ones stay); CLI hints in copy follow Task 7.
- Modify: web tests and e2e for paths and copy; visual baselines only if a rendered string changes in a visual test (none expected: the only visual spec is the `/dev/ui` catalog).
- Create: `tools/checks/test/error-copy.test.ts` (in `tools/checks`, which already has `@capybara-hq/kernel` as a devDependency; `apps/web` may depend only on `@capybara-hq/design`, so the test must not live there).

- [ ] **Step 1: Failing test** `error-copy.test.ts` → `every kernel error code has en and zh copy`: import `ERROR_CODES` from the kernel (as `tools/checks` imports the config schema) and read `apps/web/messages/{en,zh}.json`; assert, for each code `p.c`, `messages.en.errors[p][c]` and `messages.zh.errors[p][c]` are non-empty strings. Run; expected FAIL if any Task 2–4 key was missed, else PASS — then temporarily delete one key to see it fail, and restore (proven red). `tools/checks` tests join every CI run, so this needs no `test-plugins.json` or `EXTRA_INPUTS` entry beyond what `tools/checks` already reads (check `EXTRA_INPUTS` in `tools/ci/src/affected.ts` maps `apps/web/messages/**` → `tools/checks`; add it if missing).
- [ ] **Step 2:** Move pages, nav, components; rename namespaces and values; 会话 → 对话 for the 7 keys.
- [ ] **Step 3:** `pnpm exec vitest run apps/web/test` and `pnpm check` (i18n parity, web-ui). Expected: PASS.
- [ ] **Step 4:** Commit `refactor(web)!: move pages and copy to extension, catalog and plugin terms`.

### Task 9: Docs and skills

**Files:**
- Modify: `AGENTS.md` (repo map, rules at a glance, CI and checks, dependency notes), `README.md`, `CONTRIBUTING.md`, `packages/plugin-sdk/README.md`, `packages/testing/README.md`, `docs/superpowers/specs/2026-10-17-capybara-architecture-design.md`, `docs/superpowers/specs/2026-10-18-extension-model-design.md` (rewrite "keep the name plugin, not extension" as superseded by the ecosystem spec), `docs/deploy/{README,release,upgrade}.md`, `docs/releases/0.1.0.md`.
- Move: `.agents/skills/writing-plugins` → `writing-extensions`, `writing-plugin-ui` → `writing-extension-ui` (frontmatter `name` follows; `check:skills-frontmatter`); update every skill body and cross-link (`writing-tools`, `writing-channels`, `writing-model-providers`, `writing-connectors`, `writing-sandbox-providers`, `writing-object-store-providers`, `writing-kernel-api`, `adding-config`, `writing-migrations`, `writing-web-ui`, `replay-evals`, `writing-apps` links only), code comments that cite skill paths (`packages/kernel/src/http/plugin-dispatch.ts:82`, `tools/ci/test/affected.test.ts:110`).
- Do not touch the three synced skills or plans dated before 2026-10-24.

- [ ] **Step 1:** Update docs and skills; `git mv` the two skill folders.
- [ ] **Step 2:** `pnpm check` (skills frontmatter, synced skills, config docs) and `pnpm exec vitest run tools/ci tools/checks`. Expected: PASS.
- [ ] **Step 3:** `git grep -nE "writing-plugins|writing-plugin-ui" -- ':!docs/superpowers/plans/2026-10-1*' ':!docs/superpowers/plans/2026-10-2[0-3]*'` is empty. Commit `docs: move docs and skills to extension, catalog and plugin terms`.

### Task 10: Terminology guard check

**Files:**
- Create: `tools/checks/src/terms.ts`, `tools/checks/src/cli/terms.ts`, `tools/checks/test/terms.test.ts`, fixtures `tools/checks/fixtures/terms/{clean,violations}/`.
- Modify: `tools/checks/src/cli/all.ts` (register "Terms"), root `package.json` (`check:terms`), `AGENTS.md` "CI and checks" (one bullet: full on PRs, cheap, reads a handful of files), `.github/workflows/ci.yml` comment.

**Interfaces:**
- Produces: `checkTerms(root: string): Finding[]` (Finding from `tools/checks/src/source.ts`), rule ids `terms-sdk-api`, `terms-error-code`, `terms-config-key`, `terms-route`, `terms-cli`.

What it checks (designer's call; the spec's phase-0 acceptance list):
- `packages/plugin-sdk/api/plugin-sdk.api.md` declares no identifier matching `/\b(Plugin|Capabilit)\w*/` or `/\bdefinePlugin\b/` outside an allowlist containing exactly the names plan 0b removes (Global Constraints) — plan 0b empties the allowlist;
- `ERROR_CODES` has no key starting `directory.` or `app.`;
- the config schema's top-level keys contain none of `plugins`, `pluginConfig`, `pluginHost`, `pluginPermissions`, `catalogs`, `directory`;
- no `@Controller(...)` path in `packages/kernel/src` starts with `api/v1/admin/plugins`, `api/v1/admin/directory`, `api/v1/admin/catalogs`, or contains `/app-installs` or `orgs/:orgId/directory`;
- `apps/capybara/src/args.ts` help text has no `capybara plugins`.

- [ ] **Step 1: Failing test** `terms.test.ts`: `clean` fixture → `[]`; `violations` fixture (an api.md with `definePlugin`, an errors file with `directory.item_not_found`, a schema with `pluginHost`, a controller `@Controller("api/v1/admin/catalogs")`, a help text with `capybara plugins list`) → exactly the five rule ids, one each, with file and line.
- [ ] **Step 2:** Run; expected FAIL (module missing). Implement; run; expected PASS. Run `pnpm check:terms` on the repo; expected PASS (proves Tasks 1–7 left nothing).
- [ ] **Step 3:** Commit `feat(checks): guard the extension, catalog and plugin terms`.

### Task 11: Phase-0a acceptance

- [ ] **Step 1: Database from M7 main.** On a scratch database migrated by `main` at `dc17f5d` with seed data (use `packages/kernel/test/db` helpers or run the M7 acceptance seed), run this branch's `capybara migrate`; record that every renamed table has its rows and `pnpm exec vitest run packages/kernel` passes against it. (Automated parts are Tasks 2–4; this is the end-to-end confirmation.)
- [ ] **Step 2: Replay.** `pnpm exec vitest run packages/kernel/test/evals packages/kernel/test/tools/rename-compat.test.ts`. Expected: PASS with no fixture changes.
- [ ] **Step 3: Whole suite and checks.** `pnpm verify` (runs everything: the diff touches root config). Expected: all steps pass.
- [ ] **Step 4: Compose smoke (local).** `bash docker/test/compose-smoke.sh` if Docker is available (it uses `capybara extensions`); otherwise note it for CI's `docker` job.
- [ ] **Step 5: Hand-off note.** Append to the ledger: the release-workflow dry run (`workflow_dispatch` with `dry_run: true`) is a maintainer step after merge; plan 0b starts from this branch's `main`.
