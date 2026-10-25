# Package Ecosystem Phase A1: Git Marketplaces, Versions, Provenance and Org Upgrades Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Marketplaces and plugins can come from git repos, every marketplace download refuses private addresses, versions carry a content digest and "content changed at the same version", npm imports show provenance, a plugin cannot silently overwrite another skill, and an org can upgrade (or roll back) an installed plugin in place.

**Architecture:** A kernel network layer (`net/`) resolves and pins public addresses for every untrusted download. A git reader (isomorphic-git over that layer) turns a repo commit into the same file map the tgz reader produces, so git plugins go through the one import review. Catalog versions gain source detail and a content digest. The org installer gains a preview/confirm upgrade that reuses its component ledger and rollback. Web and docs follow.

**Tech Stack:** TypeScript, NestJS + Fastify kernel, Kysely + PG migrations, `isomorphic-git` (new kernel dependency), `undici` (new direct kernel dependency, already in the lockfile), `semver`, Next web app, vitest, Playwright; tests use the system `git` binary (`git http-backend`) for a fake smart-HTTP server.

**Spec:** `docs/superpowers/specs/2026-10-22-package-ecosystem-design.md` §5.1, §5.3, §5.4 (stored records), §5.5 (provenance; the official marketplace switch is A3), §9.2, §10 (in-place upgrade), §12 phase A acceptance items for marketplaces, upgrades and skill conflicts. Phase A2 (`bootstrap.json`) and A3 (plugin-tools, fakes, the split, official marketplace on) are separate plans. Claude formats (`.claude-plugin/…`) are phase B: A1 reads only `.capybara-plugin/` and skills-only repos.

## Global Constraints

