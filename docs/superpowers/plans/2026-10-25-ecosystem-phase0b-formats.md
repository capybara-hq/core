# Package Ecosystem Phase 0b: Package Formats Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the M6 / M7 package formats with the plugin manifest (`.capybara-plugin/plugin.json`) and the marketplace manifest (`marketplace.json`), so the catalog holds one kind of item (the plugin), import is one reviewed flow, and org install is plugin install, with no readers for the old formats.

**Architecture:** The SDK gains the two manifest parsers first (additive), then each consumer moves over in dependency order: the packer, the kernel's package reader and extension store, the catalog import, marketplaces, org install, HTTP + web, CLI + docs. The last task deletes the old SDK formats, regenerates the schemas and the API snapshot, and turns `check:terms` against the removed formats. Catalog content imported in an old format cannot be converted in SQL (`app.yaml` lives only in object storage), so the migration removes it; deployment extension installs are kept.

**Tech Stack:** TypeScript, pnpm monorepo, NestJS + Fastify kernel, Kysely + PG migrations, zod 4 (`z.toJSONSchema`), Next web app, vitest, Playwright, api-extractor, esbuild (`tools/pack-plugin`).

**Spec:** `docs/superpowers/specs/2026-10-22-package-ecosystem-design.md` §3, §4.1–§4.3, §5.2, §5.3 (version order only), §10 (install and uninstall only; in-place upgrade is phase A), §12 phase 0, §13. Plan 0a (`2026-10-24-ecosystem-phase0a-terminology.md`, merged in #25) did the renames.

## Global Constraints

- **No readers for old formats, no aliases** (spec §4.2, decided 2026-10-24). A tgz with a `capybara` section in `package.json`, or with `app.yaml`, and no `.capybara-plugin/plugin.json` is rejected with the code `catalog.legacy_format` / `extension.legacy_format` and the message `uses the pre-0.1.0 package format (capybara section / app.yaml); repack it as a plugin with .capybara-plugin/plugin.json (pnpm pack-plugin)`.
- **Frozen**, as in plan 0a: event payload fields and model-visible text; PG schemas `plugin_<name>`, storage prefixes `plugins/<plugin>/<orgId>/` and `kernel/<orgId>/`, the catalog object prefix `directory/<item>/<version>/<importId>/` (stored value), kv / queue / Redis prefixes and job ids (`catalogs-refresh`, `app-staging-cleanup`), `/plugin-ui`, `/plugins/<name>/…`, `/p/[plugin]/[id]`, `directory@1`, migrations `0001`–`0043`.
- **Out of scope (phase A or later)**: git marketplaces and the `path` / `git` sources (parsed and stored in 0b, import refused with `marketplace.source_unsupported` naming phase A), content digest and "content changed at the same version", org in-place upgrade, `bootstrap.json`, the repo split, the published `@capybara-hq/plugin-tools`, provenance display, pinned skills at runtime (§9.1: `pinned` is accepted and stored, with no runtime effect yet), `agents` (rejected when non-empty).
- **The SDK keeps `yaml`**: `parseSkillMd` reads SKILL.md frontmatter, which is YAML by the Agent Skills format. Only `app.yaml` goes. (Spec §4.2 assumed `yaml` was used only by `app.yaml`; Task 9 corrects the spec.)
- Migrations follow `.agents/skills/writing-migrations/SKILL.md`: idempotent, every destructive statement preceded by `-- capybara:allow-destructive <reason>`. Pre-release, one release, no dual-write (spec §13), so columns are dropped directly. `check:applied-migrations` forbids editing `0001`–`0043`.
- New SDK names may contain `Plugin` (it now means the bundle). `check:terms`' SDK rule changes from "no `Plugin` except an allowlist of old names" to "no old extension-meaning names" in Task 1 (see Task 1 Step 6).
- One changeset for the branch (Task 1): patch for `@capybara-hq/plugin-sdk`, `@capybara-hq/kernel`, `@capybara-hq/testing`, `@capybara-hq/capybara`. Changesets are cleared once, before the first release (after the split).
- English for new comments; translate the comments and test titles you edit. Conventional Commits, body lines ≤ 100, `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Run single tests from the repo root (`pnpm exec vitest run <path>`). Before each commit: `pnpm lint && pnpm typecheck`, and `pnpm check` where the task touches checked areas.

## Formats (the decisions every task uses)

### Plugin tgz layout

```
package/package.json                     npm metadata; version equals plugin.json version
package/.capybara-plugin/plugin.json     always present in a tgz (the packer writes it)
package/skills/<name>/SKILL.md …         skills
package/connectors/<id>.json             connector templates
package/dist/index.mjs                   extension entry (only with an extension)
package/migrations/*.sql                 extension migrations (optional)
package/ui/**                            extension UI files (optional)
package/README.md, LICENSE, NOTICE, THIRD-PARTY-NOTICES.txt
```

- `package.json` rules for every plugin tgz (from today's `validatePluginPackageJson`): npm name (`NPM_PACKAGE_NAME_RE`), semver version equal to `plugin.json` `version`, no install scripts, no `gypfile`, no dependency fields; `peerDependencies` only host packages (`@capybara-hq/plugin-sdk`, `zod`), and for a plugin with an extension `peerDependencies["@capybara-hq/plugin-sdk"]` equals `extension.manifest.sdk`. A declarative plugin has no `peerDependencies`.
- The plugin name (`plugin.json` `name`) is independent of the npm name; the npm name is recorded as `package_name` as today.

### `plugin.json` v1 (SDK `packages/plugin-sdk/src/plugin-manifest.ts`)

```ts
export const PLUGIN_MANIFEST_FILE = ".capybara-plugin/plugin.json";
export const PLUGIN_MANIFEST_SCHEMA_VERSION = 1;
export const PLUGIN_MANIFEST_LIMITS = { manifestChars: 256 * 1024, dependencies: 20, skills: 50,
  connectorTemplates: 20, descriptionChars: 1024, publisherChars: 100, displayNameChars: 100, pathChars: 512 };

export interface PluginDependency { name: string; version: string }        // CATALOG_ITEM_NAME_RE; semver range
export interface PluginSkillRef { path: string; pinned?: boolean }         // safe "./…" dir holding SKILL.md
export interface PluginConnectorTemplateRef { path: string }               // safe "./…/<id>.json"
export interface PluginExtensionSection {
  entry: string;                         // "./dist/index.mjs"
  manifest: StaticExtensionManifest;     // written by the packer
  migrations?: string;                   // "./migrations"
  ui?: string;                           // "./ui"
}
export interface PluginManifest {
  $schema?: string;
  schemaVersion: 1;
  name: string;                          // CATALOG_ITEM_NAME_RE; with an extension also EXTENSION_NAME_RE and === extension.manifest.name
  version: string;                       // exact semver (SEMVER_VERSION_RE)
  publisher: string;
  description: string;
  displayName?: LocalizedName;
  icon?: string;                         // safe "./…" .svg / .png
  license?: string;
  homepage?: string;                     // https
  dependencies?: PluginDependency[];     // no self-dependency, no duplicates
  skills?: PluginSkillRef[];             // omitted = scan skills/*/SKILL.md
  connectorTemplates?: PluginConnectorTemplateRef[]; // omitted = scan connectors/*.json
  agents?: [];                           // reserved: non-empty is rejected ("agents are not supported yet")
  extension?: PluginExtensionSection;
}
export const PluginManifestSchema: z.ZodType<PluginManifest>;   // strict objects (unknown keys rejected, `$schema` allowed)
export function parsePluginManifest(json: unknown): PluginManifest | { errors: string[] };  // ≤ 50 "path: msg" errors, never throws
```

- Paths start with `./`, pass `isSafePackagePath` after stripping `./`, and don't nest (no skill dir inside another). Extension `version` must equal the plugin `version`; extension `sdk` must be a range with an upper bound.
- A plugin with neither an extension, skills nor connector templates (after scanning) is rejected: `a plugin must contain an extension, a skill or a connector template`.

### Connector template file (`connectors/<id>.json`)

```ts
export interface ConnectorTemplateFile {      // strict
  displayName: LocalizedName;
  description?: string;
  icon?: string;                              // safe path relative to the plugin root
  template: ConnectorTemplateSpec;            // unchanged C30 shape, validated by validateConnectorTemplate
}
export function parseConnectorTemplateFile(json: unknown): ConnectorTemplateFile | { errors: string[] };
```

The template id is the file's base name (`CATALOG_ITEM_NAME_RE`), as `AppConnectorTemplate.id` was.

### `marketplace.json` v1 (SDK `packages/plugin-sdk/src/marketplace.ts`)

```ts
export const MARKETPLACE_MANIFEST_SCHEMA_VERSION = 1;
export const MARKETPLACE_LIMITS = { nameChars: 100, summaryChars: 280, plugins: 5000, permissionKeys: 500, urlChars: 2000 };
export type MarketplaceSource =
  | { path: string }
  | { git: { url: string; ref?: string; commit?: string; path?: string } }   // commit: 40 hex
  | { npm: { package: string; version: string; integrity: string } }        // exact version, SHA512_INTEGRITY_RE
  | { archive: { url: string; integrity: string } };                        // sha512- or sha256- SRI
