# Bootstrap extra manifest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A deployment adds plugins, marketplaces and a default theme at startup through
`bootstrap.extraManifest`, merged with the built-in manifest (#450).

**Architecture:** The SDK gains a second manifest format; the kernel merges it into the built-in
manifest before the unchanged bootstrap run, obtains `git` entries by reading a pinned commit and
packing it with `packPackageTgz`, registers config-managed marketplaces at start, and applies the
default theme on every start while the setting is still the seed. Marketplace git credentials
become username + token.

**Tech Stack:** TypeScript, zod 4, NestJS, Kysely, PostgreSQL, Redis, vitest, isomorphic git reader
(`catalog/git-source.ts`), Next.js admin UI.

**Spec:** `docs/superpowers/specs/2026-11-20-bootstrap-extra-manifest-design.md`

## Global Constraints

- Config: `bootstrap.extraManifest` (string path, default absent, not hot; env
  `CAPYBARA_BOOTSTRAP__EXTRA_MANIFEST`), `marketplaces.tokens` (record name → string, `secret`, not
  hot, default `{}`). Regenerate `docs/config.md` (`pnpm gen:config-docs`).
- Extra manifest: `schemaVersion: 1`, strict objects, `$schema`
  `https://capybarahq.com/schemas/bootstrap-extra.v1.schema.json`.
- Marketplace name `^[a-z0-9][a-z0-9-]{0,63}$`, `official` reserved; username
  `^[A-Za-z0-9._-]{1,64}$`; empty username sends `x-access-token`.
- `git` entry: `commit` 40 lower-case hex; `path` starts with `./`; `integrity` = sha512 of
  `packPackageTgz(tree files under path)`.
- Managed marketplace row id `config:<name>`, `managed = 'config'`.
- Default theme applied only when `uiTheme` value is `{ id: null }` and `updated_by IS NULL`.
- New error codes: `bootstrap.extra_invalid`, `bootstrap.extra_conflict`,
  `bootstrap.git_read_failed`, `marketplace.config_managed`.
- Migrations expand-only, `IF NOT EXISTS`; next number `0169`.
- English for code, comments, docs, commits; UI strings zh + en through i18n (`pnpm check:i18n`).
- SDK public API change: `pnpm gen:sdk-api` + changeset bumping `@capybara-hq/plugin-sdk`; changesets
  for `@capybara-hq/kernel`, `@capybara-hq/plugin-tools`, `@capybara-hq/capybara`.
- Kernel conventions: `@Injectable`, explicit `@Inject`, `@Transactional()` writes, `KernelConfigService`
  (`pnpm check:kernel-conventions`).

## Review Focus

1. **A token never appears in logs, errors, audit or API responses** — git failures, managed rows
   (`hasToken` only), parse errors of `marketplaces.tokens`. Test in Task 4 and Task 7.
2. **Extra manifest path missing or unreadable** — the start fails with `bootstrap.extra_invalid`
   naming the path, not an ENOENT stack. Test in Task 6.
3. **Theme row not there yet on the first start** (plugin deferred or failed) — no write, a warning,
   and the next start applies it. Test in Task 8.
4. **Two replicas starting together** — one theme write, one audit row. Test in Task 8 (dual).
5. **A managed marketplace leaves the file while items were imported from it** — row kept, becomes
   an ordinary custom marketplace without token; imported items untouched. Test in Task 4.

---

## Wave plan

| Wave | Tasks (disjoint files, parallel) |
|---|---|
| 1 | Task 1 (SDK), Task 2 (config), Task 3 (git username) |
| 2 | Task 4 (managed marketplaces, migration — review alone), Task 9 (plugin-tools; needs only Task 1) |
| 3 | Task 5 (admin UI), Task 6 (merge + CLI; calls Task 4's `syncExtraFromConfig`) |
| 4 | Task 7 (git entries — trust boundary, review alone), Task 8 (default theme — multi-replica, review alone) |
| 5 | Task 10 (docs, AGENTS.md, skills, compose, changesets), then `pnpm verify` |

---

### Task 1: SDK extra manifest format

**Files:**
- Modify: `packages/plugin-sdk/src/bootstrap.ts`
- Modify: `packages/plugin-sdk/src/git-hosts.ts`
- Create: `packages/plugin-sdk/schemas/bootstrap-extra.v1.schema.json` (generated)
- Modify: `tools/checks/src/package-schemas.ts` (register in `PACKAGE_SCHEMAS`)
- Test: `packages/plugin-sdk/test/bootstrap.test.ts`, `packages/plugin-sdk/test/git-hosts.test.ts`

**Interfaces:**
- Produces:
  - `type BootstrapGitEntry = { name; source: "git"; marketplace: string; commit: string; path: string; version; integrity; required?: boolean; builtin?: boolean }`
  - `type BootstrapExtraEntry = (BootstrapEntry & { source: "npm" }) | BootstrapGitEntry` (npm entries here have `required` optional, default false)
  - `interface BootstrapExtraMarketplace { name: string; url: string; ref?: string; username?: string }`
  - `interface BootstrapExtraManifest { $schema?; schemaVersion: 1; marketplaces: BootstrapExtraMarketplace[]; plugins: BootstrapExtraEntry[]; defaultTheme?: { plugin: string; theme: string } }`
  - `BootstrapExtraManifestSchema`, `parseBootstrapExtraManifest(raw: unknown): { manifest: BootstrapExtraManifest } | { errors: string[] }` (never throws, ≤ 50 errors, same shape as `parseBootstrapManifest`)
  - `BOOTSTRAP_EXTRA_MANIFEST_SCHEMA_VERSION = 1`
  - `GIT_MARKETPLACE_USERNAME_DEFAULT = "x-access-token"`, `suggestGitUsername(host: string): string | undefined` (`github.com`, `*.ghe.com` → `x-access-token`; `bitbucket.org` → `x-token-auth`; `gitlab.com` → `oauth2`)
  - `GIT_USERNAME_RE` exported (`^[A-Za-z0-9._-]{1,64}$`)

- [ ] **Step 1: Write failing tests** in `bootstrap.test.ts`, describe `parseBootstrapExtraManifest`:
  - `accepts the spec example` (the §2 JSON with real-looking hex/sha512) → `manifest.plugins.length === 2`
  - `rejects unknown keys` (`plugins[0].foo`) → errors include `plugins.0`
  - `rejects defaultTheme on a non-builtin entry` → error mentions `defaultTheme.plugin`
  - `rejects a git entry naming an undeclared marketplace`
  - `rejects duplicate plugin and marketplace names`, `rejects the reserved name official`
  - `rejects required and builtin together`
  - `rejects a branch as commit` (`"main"`) and `a path without ./`
  - `JSON Schema validates the example` (ajv, as the existing test does)
  In `git-hosts.test.ts`: `suggestGitUsername("bitbucket.org") === "x-token-auth"`,
  `suggestGitUsername("acme.ghe.com") === "x-access-token"`, `suggestGitUsername("gitee.com") === undefined`.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/plugin-sdk/test/bootstrap.test.ts packages/plugin-sdk/test/git-hosts.test.ts` → FAIL (not exported).
- [ ] **Step 3: Implement** the schema with cross-field rules in `superRefine` (reuse the built-in regexes and `MARKETPLACE` path rule); export from `src/index.ts`.
- [ ] **Step 4: Register** the schema in `PACKAGE_SCHEMAS`; run `pnpm gen:package-schemas`, `pnpm gen:sdk-api`.
- [ ] **Step 5: Run** the tests and `pnpm check:package-schemas && pnpm check:sdk-api` → PASS.
- [ ] **Step 6: Commit** `feat(plugin-sdk): bootstrap extra manifest format (#450)` with a changeset (minor, `@capybara-hq/plugin-sdk`).

### Task 2: Kernel config fields

**Files:**
- Modify: `packages/kernel/src/config/schema.ts` (`bootstrap` at :502, `marketplaces` at :531)
- Modify: `docs/config.md` (generated)
- Test: `packages/kernel/test/config/schema.test.ts` (or the existing config schema test file)

**Interfaces:**
- Produces: `config.bootstrap.extraManifest: string | undefined`; `config.marketplaces.tokens: Record<string, string>`.

- [ ] **Step 1: Failing tests:** `CAPYBARA_BOOTSTRAP__EXTRA_MANIFEST=/x.json` → `bootstrap.extraManifest === "/x.json"`; `CAPYBARA_MARKETPLACES__TOKENS='{"acme":"t"}'` → `marketplaces.tokens.acme === "t"`; a token key failing the marketplace-name regex is a validation error; `tokens` is listed as secret (the config redaction helper prints `***`).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** both fields with `meta({ description, secret })`, descriptions stating: path resolved against the working directory; tokens for marketplaces declared by the extra manifest.
- [ ] **Step 4:** `pnpm gen:config-docs`; run tests and `pnpm check:config-docs` → PASS.
- [ ] **Step 5: Commit** `feat(kernel): bootstrap.extraManifest and marketplaces.tokens config (#450)`.

### Task 3: Git credential username

**Files:**
- Modify: `packages/kernel/src/catalog/git-source.ts` (`GitOptions` :61, `startOp` :177-187)
- Test: `packages/kernel/test/catalog/git-source.test.ts`

**Interfaces:**
- Produces: `GitOptions.username?: string` (absent → `GIT_MARKETPLACE_USERNAME_DEFAULT`).

- [ ] **Step 1: Failing tests** with `startFakeGitServer` recording requests: `sends Basic x-token-auth:<token> when username is x-token-auth`; `defaults to x-access-token`; `sends no authorization to another origin` (redirect to a second fake server).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(kernel): configurable git username for marketplace tokens (#450)`.

### Task 4: Config-managed marketplaces and the username column (migration; review alone)

**Files:**
- Create: `packages/kernel/src/migrations/0174_marketplace_managed_username.sql`
- Modify: `packages/kernel/src/db/kernel-schema.ts` (`MarketplacesTable` :2363)
- Modify: `packages/kernel/src/catalog/marketplaces.service.ts` (`add`/`writeAdd` :771-866, `update`/`writeUpdate` :877-1005, `remove` :1012, `token()`, git refresh :1186, `views`)
- Modify: `packages/kernel/src/catalog/marketplaces.schemas.ts`, `catalog/marketplaces.controller.ts` (body `username`), `catalog/catalog.service.ts` (`importFromMarketplace` passes `username`)
- Modify: `packages/kernel/src/errors.ts` (`marketplace.config_managed`)
- Modify: `packages/kernel/src/platform/ops/marketplaces.ops.ts` (username in the add/update operation; parity test)
- Test: `packages/kernel/test/catalog/marketplaces-managed.test.ts` (new, integration)

**Interfaces:**
- Consumes: Task 1 `BootstrapExtraMarketplace`, Task 2 `marketplaces.tokens`, Task 3 `GitOptions.username`.
- Produces:
  - `MarketplacesService.syncExtraFromConfig(marketplaces: readonly BootstrapExtraMarketplace[]): Promise<void>`
  - `MarketplacesService.credentials(id: string): Promise<{ token?: string; username?: string }>` (replaces direct `token(id)` use for git; managed rows read `config.marketplaces.tokens[name]`)

Migration body:
```sql
ALTER TABLE marketplaces ADD COLUMN IF NOT EXISTS managed text NULL;
ALTER TABLE marketplaces ADD COLUMN IF NOT EXISTS username text NULL;
```

- [ ] **Step 1: Failing tests:**
  - `syncExtraFromConfig creates config:<name> rows with managed=config` (url, ref, username stored; form git for `.git`)
  - `a managed row refuses update and delete with marketplace.config_managed, but enabled can change`
  - `refresh of a managed private git marketplace sends the config token with its username` (fake git server)
  - `the token never appears in the marketplace view, audit detail or error` (assert serialized JSON has no token string)
  - `a name removed from the file keeps the row, managed becomes null, token no longer sent` (Review Focus 5)
  - `admin add with username stores it; empty username sends x-access-token`
- [ ] **Step 2: Run** `pnpm exec vitest run packages/kernel/test/catalog/marketplaces-managed.test.ts` → FAIL.
- [ ] **Step 3: Implement** migration, types, `syncExtraFromConfig` (one transaction, upsert by id; clear `etag`/`last_commit` when URL/ref change, as the official sync does), guards beside the `builtin` ones (`writeUpdate` :920, `remove` :1023), `credentials()`, username in add/update/view (`username`, `managed`, `hasToken`).
- [ ] **Step 4: Run** tests, `pnpm check:platform-ops`, `pnpm exec vitest run packages/kernel/test/platform/platform-parity.test.ts` → PASS.
- [ ] **Step 5: Commit** `feat(kernel): config-managed marketplaces and git usernames (#450)`.

### Task 5: Admin UI for username and managed marketplaces

**Files:**
- Modify: `apps/web/src/app/(app)/admin/plugins/sources/view.tsx` (:147-148, :284-338) and its add/edit dialog
- Modify: `apps/web/src/lib/admin.ts` (marketplace types: `username`, `managed`)
- Modify: `apps/web/messages/zh.json`, `apps/web/messages/en.json`
- Test: `apps/web/test/admin-marketplaces.test.tsx` (existing sources test file if present)

**Interfaces:**
- Consumes: Task 4 view fields `username: string | null`, `managed: "config" | null`, `hasToken: boolean`; SDK `suggestGitUsername`.

- [ ] **Step 1: Failing tests:** the add dialog shows a "Username" field for a git URL, pre-filled with `x-token-auth` after typing a `https://bitbucket.org/...git` URL and left empty for `https://gitee.com/...git`; a managed row renders read-only with the label `catalog.admin.marketplaces.managed` and no delete action.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** with design components only (no styles; `pnpm check:web-ui`). i18n zh: 「用户名」「由部署配置管理」; en: "Username", "Configured by the deployment".
- [ ] **Step 4: Run** tests, `pnpm check:i18n`, `pnpm check:web-ui` → PASS.
- [ ] **Step 5: Commit** `feat(web): marketplace username and config-managed sources (#450)`.

### Task 6: Load and merge the manifests; CLI flag

**Files:**
- Create: `packages/kernel/src/extensions/bootstrap-extra.ts`
- Modify: `packages/kernel/src/lifecycle/kernel-lifecycle.ts` (:234 sync, :358 manifest)
- Modify: `packages/kernel/src/app.ts` (`KernelAppOptions.bootstrap.extraManifest?: string`)
- Modify: `apps/capybara/src/args.ts`, `apps/capybara/src/commands/bootstrap.ts`, `apps/capybara/src/commands/start.ts`
- Modify: `packages/kernel/src/errors.ts` (`bootstrap.extra_invalid`, `bootstrap.extra_conflict`), `packages/kernel/src/index.ts` (exports)
- Test: `packages/kernel/test/extensions/bootstrap-extra.test.ts` (unit, no db), `apps/capybara/test/bootstrap.test.ts`, `apps/capybara/test/args.test.ts`

**Interfaces:**
- Consumes: Task 1 parse function.
- Produces:
  - `readBootstrapExtraManifest(file: string): Promise<BootstrapExtraManifest>` (throws `ApiError("bootstrap.extra_invalid")` naming the file and the parse errors, also for ENOENT)
  - `mergeBootstrapManifests(builtin: BootstrapManifest, extra: BootstrapExtraManifest | undefined): MergedBootstrapManifest`
  - `type MergedBootstrapManifest = BootstrapManifest & { plugins: (BootstrapEntry | BootstrapGitEntry)[]; extra?: { marketplaces: BootstrapExtraMarketplace[]; defaultTheme?: { plugin: string; theme: string } } }` — `bootstrapManifestSha256` hashes this whole object
  - `loadBootstrapManifest(o: { manifestFile?: string; extraManifest?: string }): Promise<MergedBootstrapManifest>`

- [ ] **Step 1: Failing unit tests:** `merge keeps built-in entries first then extra`; `merge fails bootstrap.extra_conflict on a shared name`; `no extra manifest gives the built-in manifest and sha unchanged` (sha equals `bootstrapManifestSha256(builtin)`); `a missing file is bootstrap.extra_invalid naming the path` (Review Focus 2); CLI: `capybara bootstrap --extra-manifest f.json` parsed; config value used when the flag is absent.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**; lifecycle reads `loadBootstrapManifest({ extraManifest: options.bootstrap?.extraManifest })` when `options.bootstrapManifest` is absent, and calls `marketplaces.syncExtraFromConfig(extra.marketplaces)` right after `syncOfficialFromConfig` (:234). `start.ts` resolves `config.bootstrap.extraManifest` against cwd like `bootstrapDirOf`.
- [ ] **Step 4: Run** tests and `packages/kernel/test/lifecycle/start-order.test.ts` → PASS.
- [ ] **Step 5: Commit** `feat(kernel): merge the extra bootstrap manifest (#450)`.

### Task 7: Git entries (trust boundary; review alone)

**Files:**
- Modify: `packages/kernel/src/extensions/bootstrap.ts` (`resolveBootstrapPackages` :220-287, `importOnly` :718, `deploy` :741)
- Modify: `packages/kernel/src/catalog/catalog.service.ts` (export `gitSource` :293 as `marketplaceGitSource`)
- Modify: `packages/kernel/src/errors.ts` (`bootstrap.git_read_failed`)
- Test: `packages/kernel/test/extensions/bootstrap-git.test.ts` (new integration, Postgres + Redis, `startFakeGitServer`)

**Interfaces:**
- Consumes: Task 3 `GitOptions.username`, Task 6 `MergedBootstrapManifest`, `readGitTreeAndOids`, `packPackageTgz`.
- Produces: `BootstrapResolveOptions.gitCredentials?: (marketplace: string) => { token?: string; username?: string }` (kernel: from `config.marketplaces.tokens` and the manifest's `marketplaces[]`).

Rules: offline tgz by sha512 first; else read `{ url: marketplace.url, commit, path }`, keep files under `path` (re-rooted), `packPackageTgz`, refuse unless sha512 === `integrity` (`bootstrap.integrity_mismatch`); git errors become `bootstrap.git_read_failed` with the git message and never the token. Import source for a git entry: `{ kind: "marketplace", marketplaceId: "config:<marketplace>", ref, integrity, detail }` where `{ detail, ref } = marketplaceGitSource({ url, path }, { commit, tree }, false)`.

- [ ] **Step 1: Failing tests:**
  - `a git entry is installed from the fake git server at its commit` (declarative theme plugin and an extension plugin with committed `dist/`)
  - `a tgz in the offline dir with the pinned sha512 is used without network` (git server stopped)
  - `a tree that packs to another sha512 fails bootstrap.integrity_mismatch` (commit changed under the same entry)
  - `a private repo needs the token; the token is absent from the error when wrong` (Review Focus 1)
  - `the catalog version records the managed marketplace source, and importFromMarketplace of the same entry is the same source` (no `catalog.name_conflict`)
  - `capybara bootstrap installs git entries before any kernel start` (CLI path, no marketplace rows)
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** tests plus `packages/kernel/test/extensions/bootstrap.test.ts` → PASS.
- [ ] **Step 5: Commit** `feat(kernel): git entries in the extra bootstrap manifest (#450)`.

### Task 8: Default theme at start (multi-replica; review alone)

**Files:**
- Modify: `packages/kernel/src/identity/settings.ts` (beside `update` :913 and `write` :950)
- Create: `packages/kernel/src/extensions/bootstrap-defaults.ts` (`BootstrapDefaultsService`)
- Modify: `packages/kernel/src/lifecycle/kernel-lifecycle.ts` (after the pass-2 point :299-302, every start)
- Test: `packages/kernel/test/extensions/bootstrap-default-theme.test.ts`, `packages/kernel/test/extensions/bootstrap.dual.test.ts` (add a case)

**Interfaces:**
- Consumes: Task 6 `MergedBootstrapManifest.extra.defaultTheme`, `SuperAdminLock.lock()`, `lockThemeShared`, `lockUiThemeRow`, `assertPlatformDefaultEligible`.
- Produces:
  - `SettingsService.applyBootstrapUiTheme(themeId: string): Promise<"applied" | "kept">` (`@Transactional()`; lock order: `SuperAdminLock.lock()`, `lockThemeShared(themeId)`, `lockUiThemeRow`; applies only when value `{ id: null }` and `updated_by IS NULL`; audit `deployment.settings.updated`, actor `bootstrap`, detail `{ defaultTheme }`)
  - `BootstrapDefaultsService.apply(defaultTheme?: { plugin: string; theme: string }): Promise<void>` (resolves the UUID: `platform_themes` where `plugin_name`, `name`, `deleted_at IS NULL`, `owner_org_id IS NULL`; missing or `theme.not_available` → `log.warn`, never throws)

- [ ] **Step 1: Failing tests:**
  - `a fresh deployment with defaultTheme serves it from /api/v1/platform/theme`
  - `a restart does not write again` (one audit row)
  - `a super admin's explicit null is kept` (PUT settings `{ uiTheme: { id: null } }`, restart → still null)
  - `a super admin's other theme is kept`
  - `theme row missing on the first start: warning, applied on the next start` (Review Focus 3)
  - dual: `two replicas starting together write once` (Review Focus 4)
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS, including `pnpm exec vitest run --project container packages/kernel/test/extensions/bootstrap.dual.test.ts`.
- [ ] **Step 5: Commit** `feat(kernel): default platform theme from the extra bootstrap manifest (#450)`.

### Task 9: `capybara-plugin bootstrap`

**Files:**
- Create: `packages/plugin-tools/src/bootstrap/cli.ts`, `packages/plugin-tools/src/bootstrap/check.ts`
- Modify: `packages/plugin-tools/src/cli.ts` (usage line and dispatch beside `marketplace`)
- Modify: `packages/kernel/src/index.ts` (export `packPackageTgz` if not exported)
- Test: `packages/plugin-tools/test/bootstrap.test.ts` (fixtures under `packages/plugin-tools/test/fixtures/bootstrap/`)

**Interfaces:**
- Consumes: Task 1 parse, kernel `packPackageTgz`. The tree at `commit` is read from the local
  repository with git plumbing (`git ls-tree -r -z <commit> -- <path>` + `git cat-file blob`), not
  with the kernel's HTTP git reader (its URL rules refuse `file://`).
- Produces: `capybara-plugin bootstrap --check|--write [--file <path>] [--root <dir>] [--out <dir>] [--network]`; findings `bootstrap-extra-invalid`, `bootstrap-extra-integrity`, `bootstrap-extra-path`.

- [ ] **Step 1: Failing tests:** good fixture passes `--check`; changed file after pinning → `bootstrap-extra-integrity`; missing path → `bootstrap-extra-path`; `--write` sets `commit` to HEAD, `version` from `plugin.json`, `integrity`, and writes `<name>-<version>.tgz` into `--out` whose sha512 equals the new `integrity`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(plugin-tools): bootstrap --check / --write for extra manifests (#450)` with a changeset.

### Task 10: Docs, rules, compose, changesets; full verify

**Files:**
- Modify: `AGENTS.md` (Extensions rule, bootstrap line), `.agents/skills/writing-plugins/SKILL.md` (:219 token line, :290-297 Bootstrap plugins)
- Modify: `docs/superpowers/specs/2026-10-22-package-ecosystem-design.md` (§5.4, §7 amendments), `docs/superpowers/specs/2026-10-28-startup-bootstrap-design.md` (amendment "Extra manifest"), `docs/superpowers/specs/2026-11-08-themes-design.md` (§7 bootstrap default)
- Modify: `docker/compose.yaml` (init comment: mounting an extra manifest)
- Create: `.changeset/*.md` (kernel minor, capybara minor)

- [ ] **Step 1:** Write the amendments (dated 2026-11-20, linking the spec) and the AGENTS.md line: "a deployment may add pinned entries through `bootstrap.extraManifest`, merged, never overriding".
- [ ] **Step 2: Run** `pnpm check:agent-docs && pnpm check:english-comments --base origin/main` → PASS.
- [ ] **Step 3: Run** `CAPYBARA_TEST_WORKERS=4 pnpm verify` → all green.
- [ ] **Step 4: Commit** `docs: bootstrap extra manifest rules and amendments (#450)`.