- Every download whose URL comes from a marketplace or an admin (marketplace manifest, mirrors, archive sources, git sources, git marketplaces, direct git import) goes through `net/`: https only (`http` only for loopback with `marketplaces.allowInsecureLoopback`, testing only), no redirects, the resolved IP must be public, the connection is pinned to the checked IP (no second DNS lookup). Exception list: `marketplaces.allowPrivateHosts` (new, default `[]`, hostnames or CIDRs, for internal GitLab / mirrors; spec §5.1 offline deployments) and the configured `packages.npmRegistry` origin (admin-configured internal mirror).
- Blocked address ranges are those of `plugins/sandbox-docker/egress-proxy/proxy.mjs` (`BLOCKED_V4` / `BLOCKED_V6`, including v4-mapped, NAT64, 6to4); port them, don't import across the plugin boundary.
- Git access: https smart HTTP only, depth 1, single commit, no tags, no submodules (not fetched), LFS pointer files are read as plain files; limits: pack bytes ≤ `packages.maxBytes`, files ≤ 5000, unpacked bytes ≤ 4 × `packages.maxBytes`, 120 s per operation. An optional token (stored like `catalog-token:<id>`) is sent only to the marketplace URL's origin.
- Integrity rules stay: npm and archive sources are verified against the manifest; git sources are pinned by commit sha; nothing trusts npm metadata.
- Frozen names and rules from 0a/0b stay (Global Constraints of `2026-10-25-ecosystem-phase0b-formats.md`). Migrations from 0046, idempotent, destructive statements commented. `check:applied-migrations` forbids editing 0001–0045.
- New error codes get zh and en copy (the error-copy test). UI copy through i18n. Web pages use design components only (`check:web-ui`).
- One changeset `.changeset/ecosystem-phase-a1.md` (patch: plugin-sdk if touched, kernel, testing, capybara). English comments; Conventional Commits, body ≤ 100, `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Tests from the repo root.

## Decisions (designer's calls; recorded in the spec by Task 9)

1. **Private addresses with an allowlist**: default-deny everywhere, plus `marketplaces.allowPrivateHosts` and the npm registry origin, because spec §5.1 both denies private addresses and recommends internal GitLab mirrors.
2. **Git client**: `isomorphic-git` (pure JS, any smart-HTTP host incl. GitLab / Gitea) with an `http` plugin built on `net/`. Files are read from the fetched pack (`readTree` / `readBlob`), never checked out to disk; the object store is a temp dir removed after each operation.
3. **Git plugins without `package.json`** are allowed (spec §4.1 says it is needed only for npm). Without `plugin.json`, a directory with `skills/` is a skills-only plugin named after the marketplace entry (or, for a single-plugin repo / direct import, the last path segment of the repo URL without `.git`), version per §5.3.
4. **One reader**: `readPluginPackage` is split into `unpack → readPluginFiles(files: Map<string, Uint8Array>, opts)`, so tgz and git share every check.
5. **Content digest**: `sha256` over the sorted file list, each entry `path + "\0" + sha256(content) + "\n"`, hex; computed for every import (tgz too), stored on the version.
6. **Same version, changed content**: re-importing a version whose digest differs records `<version>+git.<sha12>` (git) or `<version>+sha256.<12>` (archive/npm/file); same digest → `catalog.version_exists` with "already imported".
7. **Provenance**: npm only; fetched from `<registry>/-/npm/v1/attestations/<name>@<version>`; the SLSA provenance statement is parsed for repository, commit and workflow; signatures are not verified (spec §5.5 "display"); failures show "provenance not checked".
8. **Skill conflicts**: checked in install planning and upgrade preview; reinstall/upgrade of the same item adds a version; the org's own skill or another item's skill → `plugin.skill_conflict` (409) with the exact message of spec §9.2, one line per skill.
9. **Upgrade ledger**: `plugin_install_components.template_id` (new, for connector components) maps a connector to its template id; connectors get a template-update path (`applyTemplateIn`) that rewrites only template-owned fields.
10. **Upgrade with an extension**: the target must be the catalog version whose extension version equals the deployment's loaded version; declarative plugins may target any imported version (rollback). An org whose install's extension version differs from the deployment's shows "upgrade pending".
11. **Upgrade approval**: follows the item's policy like install (`needs_approval` → a request for that version; after approval the org admin runs the upgrade again); `disabled` → `catalog.item_disabled`.

## Review Focus

1. **DNS rebinding and redirects**: a host that resolves public on the check and private on connect, an IPv6 or v4-mapped private address, a 3xx to a private host, a git server that redirects. Every download must refuse and say why. Task 1 tests each.
2. **A hostile repo**: a huge pack, 10 000 files, a symlink, a path with `..`, a submodule entry, a `.capybara-plugin/plugin.json` pointing outside the plugin dir, an extension plugin without `dist/index.mjs`. Import refuses before storing. Task 2 and Task 3 test these.
3. **Upgrade halfway failure**: the connector step fails after skills got new versions and a dependency was installed; the org must end exactly as before (skills back, dependency removed, connector fields restored, status `installed` at the old version). Task 6 injects the failure.
4. **Upgrade vs uninstall / second upgrade at once**: one wins, the other gets 409 `plugin.install_in_progress`; no half state. Task 6 tests it.
5. **Skill conflict message**: names each conflicting skill and its source exactly as spec §9.2; nothing is written. Task 5 tests install and upgrade preview.

---

### Task 1: Public-address network layer

**Files:**
- Create: `packages/kernel/src/net/public-address.ts`, `packages/kernel/src/net/safe-fetch.ts`, `packages/kernel/test/net/public-address.test.ts`, `packages/kernel/test/net/safe-fetch.test.ts`
- Modify: `packages/kernel/package.json` (add `undici`), `packages/kernel/src/config/schema.ts` (`marketplaces.allowPrivateHosts`), `docs/config.md` (regenerate), `packages/kernel/src/catalog/marketplace-fetch.ts` (manifest and archive fetches use `safeFetch`), `packages/kernel/src/kernel.ts` (wiring)

**Interfaces:**
- Produces:
  - `isForbiddenAddress(ip: string): boolean`
  - `type NetPolicy = { allowInsecureLoopback: boolean; allowPrivateHosts: string[]; trustedOrigins: string[] }` (trustedOrigins: the npm registry origin)
  - `resolvePublic(host: string, policy: NetPolicy, lookup?: LookupFn): Promise<string[]>` — throws `NetDeniedError { code: "net.private_address" | "net.dns_failed"; host }`
  - `safeFetch(url: string, init: RequestInit & { signal: AbortSignal }, policy: NetPolicy, opts?: { lookup?: LookupFn; maxBytes?: number }): Promise<Response>` — https (or loopback http per policy), `redirect: "manual"` (3xx → `NetDeniedError` code `net.redirect`), connection pinned to the checked IP via an undici `Agent` whose `connect.lookup` returns it.
  - Error codes `marketplace.private_address` (422) and `marketplace.redirect` (422) with copy; marketplace fetch maps `NetDeniedError` to them.

- [ ] **Step 1: Failing tests.** `public-address.test.ts`: the ranges of `proxy.mjs` (127/8, 10/8, 172.16/12, 192.168/16, 169.254/16, 100.64/10, 0/8, ::1, fc00::/7, fe80::/10, ::ffff:10.0.0.1, 64:ff9b::a00:1, 2002:0a00::) are forbidden; 8.8.8.8 and 2606:4700::1111 pass; `allowPrivateHosts: ["gitlab.internal", "10.1.0.0/16"]` lets those through; a lookup returning one public and one private address is refused. `safe-fetch.test.ts` (local servers with injected lookup): a rebinding lookup (public at check, private at connect) is impossible because the connect uses the checked IP (assert the server saw the pinned connection); a 302 is refused with `net.redirect`; `maxBytes` aborts a large body.
- [ ] **Step 2:** Run `pnpm exec vitest run packages/kernel/test/net`. Expected: FAIL.
- [ ] **Step 3:** Implement; switch `fetchMarketplaceManifest` / `fetchMarketplaceArchive` to `safeFetch` (loopback tests keep working through `allowInsecureLoopback`); add the config key (`description`: "Hosts or CIDRs that marketplace and git downloads may reach although they resolve to private addresses, e.g. an internal GitLab mirror"); `pnpm gen:config-docs` (see adding-config skill).
- [ ] **Step 4:** Run the net tests and `pnpm exec vitest run packages/kernel/test/catalog`; `pnpm check`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(kernel): deny private addresses for marketplace downloads`.