export interface MarketplaceEntry {
  name: string;                               // CATALOG_ITEM_NAME_RE
  summary: { en: string; zh?: string };
  version?: string;                           // exact semver
  minKernel?: string;                         // exact semver
  permissions?: { keys: string[]; sensitive: string[] };  // display only
  homepage?: string;
  source: MarketplaceSource;
}
export interface MarketplaceManifest {
  $schema?: string;
  schemaVersion: 1;
  name: string;
  owner?: { name: string; url?: string };
  description?: string;
  plugins: MarketplaceEntry[];
}
export const MarketplaceManifestSchema: z.ZodType<MarketplaceManifest>;   // non-strict: unknown fields dropped
export function parseMarketplaceManifest(json: unknown, opts?: { allowInsecureLoopback?: boolean }): MarketplaceManifest | { errors: string[] };
export function marketplaceEntryVersion(e: MarketplaceEntry): string | null;  // e.version ?? npm.version ?? null
```

- `(name, marketplaceEntryVersion)` is unique in a manifest (one entry is one version, spec §5.2). URLs are https (loopback allowed with `allowInsecureLoopback`).

### Database (migrations 0044–0045)

| Migration (task) | Change |
|---|---|
| `0044_catalog_one_kind.sql` (Task 4) | Remove M6 / M7-format catalog content (below); `catalog_items`: drop `kind` and the `(kind, name)` live index, add a live unique index on `name`; `catalog_item_versions`: add `manifest jsonb NOT NULL`, drop `section` and `resolved`, rename `plugin_sha256` → `extension_sha256`; `marketplace_entries`: drop `kind`, add `version text NULL`, PK `(source_id, name, version)` with `version` coalesced (store `''` for "no version") ; `plugin_import_staging`: drop `bundle`, add `manifest jsonb NOT NULL` |
| `0045_plugin_dependencies.sql` (Task 5) | `plugin_install_components.kind` CHECK adds `'plugin'` (a dependency install; `ref` = the dependency's install id) |

**Old catalog content (0044, designer's call):** every `catalog_items` row predates 0b, so it is in an old format. 0044 deletes, in FK order: `plugin_install_components`, `plugin_installs`, `catalog_requests`, `catalog_org_grants`, `extension_catalog_sources`, `plugin_import_staging`, `catalog_item_versions`, `catalog_items`, `marketplace_entries` (refetched at the next refresh); it sets `catalog_item_id` / `catalog_version` to NULL on `connectors`, `skills`, `skill_versions`, `extension_installs`. Org skills and connectors stay; deployment extension installs stay. Objects under `deployment/directory/` are left in object storage, unreachable (designer's call: no cleanup code for development leftovers). Only development databases have such rows (nothing is released).

**Old extension packages:** stored extension blobs are old-format tgz. After 0b, reading one returns `extension.legacy_format`; the extension shows as failed in the admin console with that message until it is reinstalled from a repacked tgz. Built-in extensions (`openai-compatible`, `object-store-s3`) load from module paths and are unaffected. No converter (no readers for old formats).

### HTTP (designer's call: the catalog routes are the plugin routes; no separate `/admin/plugins`)

| Route | 0b |
|---|---|
| `POST /api/v1/admin/catalog/import/file`, `…/import/npm` | prepare a plugin import: returns `{ stagingId, review }` (200). Replaces both the old one-step import and `plugins/prepare/*` |
| `POST /api/v1/admin/catalog/imports/:stagingId/confirm` | body `{ reviewHash, deployExtension: boolean }`; replaces `plugins/:stagingId/confirm` |
| `POST /api/v1/admin/marketplaces/:id/entries/:name/import` | body `{ version? }` (default: newest compatible); returns `{ stagingId, review }`; `:kind` path segment removed |
| `GET …/admin/catalog/items`, `GET …/orgs/:orgId/catalog`, `GET …/admin/marketplaces/entries` | `kind` query parameter removed |
| `POST /api/v1/admin/catalog/items/:id/install-deployment` | installs the item's extension (refused for a plugin without one: `catalog.no_extension`) |
| `POST /api/v1/orgs/:orgId/catalog/:itemId/install` | body `{ version?, connectors?: Record<templateId, …>, extensionConfig?: … }`: always a plugin install; returns the install view |
| `GET / DELETE /api/v1/orgs/:orgId/plugin-installs…` | unchanged paths; views gain dependency components |

Removed: `POST …/admin/catalog/plugins/prepare/file`, `…/plugins/prepare/npm`, `…/plugins/:stagingId/confirm`, the one-step import responses, every `kind` parameter. No aliases.

### Error codes (new; others keep their codes)

`catalog.legacy_format` (422), `extension.legacy_format` (422), `catalog.invalid_manifest` (422, replaces `plugin.invalid_manifest`), `catalog.no_extension` (409), `catalog.dependency_unresolved` (409, names the dependency and range), `catalog.dependency_disabled` (409, names the dependency), `catalog.dependency_cycle` (409), `marketplace.source_unsupported` (422, "git and path sources arrive with git marketplaces (phase A)"). Removed: `catalog.wrong_kind`, `plugin.lock_mismatch`, `plugin.extension_conflict` (if no longer reachable; the reviewer checks). Each new code gets zh and en copy (the error-copy test enforces it).

## Review Focus

1. **A tgz in an old format** (from an M7 dev box, a stale CI artifact, a third party following old docs): every entry point (admin upload, npm import, marketplace import, `capybara extensions install`, the store re-reading an installed blob) gives the legacy-format message, never a stack trace or a generic 422. Task 3 and Task 4 each pin one entry point; Task 8 pins the CLI.
2. **`plugin.json` that lies about its content**: `skills` / `connectorTemplates` listing paths that don't exist, `extension.entry` missing from the tgz, extension name ≠ plugin name, version ≠ `package.json` version, a scanned `connectors/x.json` that is invalid. The import must refuse with the path in the message, before anything is stored. Task 3 tests these.
3. **Dependencies at org install**: a range nothing in the catalog satisfies, a disabled dependency, a cycle (`a` → `b` → `a`), a dependency already installed in the org (kept as `pre_existing`, not reinstalled, not removed on uninstall), and uninstalling a dependency another install still uses. Task 5 tests each.
4. **Marketplace entries the kernel can't import yet** (`path`, `git`): listed with "needs phase A" and not importable; importing returns `marketplace.source_unsupported`. A manifest mixing them with npm entries still refreshes. Task 4 tests this.
5. **A development database from 0a `main`** migrates through 0044–0045, keeps org skills, connectors and deployment extension installs, and the admin console shows old extension packages as "repack needed" rather than crashing. Task 9 confirms end to end.

---

### Task 1: SDK plugin and marketplace manifests (additive)

**Files:**
- Create: `packages/plugin-sdk/src/plugin-manifest.ts`, `packages/plugin-sdk/src/marketplace.ts`, `packages/plugin-sdk/test/plugin-manifest.test.ts`, `packages/plugin-sdk/test/marketplace.test.ts`, `.changeset/ecosystem-phase0b.md`
- Modify: `packages/plugin-sdk/src/plugin-package.ts` (add `validatePluginPackageJsonFor`), `packages/plugin-sdk/src/index.ts`, `packages/plugin-sdk/api/plugin-sdk.api.md`, `tools/checks/src/package-schemas.ts` (register `plugin.v1` / `marketplace.v1` / `connector-template.v1` next to the old two), `packages/plugin-sdk/schemas/*`, `tools/checks/src/terms.ts`, `tools/checks/test/terms.test.ts`

**Interfaces:**
- Produces: everything in "Formats" above (`PLUGIN_MANIFEST_FILE`, `PluginManifest`, `parsePluginManifest`, `PluginExtensionSection`, `ConnectorTemplateFile`, `parseConnectorTemplateFile`, `MarketplaceManifest`, `MarketplaceEntry`, `MarketplaceSource`, `parseMarketplaceManifest`, `marketplaceEntryVersion`, the limits), plus
  `validatePluginPackageJsonFor(pkg: unknown, manifest: PluginManifest, hostSdkVersion: string, opts?: { hostZodVersion?: string }): string[]` — the package.json rules of "Plugin tgz layout" (no `capybara` section allowed: `"package.json must not have a capybara section (the manifest is .capybara-plugin/plugin.json)"`).
- The old exports stay until Task 9.

- [ ] **Step 1: Write the failing tests.** `plugin-manifest.test.ts`: a minimal skills-only manifest parses; an extension-bearing manifest parses; each rule of the Formats section rejects with its path (`name`, `version`, unsafe path `../x`, nested skill paths, duplicate dependency, self-dependency, non-empty `agents`, extension name ≠ plugin name, extension version ≠ plugin version, unknown key, `homepage` http); `$schema` is accepted; errors are capped at 50. `marketplace.test.ts`: the four source forms parse; duplicate `(name, version)` rejected; npm without integrity rejected; unknown fields dropped; `marketplaceEntryVersion` for each form. `parseConnectorTemplateFile`: valid file, credential key in `endpoint` rejected (reuses `validateConnectorTemplate`). `validatePluginPackageJsonFor`: `capybara` section rejected, version mismatch rejected, declarative plugin with `peerDependencies` rejected, extension sdk range ≠ peer range rejected.
- [ ] **Step 2:** Run `pnpm exec vitest run packages/plugin-sdk/test/plugin-manifest.test.ts packages/plugin-sdk/test/marketplace.test.ts`. Expected: FAIL (modules missing).
- [ ] **Step 3:** Implement the two modules with zod (`z.strictObject` for the plugin manifest and template file, `z.object` for the marketplace manifest), reusing `CATALOG_ITEM_NAME_RE`, `EXTENSION_NAME_RE`, `SEMVER_VERSION_RE`, `SHA512_INTEGRITY_RE`, `isSafePackagePath`, `validateConnectorTemplate`, `LocalizedName`. Export from `index.ts`.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5:** Register `plugin.v1.schema.json`, `marketplace.v1.schema.json`, `connector-template.v1.schema.json` in `tools/checks/src/package-schemas.ts` with `$id` `https://capybarahq.com/schemas/<file>` (designer's call: the old `catalog.capybarahq.com` host named the old meaning); `pnpm gen:package-schemas`; update the "schemas registered" test to list five files (the old two go in Task 9).
- [ ] **Step 6: `check:terms` SDK rule.** Replace `SDK_API_ALLOWLIST` + `SDK_TERM` with `SDK_OLD_NAMES`: a list of patterns that must not appear in the API report — `\bdefinePlugin\b`, `\bPluginContext\b`, `\bStaticPluginManifest\b`, `\bPluginPermissions?\b`, `\bPLUGIN_NAME_RE\b`, `\bPluginStorage\b`, `\bPLUGIN_TOOL_NAME\b`, `Capabilit`/`CAPABILIT` (any), and the old-format names that remain until Task 9 listed in a `SDK_OLD_FORMATS_UNTIL_0B_TASK_9` allowlist. Drop the `PluginManifest` pattern from `OLD_REFERENCES` (the name now means the plugin manifest) but keep `StaticPluginManifest` and `PluginManifestError`. Update the clean/violations fixtures: the clean API report contains `PluginManifest`, `parsePluginManifest`; the violations report contains `definePlugin`. Prove red first (fixture line without the rule fails the test).
- [ ] **Step 7:** `pnpm gen:sdk-api`; add `.changeset/ecosystem-phase0b.md` (patch: plugin-sdk, kernel, testing, capybara; "Package formats: plugin.json and marketplace.json"); `pnpm check`, `pnpm lint`, `pnpm typecheck`.
- [ ] **Step 8: Commit** `feat(plugin-sdk): add the plugin and marketplace manifests`.

### Task 2: The packer writes plugins

**Files:**
- Modify: `tools/pack-plugin/src/pack.ts`, `tools/pack-plugin/src/cli.ts`, `tools/pack-plugin/test/pack.test.ts`, `tools/pack-plugin/test/fixtures/*`, `tools/checks/src/plugin-pack.ts` (+ fixtures)
- Create: `plugins/*/.capybara-plugin/plugin.json` for every plugin under `plugins/` (14), `tools/pack-plugin/test/fixtures/declarative/` (skills + `connectors/x.json`, no `src/`)

**Interfaces:**
- Consumes: Task 1 (`PluginManifest`, `parsePluginManifest`, `validatePluginPackageJsonFor`, `PLUGIN_MANIFEST_FILE`).
- Produces: `packPlugin(pluginDir, outDir): Promise<PackResult>` with `PackResult { file; sha256; manifest: PluginManifest; dropped: string[] }` (was `manifest: StaticExtensionManifest`; callers use `result.manifest.extension?.manifest`).

- [ ] **Step 1: Failing tests** in `pack.test.ts`: packing `plugins/todo` yields a tgz whose `package/.capybara-plugin/plugin.json` parses with `parsePluginManifest`, has `extension.manifest` equal to `staticManifestOf` of the module, and whose `package.json` has no `capybara` key; packing the declarative fixture yields `skills/…`, `connectors/x.json`, a manifest without `extension`, no `dist/`, and esbuild is not run (no staging dir); a plugin dir without `.capybara-plugin/plugin.json` fails with `missing .capybara-plugin/plugin.json`; source `plugin.json` with an `extension` key fails (`extension is written by the packer`); reproducibility (same bytes twice) still holds.
- [ ] **Step 2:** Run `pnpm exec vitest run tools/pack-plugin`. Expected: FAIL.
- [ ] **Step 3:** Implement: read and validate the source `.capybara-plugin/plugin.json` (without `extension`); if `src/index.ts` exists, bundle as today and set `extension = { entry: "./dist/index.mjs", manifest, migrations: "./migrations" if present, ui: "./ui" if present }`; ship `skills/**` and `connectors/*.json` when present; write `package.json` without `capybara` (peerDependencies only with an extension); validate the final manifest with `parsePluginManifest` and `validatePluginPackageJsonFor`.
- [ ] **Step 4:** Add `.capybara-plugin/plugin.json` to every `plugins/*` (fields: `schemaVersion: 1`, `name` = the extension name, `version` = package.json version, `publisher: "Capybara"`, `description` = package.json description, `homepage` = package.json homepage). Note: changing `plugins/*` files triggers their tests on CI; that is expected.
- [ ] **Step 5:** Run the pack tests and `pnpm check:plugin-pack` (it packs every official plugin and reads it back with the kernel — this needs Task 3's reader: until then make `checkPluginPack` call the SDK parsers only, and switch it to the kernel reader in Task 3). Expected: PASS.
- [ ] **Step 6: Commit** `feat(pack-plugin): pack plugins with .capybara-plugin/plugin.json`.

### Task 3: The kernel reads plugin tgz; the extension store moves over

**Files:**
- Create: `packages/kernel/src/catalog/plugin-package.ts` (`readPluginPackage`)
- Modify: `packages/kernel/src/extensions/package.ts`, `installs.ts`, `admin-view.ts`, `admin-ops.ts`, `cli.ts`, `sync.ts`, `instance.ts`, `blobs.ts` (doc), `packages/kernel/src/errors.ts`, `packages/kernel/test/helpers/plugin-packages.ts`, `packages/kernel/test/extensions/package.test.ts`, `installs.test.ts` and every test using `pluginTgz` / `lifePkg` / `greeterPkg` / `sandboxFakePkg` / `packOfficialPlugin`, `apps/web/messages/{en,zh}.json` (new codes), `tools/checks/src/plugin-pack.ts`

**Interfaces:**
- Consumes: Task 1, Task 2.
- Produces:
  - `readPluginPackage(bytes: Uint8Array, opts: { maxBytes: number; hostSdkVersion: string; hostZodVersion?: string }): Promise<PluginPackage>` with `PluginPackage { sha256; size; packageJson; manifest: PluginManifest; files: Map<string, Uint8Array>; skills: { name; dir; files: string[] }[]; connectorTemplates: { id; path; file: ConnectorTemplateFile }[] }`. It unpacks with `unpackPackageTgz`, rejects the legacy format first (Global Constraints), parses `plugin.json`, applies `validatePluginPackageJsonFor`, resolves `skills` (listed or scanned; each SKILL.md through `parseSkillMd`, names unique) and `connectorTemplates` (listed or scanned; id = base name), checks every listed path exists, and throws `PluginPackageError { code: "catalog.invalid_manifest" | "catalog.legacy_format"; issues: string[] }`.
  - `readExtensionPackage(bytes, opts): Promise<ExtensionPackage>` keeps its name and return shape, but reads `manifest.extension` from `readPluginPackage` (`ExtensionPackage.section` becomes `PluginExtensionSection` plus the `manifest`'s `name`/`version`); a plugin without an extension throws `ExtensionPackageError` with `extension.no_extension`; legacy format → `extension.legacy_format`.
  - Test helper (in `packages/kernel/test/helpers/plugin-packages.ts`): `pluginTgz(opts: { manifest: Partial<PluginManifest> & { name: string }; packageName?: string; files?: Record<string, string | Uint8Array>; extension?: ExtensionTgzOpts }): Promise<Uint8Array>` building the new layout (the extension variant is what `pluginTgz` builds today); `lifePkg` / `greeterPkg` / `sandboxFakePkg` return new-format tgz; `legacyTgz()` builds an old-format tgz for the rejection tests.

- [ ] **Step 1: Failing tests** in `package.test.ts`: a new-format extension plugin reads; a legacy tgz (`capybara` section, and separately `app.yaml`) fails with `extension.legacy_format` and the exact message; a declarative plugin fails `readExtensionPackage` with `extension.no_extension`; Review Focus 2 cases fail `readPluginPackage` with `catalog.invalid_manifest` and the path in the issue.
- [ ] **Step 2:** Run `pnpm exec vitest run packages/kernel/test/extensions/package.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement `readPluginPackage` and move `readExtensionPackage`, `permissionSetOfSection`, `readMigrationSql` and the loader (`sync.ts` / `instance.ts`) to `PluginExtensionSection` paths (strip the leading `./`). `extension_packages.section` stores the `PluginExtensionSection` JSON for new rows.
- [ ] **Step 4:** Make every re-read of a stored blob (`admin-view.ts:300`, `admin-ops.ts:107`, `cli.ts:180`, `sync.ts`) map `extension.legacy_format` to a visible state: admin view `status: "legacy_format"` with the message; `sync.ts` records the replica status error instead of throwing. Test: install a legacy blob directly into the store (bypassing ingest), then the admin view lists it with that status and reconcile doesn't crash.
- [ ] **Step 5:** Switch the helpers and every extension test (`packages/kernel/test/extensions/**`, `lifecycle*.test.ts`, `apps/capybara/test/*`, `packages/testing/test/*`) to the new helpers; switch `checkPluginPack` to `readExtensionPackage` / `readPluginPackage`; add the two error codes to `errors.ts` and both message files.
- [ ] **Step 6:** No migration: the `extension_packages.section` JSON changes shape only for new rows; stored old rows are read only through the blob, which reports `legacy_format`.
- [ ] **Step 7:** Run `pnpm exec vitest run packages/kernel/test/extensions packages/kernel/test/lifecycle.test.ts apps/capybara packages/testing tools/checks tools/pack-plugin`; `pnpm check`. Expected: PASS.
- [ ] **Step 8: Commit** `feat(kernel): read plugin tgz and reject the pre-0.1.0 format`.

### Task 4: Catalog with one kind, one import flow, marketplace.json

**Files:**
- Create: `packages/kernel/src/migrations/0044_catalog_one_kind.sql`, `packages/kernel/test/catalog/one-kind-migration.test.ts`
- Modify: `packages/kernel/src/catalog/{catalog.service.ts, plugin-import.ts, archive.ts, marketplaces.service.ts, marketplace-fetch.ts, admin-catalog.controller.ts, marketplaces.controller.ts, requests.service.ts}`, `packages/kernel/src/db/kernel-schema.ts`, `packages/kernel/src/errors.ts`, `packages/testing/src/fake-marketplace.ts`, `packages/kernel/test/catalog/{packages.ts, org-env.ts, archive.test.ts, catalog.test.ts, marketplaces.test.ts, plugin-import.test.ts, m6-segment3.dual.test.ts}`, `apps/web/messages/{en,zh}.json` (new codes only; pages are Task 6)
- Delete: `packages/kernel/src/catalog/archive.ts` if nothing else uses it (zip skill upload goes away: designer's call, a plugin is a tgz; record it)

**Interfaces:**
- Consumes: Task 3 (`readPluginPackage`, `PluginPackage`, `pluginTgz` helper), Task 1 (`parseMarketplaceManifest`, `marketplaceEntryVersion`).
- Produces:
  - `PluginImport.prepare(actor, bytes, source: { kind: "file" | "npm" | "marketplace"; ref: string; integrity?: string; marketplaceId?: string }, opts): Promise<{ stagingId: string; review: PluginReview }>` for every plugin. `PluginReview { name; version; publisher; description; displayName?; license?; extension?: { name; version; permissions: PermissionView; action: "install" | "upgrade" | "keep" | "none"; deployed: boolean }; skills: { name; description; body }[]; connectorTemplates: { id; displayName; endpoint; auth }[]; dependencies: { name; range; resolved: string | null }[]; source: {...}; reviewHash: string }`.
  - `PluginImport.confirm(actor, stagingId, { reviewHash, deployExtension }): Promise<CatalogItemView>`; writes `catalog_item_versions.manifest`, files under the object prefix, `extension_sha256` when there is an extension; with `deployExtension` installs and enables the extension (today's `deploy()` limited to the plugin's own extension).
  - `CatalogService` loses `importFile` / `importNpm` / the private one-step `import`; `importFromMarketplace(actor, { marketplaceId, name, version? })` returns `{ stagingId, review }`; `marketplace.source_unsupported` for `path` / `git` sources.
  - `MarketplacesService.entries({ marketplaceId?, q? })` without `kind`; entries keyed `(source_id, name, version)`; `adopted` / `newerAvailable` computed by `(name)`.
  - `startFakeMarketplace({ manifest }): FakeMarketplace { url /* …/marketplace.json */, setManifest, setRedirect, requests, stop }` (renamed from `index` / `setIndex`).
  - Test helpers in `packages/kernel/test/catalog/packages.ts`: `skillPlugin(name, opts?)`, `templatePlugin(id, template, opts?)`, `bundlePlugin({ name, dependencies?, skills?, templates? })` built on `pluginTgz`; `templateTgz`, `skillTgz`, `skillZip`, `appTgz`, `appBundleTgz` deleted. `org-env.ts`: `seedApp` replaced by `seedPlugin` writing the new manifest.

- [ ] **Step 1: Migration test first** (`one-kind-migration.test.ts`): from the 0043 state with one item of each old kind, an org plugin install with components, a request, a grant, a staging row, and an org skill + connector pointing at an item: after the migration the catalog tables are empty, the org skill and connector exist with NULL `catalog_item_id`, extension installs are untouched, `catalog_items` has no `kind` column, a second run is a no-op. Run it: FAIL.
- [ ] **Step 2:** Write the migration (Formats → Database), with `-- capybara:allow-destructive pre-0.1.0 catalog content is in a format 0b removes; nothing is released` before each delete and drop. Run: PASS.
- [ ] **Step 3: Import tests first** (`plugin-import.test.ts`, `catalog.test.ts`): a skills-only plugin, a templates-only plugin, an extension-only plugin and a plugin with all three plus a dependency import through prepare → confirm; the review shows the dependency as resolved / unresolved (unresolved does not block import, spec §4.1); a stale `reviewHash` is 409; `deployExtension` deploys only the plugin's own extension; importing a legacy tgz is `catalog.legacy_format`; a second version of the same plugin adds a version; a different plugin with the same extension name as an existing one is refused (today's name-owner rule). Run: FAIL.
- [ ] **Step 4:** Implement: fold `CatalogService.import` into `PluginImport`; remove `fetchLocked` / `fetchPlugins` / `reviewPlugins` for referenced extensions (dependencies are resolved, never fetched); skill and template checks reuse today's `checkSkillFiles` / `checkTemplate` (template's connector extension must be loaded or be a dependency's extension). Run: PASS.
- [ ] **Step 5: Marketplace tests first** (`marketplaces.test.ts`): refresh of a `marketplace.json` with npm, archive, path and git entries lists all four, marks path / git `importable: false, reason: "needs_git_marketplaces"`; importing an npm entry verifies integrity and returns a staging; an archive entry downloads from `archive.url` and verifies sha512 or sha256; path / git import is `marketplace.source_unsupported`; an old `index.json` body (`entries` key) fails refresh with `marketplace.invalid` naming `plugins`. Run: FAIL; implement; PASS.
- [ ] **Step 6:** Remove the `kind` parameter from the admin catalog and marketplace controllers; add the new routes of the HTTP table for import / confirm / entry import; add the new error codes with copy. Update `m6-segment3.dual.test.ts`.
- [ ] **Step 7:** Run `pnpm exec vitest run packages/kernel/test/catalog packages/testing`; `pnpm check`. Expected: PASS.
- [ ] **Step 8: Commit** `feat(kernel)!: one catalog kind, one plugin import flow, marketplace.json`.

### Task 5: Org install is plugin install, with dependencies

**Files:**
- Create: `packages/kernel/src/migrations/0045_plugin_dependencies.sql`
- Modify: `packages/kernel/src/catalog/{plugin-install.ts, org-catalog.service.ts, org-catalog.controller.ts, requests.service.ts}`, `packages/kernel/src/db/kernel-schema.ts`, `packages/kernel/test/catalog/{plugin-install.test.ts, org.test.ts, requests.test.ts, org-env.ts}`

**Interfaces:**
- Consumes: Task 4 (`catalog_item_versions.manifest`, `seedPlugin`, `bundlePlugin`).
- Produces:
  - `PluginInstaller.install(orgId, actor, itemId, version, input: PluginInstallInput, opts): Promise<PluginInstallView>` for every plugin; steps in order: dependencies (depth-first, each a nested `plugin_installs` row recorded as a `'plugin'` component of the parent, an already-installed dependency recorded with `created = false`), extension (enable in the org; `catalog.not_deployed` when not installed on the deployment), connectors, skills. Rollback undoes nested installs this install created.
  - Dependency resolution `resolveDependencies(trx, manifest): Promise<{ name; range; itemId; version }[]>`: highest imported, non-removed version satisfying the range; none → `catalog.dependency_unresolved`; item `disabled` → `catalog.dependency_disabled`; cycle → `catalog.dependency_cycle`; depth limit 10.
  - Required org actions for a plugin = union over its components (extension → `org.extensions.manage`, skills → the skills action, templates → the connectors action), replacing `INSTALL_ACTIONS` per kind. Approval follows the installed plugin's policy only (spec §10).
  - `uninstall` handles `'plugin'` components with the existing rules; a dependency used by another install is kept with `used_by_other_install`.
  - `OrgCatalogService.install` always calls `PluginInstaller.install`; `OrgCatalogService.list` computes `installed` from `plugin_installs`.

- [ ] **Step 1: Failing tests** (`plugin-install.test.ts`): Review Focus 3 cases one by one; a skills-only plugin install creates the skill with provenance = the plugin item; a templates-only install needs connector input; an extension-only install enables the extension in the org (today's semantics); approval: a `needs_approval` plugin with an `allow` dependency goes through one request; uninstall removes a dependency it created and keeps one that was pre-existing.
- [ ] **Step 2:** Run `pnpm exec vitest run packages/kernel/test/catalog/plugin-install.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Migration `0045` (CHECK adds `'plugin'`; idempotent drop/add of the named constraint with the destructive comment); implement the installer changes and dependency resolution.
- [ ] **Step 4:** Collapse `OrgCatalogService.install` and `INSTALL_ACTIONS`; update `org.test.ts`, `requests.test.ts`.
- [ ] **Step 5:** Run `pnpm exec vitest run packages/kernel/test/catalog`; `pnpm check`. Expected: PASS.
- [ ] **Step 6: Commit** `feat(kernel): install plugins in orgs with their dependencies`.

### Task 6: Web: one kind, one import review, plugin install wizard

**Files:**
- Modify: `apps/web/src/lib/catalog.ts`, `apps/web/src/components/{CatalogParts.tsx, CatalogInstallAction.tsx, CatalogInstallWizard.tsx}`, `apps/web/src/app/[locale]/(app)/admin/catalog/{page.tsx, [itemId]/page.tsx, requests/page.tsx}`, `admin/catalog/plugins/review/page.tsx` → `admin/catalog/import/page.tsx`, `admin/marketplaces/entries/page.tsx`, `catalog/{page.tsx, [itemId]/page.tsx, [itemId]/install/page.tsx}`, `settings/plugins/page.tsx`, `apps/web/messages/{en,zh}.json`, `apps/web/test/catalog-pages.test.tsx`, `apps/web/e2e/global-setup.ts`, `apps/web/e2e/catalog-flow.spec.ts`

**Interfaces:**
- Consumes: Task 4 and Task 5 HTTP shapes (HTTP table).
- Produces: route `/admin/catalog/import?staging=<id>` (review + confirm with "deploy the extension" toggle); item detail lists components (extension with permissions, skills, connector templates, dependencies with resolution); no kind filters; marketplace entries show "needs git marketplaces (phase A)" for path / git; copy keys `catalog.kind.*` removed, `catalog.components.*` added (zh and en).