### Task 2: Git reader and one plugin-files reader

**Files:**
- Create: `packages/kernel/src/catalog/git-source.ts`, `packages/kernel/test/catalog/git-source.test.ts`, `packages/testing/src/fake-git-server.ts`
- Modify: `packages/kernel/package.json` (add `isomorphic-git`), `packages/kernel/src/catalog/plugin-package.ts` (split out `readPluginFiles`), `packages/testing/src/index.ts`

**Interfaces:**
- Consumes: Task 1 `safeFetch`, `NetPolicy`.
- Produces:
  - `readPluginFiles(files: Map<string, Uint8Array>, opts: { hostSdkVersion: string; fallbackName?: string; fallbackVersion?: string; requirePackageJson: boolean }): PluginPackage` (the tgz path calls it with `requirePackageJson: true`; git with `false`).
  - `type GitLocation = { url: string; ref?: string; commit?: string; path?: string }`
  - `resolveGitCommit(loc: GitLocation, o: GitOptions): Promise<string>` (40-hex; `ref` default = the remote HEAD)
  - `readGitTree(loc: GitLocation & { commit: string }, o: GitOptions): Promise<Map<string, Uint8Array>>` — files under `path` (relative, `/`-separated), limits of Global Constraints, symlinks and submodule entries refused (`marketplace.git_unsupported_entry`), errors `marketplace.git_failed` / `marketplace.git_too_large`.
  - `type GitOptions = { net: NetPolicy; token?: string; tokenOrigin?: string; signal: AbortSignal; maxBytes: number }`
  - `expandGitUrl(input: string): string` (`owner/repo` → `https://github.com/owner/repo.git`)
  - Test helper `startFakeGitServer(): Promise<{ url(repo: string): string; commit(repo: string, files: Record<string, string>, opts?: { branch?: string }): Promise<string>; stop(): Promise<void> }>` — bare repos in a temp dir served by `git http-backend` over loopback http.

- [ ] **Step 1: Failing tests.** Resolve HEAD and a branch; read a tree at a commit and under a `path`; the tree matches what was committed byte for byte; a symlink entry and a submodule entry are refused; a repo over the file limit is refused (`marketplace.git_too_large`); a second `readGitTree` of the same commit is deterministic; `readPluginFiles` without `package.json` and `requirePackageJson: false` reads a skills-only dir with the fallback name/version; the tgz path still requires `package.json`.
- [ ] **Step 2:** Run `pnpm exec vitest run packages/kernel/test/catalog/git-source.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement (isomorphic-git `getRemoteInfo2` / `fetch` with `depth: 1, singleRef: true, tags: false`, `readTree` / `readBlob` walk; http plugin on `safeFetch`; temp gitdir removed in `finally`).
- [ ] **Step 4:** Run the git tests and `packages/kernel/test/extensions/package.test.ts`, `packages/kernel/test/catalog`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(kernel): read plugins from git commits`.

### Task 3: Git marketplaces, git sources and direct git import

**Files:**
- Create: `packages/kernel/src/migrations/0046_git_sources.sql`, `packages/kernel/test/catalog/git-marketplaces.test.ts`
- Modify: `packages/kernel/src/catalog/{marketplaces.service.ts, marketplaces.controller.ts, catalog.service.ts, plugin-import.ts, admin-catalog.controller.ts}`, `packages/kernel/src/db/kernel-schema.ts`, `packages/kernel/src/config/schema.ts` (`marketplaces.allowedHosts`), `packages/kernel/src/errors.ts`, `apps/web/messages/{en,zh}.json` (codes only)

**Interfaces:**
- Consumes: Task 2.
- Produces:
  - Marketplace forms: `url` ending in `.json` (or not a git URL) = http form as today; a git URL (`https://…/*.git`, any https URL with `form: "git"`, or `owner/repo`) = git form with optional `ref`. `marketplaces` gains `form text NOT NULL DEFAULT 'http' CHECK (form IN ('http','git'))`, `ref text NULL`, `last_commit text NULL`. Refresh of a git marketplace resolves the commit; unchanged commit → skip (like 304); reads `.capybara-plugin/marketplace.json`, else a single-plugin repo (root has `.capybara-plugin/plugin.json` or `skills/`) → one entry named per Decision 3.
  - `marketplace_entries` gain nothing; path entries are imported at the marketplace's `last_commit`; git entries at `commit` or the resolved `ref` head (recorded).
  - `catalog_item_versions` gain `source_detail jsonb NULL` (`{ host, repo, path, ref?, commit, followsBranch }` for git; `{ url }` origin+path for archive; `{ registry }` for npm) and `content_digest text NULL` (Task 4 fills it); `source` CHECK adds `'git'`.
  - `marketplaces.allowedHosts: string[]` (default `[]` = unrestricted): entries whose source host (git/archive) is outside it show `importable: false, reason: "host_not_allowed"`; import refuses with `marketplace.host_not_allowed`.
  - `POST /api/v1/admin/catalog/import/git` body `{ url, ref?, path? }` → `{ stagingId, review }` (a one-off; no marketplace created).
  - `reason: "needs_git_marketplaces"` and `marketplace.source_unsupported` are removed (no longer reachable); copy updated.

- [ ] **Step 1: Failing tests** (`git-marketplaces.test.ts` with `startFakeGitServer`): add a git marketplace (`owner/repo` expansion tested as a pure function); refresh lists entries from `.capybara-plugin/marketplace.json`; a second refresh with no new commit doesn't rewrite entries; a single-plugin repo yields one entry; importing a path entry and a git entry (pinned commit, and branch-following) records `source: 'git'` and `source_detail` with `followsBranch`; an extension plugin without `dist/index.mjs` is refused ("the plugin has an extension but no build output"); `allowedHosts` blocks an outside entry; direct `import/git` works; the marketplace token reaches only the marketplace origin.
- [ ] **Step 2:** Run it. Expected: FAIL.
- [ ] **Step 3:** Migration `0046`, then implement. Run: PASS. Run `packages/kernel/test/catalog`; `pnpm check`.
- [ ] **Step 4: Commit** `feat(kernel): git marketplaces and git plugin sources`.