- [ ] **Step 1: Failing tests** in `catalog-pages.test.tsx`: the item page renders the four component sections from a fixture; the marketplace entries page renders an unsupported entry as not importable; the import page posts `{ reviewHash, deployExtension }`.
- [ ] **Step 2:** Run `pnpm exec vitest run apps/web`. Expected: FAIL.
- [ ] **Step 3:** Implement with design components only (`check:web-ui`); remove every `PACKAGE_KINDS` / `kind` branch; e2e `global-setup.ts` builds a `crm` plugin (dependency on a `crm-core` extension plugin) with the new helpers and serves `marketplace.json`.
- [ ] **Step 4:** Run `pnpm exec vitest run apps/web tools/checks`; `pnpm check:web-ui`; `pnpm typecheck`. Expected: PASS. Visual baselines that change go through the `visual-update` workflow after the PR opens.
- [ ] **Step 5: Commit** `feat(web)!: one catalog kind and the plugin import review`.

### Task 7: CLI `capybara plugins`

**Files:**
- Create: `apps/capybara/src/commands/plugins.ts`, `apps/capybara/test/plugins.test.ts`
- Modify: `apps/capybara/src/args.ts`, `apps/capybara/src/cli.ts`, `packages/kernel/src/catalog/cli.ts` (new: `openCatalogCli`, like `openExtensionCli`), `packages/kernel/src/index.ts`