### Task 4: Content digest and same-version changes

**Files:**
- Modify: `packages/kernel/src/catalog/{plugin-import.ts, catalog.service.ts, marketplaces.service.ts}`, tests in `packages/kernel/test/catalog/{plugin-import.test.ts, git-marketplaces.test.ts, marketplaces.test.ts}`

**Interfaces:**
- Produces:
  - `contentDigest(files: Map<string, Uint8Array>): string` (Decision 5), stored in `content_digest` for every import.
  - Entry version order of §5.3: `plugin.json` version → entry `version` → `0.0.0-git.<sha12>` (git) / `0.0.0-sha256.<12>` (archive).
  - Re-import of an existing version with a different digest stores `<version>+git.<sha12>` / `+sha256.<12>` (Decision 6); same digest → `catalog.version_exists` "already imported".
  - Version comparisons ignore build metadata; ties ordered by `imported_at`. One shared helper module `packages/kernel/src/catalog/versions.ts` (`compareVersions`, `satisfiesRange`, `maxSatisfying`) replaces the three duplicated `satisfies` helpers.
  - `MarketplaceEntryView.contentChanged: boolean` (an adopted version equal to the entry version whose recorded commit/integrity differs) and the same flag on the admin item view.

- [ ] **Step 1: Failing tests**: digest is stable across tgz and git of the same files; moving the repo without bumping the version shows `contentChanged` and re-import records `+git.<sha12>`; re-import with identical content is refused as already imported; `1.0.0+git.abc` and `1.0.0` both satisfy `^1.0.0`; latest-version logic ignores build metadata and uses import time for ties.
- [ ] **Step 2:** Run. Expected: FAIL. **Step 3:** Implement. Run: PASS; `packages/kernel/test/catalog`; `pnpm check`.
- [ ] **Step 4: Commit** `feat(kernel): content digests and same-version changes`.

### Task 5: npm provenance and skill name conflicts

**Files:**
- Create: `packages/kernel/src/packages/provenance.ts`, `packages/kernel/test/catalog/provenance.test.ts`
- Modify: `packages/kernel/src/catalog/{plugin-import.ts, plugin-install.ts}`, `packages/kernel/src/skills/skills.service.ts` (provenance query helper), `packages/testing/src/fake-npm-registry.ts` (serve attestations), `packages/kernel/src/errors.ts`, messages, `packages/kernel/test/catalog/{org.test.ts, plugin-install.test.ts}` (the old "adds a version to the org's own skill" expectations change)

**Interfaces:**
- Produces:
  - `fetchProvenance(cfg: NpmFetchConfig, name: string, version: string, signal: AbortSignal): Promise<Provenance | { checked: false; reason: string }>` with `Provenance { checked: true; repository: string; commit: string; workflow: string; buildType: string }`; `PluginReview.provenance` (npm and npm-backed marketplace imports; `{ checked: false, reason: "not an npm package" }` otherwise) plus `provenanceWarning?: "repository_mismatch"` when a git marketplace's repo differs from the attested repo.
  - `plugin.skill_conflict` (409): `details: [{ skill, source: { kind: "org" } | { kind: "plugin"; name; version } }]`; message lines exactly `Skill "<name>" already exists in this org (source: <the org's own skill | plugin "<name>" <version>>). Remove or rename it, then install again.` Checked in `PluginInstaller.plan` (install and upgrade preview); same catalog item → add a version as today.

- [ ] **Step 1: Failing tests**: provenance parsed from a fixture attestation (DSSE envelope, in-toto SLSA v1 statement) and shown in the review; a registry without attestations → `checked: false`; install of a plugin whose skill exists as the org's own skill fails with the exact message and changes nothing; another plugin's skill → message names that plugin and version; reinstall of the same item adds a version.
- [ ] **Step 2:** Run. Expected: FAIL. **Step 3:** Implement. Run: PASS; `packages/kernel/test/catalog`; `pnpm check`.
- [ ] **Step 4: Commit** `feat(kernel): npm provenance in the review and skill name conflicts`.

### Task 6: Org in-place upgrade (kernel)

**Files:**
- Create: `packages/kernel/src/migrations/0047_plugin_upgrades.sql`, `packages/kernel/src/catalog/plugin-upgrade.ts`, `packages/kernel/test/catalog/plugin-upgrade.test.ts`
- Modify: `packages/kernel/src/catalog/{plugin-install.ts, org-catalog.service.ts, org-catalog.controller.ts}`, `packages/kernel/src/tools/connectors.service.ts` (`applyTemplateIn`, `restoreTemplateFieldsIn`), `packages/kernel/src/db/kernel-schema.ts`, `packages/kernel/src/errors.ts`, messages

**Interfaces:**
- Consumes: Task 5 (`skill_conflict` in planning), Task 4 (`versions.ts`).
- Produces:
  - Migration `0047`: `plugin_installs.status` CHECK adds `'upgrading'`; `plugin_install_components.template_id text NULL` (backfilled `NULL`; the installer writes it for connector components from now on).
  - `POST /api/v1/orgs/:orgId/plugin-installs/:installId/upgrade/preview` body `{ version }` → `{ from, to, diffHash, components: { kind; ref; change: "added" | "changed" | "removed" | "unchanged"; detail? }[], inputs: { connectors: templateId[]; credentialsChanged: templateId[]; extensionConfig: boolean } }`.
  - `POST /api/v1/orgs/:orgId/plugin-installs/:installId/upgrade` body `{ version, diffHash, connectors?, extensionConfig? }` → the install view (200), or 202 `{ request }` for `needs_approval`; stale `diffHash` → 409 `plugin.upgrade_stale`; target rules of Decision 10 → 409 `plugin.upgrade_target_invalid` (message says which version the deployment runs).
  - Per-component behaviour exactly as spec §10's table; default tool policies updated only where `policy_source = 'template'`; credentials kept unless the auth type or required credentials change (then listed in `inputs.credentialsChanged` and required).
  - Failure rollback: undo created components, `revertVersionIn` for skills that got a version, `restoreTemplateFieldsIn` for changed connectors (old fields captured before the change), status back to `installed` at the old version, `error = { step, code }` recorded; audit `plugin.org_upgrade_failed`.
  - Concurrency: status `upgrading` set under the org lock; uninstall and another upgrade get `plugin.install_in_progress`; stale `upgrading` past `catalog.staleInstallMinutes` is treated like stale `installing` (cleanup restores the old version).
  - Audit `plugin.org_upgraded { itemId, name, from, to, components }`.
  - Views: `PluginInstallView` gains `upgradeAvailable: string | null` (highest allowed target) and `deploymentPending: boolean` (Decision 10); `OrgCatalogItem.installed` gains `upgradeAvailable`.

- [ ] **Step 1: Failing tests** (`plugin-upgrade.test.ts`, using `seedPlugin(..., { addTo })`): preview lists added / changed / removed skills, templates and dependencies; confirm applies them (skill version +1, agent selection unchanged; connector endpoint preset and template-default policies updated, admin-changed policy kept, credentials kept; new dependency installed, removed dependency uninstalled per rules); declarative rollback to an older version; extension plugin can target only the deployment's extension version (`plugin.upgrade_target_invalid` otherwise) and shows `deploymentPending`; stale `diffHash` → 409; `needs_approval` → 202 request; `disabled` → refused; Review Focus 3 (inject a failure at the connector step: everything back, status `installed` at the old version); Review Focus 4 (upgrade vs uninstall and two upgrades: one gets 409); a skill conflict appears in the preview.
- [ ] **Step 2:** Run. Expected: FAIL. **Step 3:** Migration and implementation. Run: PASS; `packages/kernel/test/catalog packages/kernel/test/tools`; `pnpm check`.
- [ ] **Step 4: Commit** `feat(kernel): upgrade installed plugins in place`.

### Task 7: Web: git marketplaces, source detail, provenance, upgrades