**Interfaces:**
- Produces: `capybara plugins list` (catalog items: name, latest version, components, policy) and `capybara plugins import <file.tgz | npm:<name>[@ver]> [--deploy-extension] [--yes]` (prepare, print the review — extension permissions, skills, templates, dependencies — then confirm on `--yes` or an interactive yes). Errors `capybara: plugins <verb> failed: <message>`.

- [ ] **Step 1: Failing tests**: list on an empty catalog prints `No plugins in the catalog.`; import of a skills-only plugin prints its review and, with `--yes`, the item appears in `list`; import of a legacy tgz exits 1 with the legacy message; `extensions install` of a declarative plugin exits 1 with `extension.no_extension`'s message.
- [ ] **Step 2:** Run `pnpm exec vitest run apps/capybara`. Expected: FAIL.
- [ ] **Step 3:** Implement; retarget `check:terms`' `capybara plugins <subcommand>` pattern and `checkCli` (their "plan 0b" notes): `capybara plugins` is now valid; keep banning `capybara plugins (review|approve|enable|disable|uninstall|state)` (extension subcommands).
- [ ] **Step 4:** Run the tests; `pnpm check`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(cli): add capybara plugins list and import`.

### Task 8: Docs, skills and the spec

**Files:**
- Modify: `.agents/skills/writing-apps/` → `.agents/skills/writing-plugins/` (rewritten for `plugin.json`, dependencies, connector template files, the import review, org install), `.agents/skills/writing-extensions/SKILL.md` (packing writes `plugin.json`; source `.capybara-plugin/plugin.json` required), `writing-connectors`, `writing-kernel-api` (routes), `AGENTS.md` (Rules bullets: plugin packages, enterprise catalog, app bundles → plugins; repository map), `docs/deploy/*.md` (import and marketplace sections, the legacy-format note in `upgrade.md`), `packages/plugin-sdk/README.md` (schemas), `docs/superpowers/specs/2026-10-22-package-ecosystem-design.md`, `tools/checks/src/terms.ts` (`writing-plugins` pattern retarget: the folder exists again for bundles; ban `writing-apps`)

- [ ] **Step 1:** Rewrite the skill and doc sections listed. The writing-plugins skill's frontmatter passes `check:skills-frontmatter`.
- [ ] **Step 2: Spec updates** (mark each **(decided, 2026-10-25)** or **(designer's call)**):
  - header, §12 "Ordering around the first release" and §6.4: the first release is after the split (phase A), 0.1.0 for every package; the SDK stays 0.x until the plugins repo is stable; while on 0.x, additive SDK changes ship as patches and a breaking change is a minor that every plugin follows (decided 2026-10-25);
  - §4.2: the SDK keeps `yaml` for SKILL.md frontmatter;
  - §4.1: the connector template file shape and the `connectorTemplates` path refs; §5.2: path / git sources parsed in 0b, imported from phase A;
  - §3 / §13: the catalog routes are the plugin routes (no `/admin/plugins`); dropped `kind` columns; old catalog content removed by the migration; legacy extension blobs need a repack; zip skill upload removed.
- [ ] **Step 3:** `pnpm check` (skills frontmatter, terms, synced skills). Expected: PASS.
- [ ] **Step 4: Commit** `docs: describe plugin.json, marketplace.json and plugin install`.

### Task 9: Remove the old formats; acceptance

**Files:**
- Delete: `packages/plugin-sdk/src/app-manifest.ts`, `packages/plugin-sdk/src/catalog.ts`, `packages/plugin-sdk/test/{app-manifest,catalog,package-kinds}.test.ts`, `packages/plugin-sdk/schemas/{app.v1,catalog-index.v1}.schema.json`
- Modify: `packages/plugin-sdk/src/plugin-package.ts` (remove `PACKAGE_KINDS`, `PackageKind`, `CapybaraPackageSection`, `PluginPackageSection`, `ConnectorTemplateSection`, `SkillPackageSection`, `AppPackageSection`, `PackageSection`, `parsePackageSection`, `APP_MANIFEST_FILE`, `validatePluginPackageJson`, `PLUGIN_PACKAGE_ENTRY`; keep `staticManifestOf`, `StaticExtensionManifest`, `isSafePackagePath`, `checkEntryImports`, `validateConnectorTemplate`, `ConnectorTemplateSpec`, `CONNECTOR_TEMPLATE_LIMITS`, `CATALOG_ITEM_NAME_RE`, `NPM_PACKAGE_NAME_RE`, `HOST_PROVIDED_PACKAGES`), `packages/plugin-sdk/src/index.ts`, `api/plugin-sdk.api.md`, `tools/checks/src/package-schemas.ts` (+ test, stale fixture), `tools/checks/src/terms.ts` (empty `SDK_OLD_FORMATS_UNTIL_0B_TASK_9`; add `OLD_REFERENCES` for `app\.yaml`, `parseAppManifest`, `PACKAGE_KINDS`, `parseCatalogIndex`, `CatalogIndex`, `appBundleTgz`, `capybara\.kind`), `packages/kernel/src/index.ts`, `apps/web/src/lib/catalog.ts` (no local `PACKAGE_KINDS`), `.superpowers` ledger hand-off

- [ ] **Step 1:** Add the new `OLD_REFERENCES` rules with fixture lines; run `pnpm exec vitest run tools/checks/test/terms.test.ts`: FAIL (rules missing) → implement → PASS.
- [ ] **Step 2:** Delete the old SDK formats; fix every compile error (there should be none left in consumers after Tasks 2–7; any remaining use is a missed migration and is fixed here, listed in the report); `pnpm gen:sdk-api`; `pnpm gen:package-schemas`; `pnpm check`. Expected: `check:terms` passes with the allowlist empty; `grep -nE "PackageKind|AppManifest|CatalogIndex|capybara\\.kind|app\\.yaml" -r packages apps tools plugins --exclude-dir=node_modules` lists only migration files ≤ 0043, the legacy-format detector and its tests.
- [ ] **Step 3: Acceptance.**
  - Database: from a scratch DB migrated by `main` at the 0a merge (`6e210e5`) with a seed covering every catalog table and an installed extension, this branch's `capybara migrate` applies the new migrations; org skills, connectors and extension installs remain; the admin extensions view shows the old blob as `legacy_format`; a second migrate applies nothing.
  - Replay: `pnpm exec vitest run packages/kernel/test/evals packages/kernel/test/tools/rename-compat.test.ts` passes with no fixture change.
  - `pnpm verify` passes; `bash docker/test/compose-smoke.sh` passes (model-fake installs from the new-format tgz).
- [ ] **Step 4:** Hand-off note in the ledger: phase 0 is complete; the next plan is phase A (git marketplaces, bootstrap, plugin-tools, the split); the first release follows phase A.
- [ ] **Step 5: Commit** `refactor(plugin-sdk)!: remove the M6 / M7 package formats`.