**Files:**
- Modify: `apps/web/src/lib/catalog.ts`, `apps/web/src/app/[locale]/(app)/admin/marketplaces/{page.tsx, entries/page.tsx}`, `admin/catalog/{page.tsx, import/page.tsx, [itemId]/page.tsx}`, `settings/plugins/page.tsx`, `catalog/[itemId]/page.tsx`, `apps/web/src/components/{CatalogInstallAction.tsx, CatalogInstallWizard.tsx}`, new `apps/web/src/components/PluginUpgradeDialog.tsx`, messages, `apps/web/test/catalog-pages.test.tsx`, `apps/web/e2e/{global-setup.ts, catalog-flow.spec.ts}`

**Interfaces:**
- Consumes: HTTP shapes of Tasks 3–6 (read the controllers).
- Produces: the add-marketplace form accepts a git URL or `owner/repo` with an optional ref; entries show source (npm / archive / git host+repo+commit, "follows a branch"), "content changed at the same version", and `host_not_allowed`; the import page shows provenance ("built from <repo>@<sha> by <workflow>", "provenance not checked", the mismatch warning) and source detail; an "Import from git" source on the import page; settings/plugins and the catalog item page show "upgrade available" / "deployment updated, upgrade this org's plugin", with an upgrade dialog (preview list, required inputs, confirm with `diffHash`); `plugin.skill_conflict`, `plugin.upgrade_*`, `marketplace.private_address` / `redirect` / `host_not_allowed` / `git_*` copy names the skill / host.

- [ ] **Step 1: Failing tests** in `catalog-pages.test.tsx` for: git marketplace add body, entry source rendering, provenance block, upgrade dialog (preview → confirm posts `{ version, diffHash, … }`), skill conflict message rendering.
- [ ] **Step 2:** Run `pnpm exec vitest run apps/web`. Expected: FAIL. **Step 3:** Implement. e2e: add a git marketplace from `startFakeGitServer` in global-setup and an upgrade step in `catalog-flow.spec.ts`. Run apps/web, `pnpm check:web-ui`, `pnpm typecheck`, e2e if available. Expected: PASS.
- [ ] **Step 4: Commit** `feat(web): git marketplaces, provenance and plugin upgrades`.

### Task 8: CLI and docs

**Files:**
- Modify: `apps/capybara/src/commands/plugins.ts` (`plugins import git:<url>[#ref][:path]`), `apps/capybara/test/plugins.test.ts`, `.agents/skills/writing-plugins/SKILL.md`, `.agents/skills/writing-kernel-api/SKILL.md` (routes), `docs/deploy/README.md` (git marketplaces, `allowPrivateHosts`, `allowedHosts`), `docs/deploy/upgrade.md` (A1 notes), `docs/superpowers/specs/2026-10-22-package-ecosystem-design.md` (Decisions 1–11 as designer's calls; acceptance status)

- [ ] **Step 1:** Failing CLI test: `capybara plugins import git:<fake repo url>` prints the review with source detail and imports with `--yes`. Run `pnpm exec vitest run apps/capybara`: FAIL. Implement: PASS.
- [ ] **Step 2:** Docs and spec edits; `pnpm check`.
- [ ] **Step 3: Commit** `docs: git marketplaces, provenance and plugin upgrades`.

### Task 9: Acceptance

- [ ] **Step 1:** Spec §12 phase A items in A1's scope, each as a named test that exists and passes (list them in the report with file:test): marketplace repo added and listed; declarative plugin and extension-bearing npm plugin imported, integrity mismatch refused; "content changed at the same version"; org upgrade keeps agent selection and credentials, keeps a dropped-but-selected skill; injected connector failure rolls back; skill conflict message; dual-replica: an upgrade on replica A is visible on replica B (add to `m6-segment3.dual.test.ts` or a new dual test).
- [ ] **Step 2:** DB from `main` (the commit this branch started from) migrates through 0046–0047; second run no-op.
- [ ] **Step 3:** `pnpm verify`; `bash docker/test/compose-smoke.sh`.
- [ ] **Step 4:** Hand-off note in the ledger: next plan A2 (`bootstrap.json`).
