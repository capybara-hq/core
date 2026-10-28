# Package Ecosystem Phase A3b: Split the Repositories and the First Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **When:** A3b is executed **after the manual acceptance of phase A3a** (and after the UI work the
> 2026-10-26 decision put before it). Do not start it from the A3a branch. Several tasks are
> operations on GitHub and npm that only a maintainer can run (creating a repository, secrets,
> rulesets, manual release dispatches); they are marked **(maintainer)** and their steps say what to
> run and what to check, so an agent prepares and verifies while the maintainer clicks.

> **Amendment 2026-10-28 (maintainer decision): release candidate first, acceptance on the final
> shape.** The maintainer accepts the system in its final shape (plugins in `capybara-hq/plugins`,
> `bootstrap.json` holding only npm pins), so A3b runs **before** manual acceptance, and R1–R3
> publish **`0.1.0-rc.0`**, not 0.1.0. Changes to the tasks below:
> - Task 3 removes every pending changeset and sets the version of every published core package,
>   `apps/capybara` and `apps/web` to `0.1.0-rc.0` by hand (no changesets pre mode); the compose
>   image tag follows (`release-image-tag`). The plugins repository starts its plugins at
>   `0.1.0-rc.0` the same way.
> - Ranges on core packages are `^0.1.0-rc.0` (a plain `^0.1.0` does not match a prerelease), in the
>   plugins repository's devDependencies and in any `plugin.json` dependency range between plugins.
>   Task 1 checks that the kernel's catalog range matching accepts a prerelease against such a range.
> - Prereleases publish under the npm dist-tag `next` (`distTagFor`) and images get no `latest`
>   (`images.ts`); the first rc is still a manual dispatch (`refuseFirstRelease`).
> - Task 7 Step 0's kernel patch release is replaced by the final release: the final 0.1.0 kernel
>   ships the npm pins.
> - **Task 9 (after acceptance): promote to 0.1.0.** Fixes found in acceptance ship as further rcs.
>   Then every package goes to `0.1.0` (core libraries, plugins with new `marketplace.json` entries,
>   `bootstrap.json` pins and `marketplace.commit` rewritten, images `0.1.0` + `latest`, tag
>   `v0.1.0`), in the R1 → R2 → R3 order.
> - Wherever a step below says `0.1.0` for a version that is published before acceptance, read
>   `0.1.0-rc.0`.

**Goal:** Official plugins live in `capybara-hq/plugins` (every plugin except `model-fake`), which is a full consumer of `capybara-hq/.github` and publishes every plugin to npm with provenance and a `marketplace.json` that carries their sha512; core keeps the kernel, the libraries, `model-fake` and the fakes; the first release (0.1.0 for every package) goes out in the order core libraries → plugins → core bootstrap pins and images; the official marketplace is on by default.

**Architecture:** Core first hardens `@capybara-hq/plugin-tools` for a second repository while the plugins are still here (so every new rule is tested on the real plugins before they move): published plugins resolvable by package name, the plugin boundary and release-metadata rules inside `capybara-plugin check`, a `marketplace` command that writes and checks `marketplace.json` from reproducible packs, a release that refuses a pack whose sha512 differs from `marketplace.json`. Core then narrows its own release to the libraries and `model-fake` and gates its images on npm bootstrap entries. The plugins repository is created from core's history with `git filter-repo`, scaffolded like core (CI plan, `pnpm verify`, synced skills, settings script), and publishes 0.1.0. Finally core deletes the moved plugins, pins `bootstrap.json` to npm at the plugins repository's commit, turns `check:bootstrap --network` into a required gate, and publishes the 0.1.0 images.

**Tech Stack:** TypeScript pnpm monorepos, vitest, changesets, GitHub Actions, npm provenance, `git filter-repo`, `@capybara-hq/plugin-tools`, the `capybara-hq/.github` settings and sync CLIs, Docker.

**Spec:** `docs/superpowers/specs/2026-10-22-package-ecosystem-design.md` "Phase A3a as built", §5.5 (official marketplace on by default), §6.1–§6.6 (repos, what the plugins repo needs, core tests after the split, its release, rule changes in core, the A3b steps), §7 (npm bootstrap entries), §12 (ordering around the first release, phase A acceptance). Contributor workflow: `docs/superpowers/specs/2026-10-23-contributor-workflow-design.md` (§8: the plugins repo as the second consumer). Release runbook: `docs/deploy/release.md`. A3a ledger: `.superpowers/sdd/2026-10-26-ecosystem-phase-a3a-prepare-split/progress.md` (the "Carry to A3b" items are folded in below).

## Global Constraints

- **Nothing reaches npm or ghcr.io out of order.** The order is fixed: (R1) core's libraries `@capybara-hq/plugin-sdk`, `kernel`, `testing`, `plugin-tools` and `@capybara-hq/plugin-model-fake` at 0.1.0; (R2) every plugin from `capybara-hq/plugins` at 0.1.0; (R3) core's 0.1.0 images, built from the tree whose `bootstrap.json` pins the R2 packages. Core never publishes a plugin that moves (provenance must name `capybara-hq/plugins`, and npm versions are immutable).
- **Versions start at 0.1.0** (spec §12, decided 2026-10-25): every pending changeset in core is removed before R1 and none is added to the plugins repository before R2; `pnpm changeset status` shows nothing to release before each first run.
- **Core tests never install published plugins from npm** (spec §6.3). Only the image build, the web e2e setup and `docker/test/compose-smoke.sh` download the bootstrap plugins (the way production installs them); unit and kernel tests use fakes and fixture registries.
- **The plugins repository's tests depend on published core packages only** (`@capybara-hq/plugin-sdk`, `@capybara-hq/testing`, `@capybara-hq/plugin-tools`, `@capybara-hq/plugin-model-fake` from npm, `^0.1.0`), never on a core checkout. A contract change needs a PR in each repository; the SDK API snapshot and its changeset check make it visible.
- **Every new check states full vs diff on PRs** in AGENTS.md, `ci.yml` comments and the PR description, in both repositories; every new check is proven red first.
- **No bot commits to `main`** in either repository (`main-quality`): integrity values are computed in the reviewed Version Packages PR, never pushed afterwards.
- Frozen names and migration rules as in earlier plans; English comments and docs; Conventional Commits, body ≤ 100, `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; tests from the repo root. Core changesets: none for R1 (they are cleared); after R1, changes to published core packages get changesets as usual.

## Decisions taken in this plan (all **(designer's call)**)

1. **History is kept, with `git filter-repo`** (not `git subtree split`). `subtree split` extracts one directory prefix per run and would either flatten `plugins/<name>/` to the root of one repository per plugin or need eleven splits merged together; `filter-repo` keeps every moved path at `plugins/<name>/` in one pass (`--path plugins/<name>/` per plugin, `model-fake` left out), preserves authorship and dates (blame and provenance of old changes stay meaningful), drops tags, and rewrites `#<n>` references in messages to `capybara-hq/core#<n>` (`--replace-message`) so they do not point at the new repository's issues. Rewriting is harmless because the repository is new. Commits that touched only other paths disappear; commits that touched both keep only the plugin half. Core keeps its own history untouched; the move commit in core says where the plugins went.
2. **`model-fake` stays in core and is published from core** (spec §6.1); the plugins repository devDepends on it from npm. For that a packed plugin must resolve by package name: the packer writes `"exports": { ".": "./dist/index.mjs" }` and `"main"` for an extension-bearing plugin (A3a Ruling 5 open point; today a packed plugin has no entry field, so `createRequire().resolve("@capybara-hq/plugin-model-fake")` fails).
3. **The two web e2e specs on real plugins** (A3a Ruling 4): `connector-openapi-wizard.spec.ts` moves onto `fake-connector` with a new `kind: "openapi"` inspect mode (a spec document URL → security schemes and operations, the shape the wizard renders); `embed-board.spec.ts` is deleted: its kernel and web contract is `embed-panel.spec.ts` on `fake-embed`, and the board's own behaviour is in `plugins/example-board/test`. Core's web e2e then loads `model-fake` and fakes only.
4. **Sandbox images in compose come from the plugins repository at the pinned commit**: `build: https://github.com/capybara-hq/plugins.git#<commit>:plugins/sandbox-docker/image` (and `egress-proxy`), where `<commit>` is `bootstrap.json`'s `marketplace.commit`, checked by `check:bootstrap` (rule `bootstrap-compose-ref`, offline). One commit pins everything core takes from the plugins repository. `compose.dev.yaml` does the same.
5. **The socket proxy config's canonical copy stays in core** (`docker/sandbox-proxy/haproxy.cfg`, which compose inlines and `check:compose-haproxy` compares); the A3a rule `compose-haproxy-copy` is dropped with the plugin and replaced by the network rule `bootstrap-haproxy` of `check:bootstrap --network`: the plugin's test copy at `marketplace.commit` must equal core's file byte for byte. `affected.ts` adds `docker/sandbox-proxy/**` to the triggers of the network check.
6. **`check:bootstrap --network` enforces the official URL** (A3a Ruling 7): `marketplace.url` must be `MARKETPLACE_OFFICIAL_URL_DEFAULT`; tests pass a fixture URL through the existing `--marketplace-url` override (the rule reads the override, the manifest keeps the official URL).
7. **`marketplace.json` keeps every published version** (one entry per `(name, version)`, spec §5.2): the Version Packages PR appends the new versions; an existing entry is never edited (`capybara-plugin marketplace --check` refuses a changed version, package or integrity of a published entry). A pinned `bootstrap.json` commit therefore lists what it pins, and deployments can still import older versions.
8. **Shared contributor tooling is copied, not shared, for now**: the plugins repository gets small private copies of core's `tools/dev` (`doctor:env`, `verify`, same JSON contract), `tools/ci` (its own affected plan), `tools/worktree` and the two skill checks (`check:synced-skills`, `check:skills-frontmatter`). Moving them into `capybara-hq/.github` waits for a third repository, as the spec decides for the release code (§6.4).
9. **The official marketplace defaults to on in R1's kernel**: the default flips before R1, so the npm kernel 0.1.0 and the 0.1.0 images agree; the repository exists (with a valid `marketplace.json` listing nothing) from Task 4 on and lists the plugins after R2. Tests and dev configs that must stay offline set it to `false` explicitly.

## Review Focus

1. **Release order and irreversibility**: no step publishes a moved plugin from core, no image is built from a tree with workspace bootstrap entries, no pending changeset survives into a first run, and an interrupted run can be resumed (each publisher skips what is on npm / ghcr.io). Check the gates in code, not in the runbook.
2. **Integrity chain**: the sha512 in the plugins repository's `marketplace.json` (written in the reviewed PR) equals the published tarball (the publish job refuses otherwise), and `bootstrap.json`'s pins equal both (`check:bootstrap --network`); the image build verifies again and init never touches the network.
3. **The plugins repository's tests run against published core packages only**: no `workspace:` or `file:` reference to core, no path into a core checkout, `plugin-test-imports` enforced there by `capybara-plugin check`.
4. **Core after the move loses no kernel coverage**: every test that remained in core passes on fakes and `model-fake`; `test-plugins.json` lists only `model-fake`; `OFFICIAL_EXCEPTIONS` is empty; e2e and compose smoke use the bootstrap plugins from npm.
5. **The plugins repository meets the contributor contract**: `pnpm doctor:env --json` / `pnpm verify --json` print the same shape as core's, `ci-ok` aggregates every job, `issue-linked` comes from `gate.yml@v1`, the settings script reports no drift, the synced skills pass `check:synced-skills`.

---

### Task 1: Toolchain for a second repository (core PR 1; plugins still in core)

**Files:**
- `packages/plugin-tools/src/pack/pack.ts` (entry fields), `packages/plugin-sdk/src/plugin-package.ts` (`validatePluginPackageJsonFor` accepts `main` / `exports` equal to the extension entry, rejects anything else in them), SDK API report + changeset if the SDK's public surface changes;
- `packages/plugin-tools/src/check/test-imports.ts` (moved from `tools/checks/src/test-plugins.ts`: rule `plugin-test-imports`; `tools/checks` keeps `test-plugins-official` and the `test-plugins.json` rules), `packages/plugin-tools/src/check/release-metadata.ts` (the plugin half of `tools/checks/src/release-metadata.ts`), `packages/plugin-tools/src/check/run.ts`;
- `packages/plugin-tools/src/marketplace/{marketplace.ts,cli.ts}` (new command), `packages/plugin-tools/src/release/publish.ts` (`--marketplace`, `--plugins`), `packages/plugin-tools/src/pack/npm.ts` (token, cap, accept header, name / version check);
- tests under `packages/plugin-tools/test/`, red fixtures under `packages/plugin-tools/fixtures/`; `tools/checks/src/cli/*` (core runs the moved rules through `pluginChecks`), README, AGENTS.md, changeset `.changeset/ecosystem-phase-a3b-toolchain.md` (plugin-tools, plugin-sdk if touched).

**Interfaces:**
- Packer: an extension-bearing plugin's `package.json` gains `"main": "./dist/index.mjs"` and `"exports": { ".": "./dist/index.mjs" }`; declarative plugins get neither. Every pin changes once: `pnpm check:bootstrap --write` in the same commit.
- `capybara-plugin check` runs, in addition, `plugin-test-imports` (now also flagging a bare `..` segment and `@capybara-hq/*` package names written as plain strings, the A3a deferred minors) and `plugin-release-metadata` (`description`, `license`, https `homepage`, `repository` `{ type: "git", url, directory: <plugin dir> }` where `url` is the root `package.json`'s `repository.url`, so core checks `capybara-hq/core.git` and the plugins repository `capybara-hq/plugins.git`; `example-*` must be private).
- `capybara-plugin marketplace --write|--check [--root <dir>] [--file .capybara-plugin/marketplace.json]`: packs every public plugin (reproducibly), and for each `(name, version)` not yet listed appends `{ name, version, summary, description?, minKernel?, permissions, source: { npm: { package, version, integrity } } }` (`permissions` from the static manifest, display only); `--check` fails when an entry would be added (`marketplace-missing`), when a listed entry's package or integrity differs from the pack of the same version in the tree (`marketplace-integrity`), or when the file does not parse with `parseMarketplaceManifest` (`marketplace-invalid`). Entries of versions no longer in the tree are kept.
- `capybara-plugin release --marketplace <file>`: before publishing a plugin, its pack's sha512 must equal the marketplace entry of that version, else the run stops with `release.integrity_mismatch` naming the plugin and both values, having published nothing after the previous package. `--plugins <glob>` limits which plugins are planned (core passes `plugins/model-fake`).
- Bootstrap download: `--npm-token` / `CAPYBARA_PACKAGES__NPM_TOKEN` sent as `Authorization: Bearer` only to the registry origin; packument requested with `Accept: application/vnd.npm.install-v1+json`; tarball capped at `PACKAGES_MAX_BYTES_DEFAULT` (`bootstrap.too_large`); the unpacked `package.json` name and version must equal the entry (`bootstrap-npm` mislabelled).

- [ ] **Step 1:** Red tests: a packed fixture plugin installed into a temp `node_modules` resolves with `createRequire(...).resolve(name)` and loads through `startTestKernel({ resolveFrom })` (Review Focus 3; this is how the plugins repository loads model-fake); `marketplace --check` on fixtures (missing, changed integrity, invalid); `release --marketplace` refuses a mismatching pack with the fake npm registry and publishes nothing after it; the token reaches only the registry origin; an oversized tarball and a mislabelled one fail; the moved rules' red fixtures (including the bare `..` and package-name-string cases).
- [ ] **Step 1b:** Red test and decision for plugin kernel tests once the kernel comes from npm. The kernel loads a plugin under test with `import(url)` of `plugins/<name>/src/index.ts` (`packages/kernel/src/extensions/instance.ts`). From `node_modules` vitest externalizes the kernel, so that import runs in native Node, which strips types but does not map `./x.js` specifiers to `.ts`, and loading fails. Core never hits this because workspace packages resolve outside `node_modules` and Vite transforms them. Test: a kernel installed into a temp `node_modules` loads a TypeScript plugin by path under vitest (red first). **Decision (default): `test.server.deps.inline: [/^@capybara-hq\//]` in the plugins repository's `vitest.config.ts`** (and in the scaffold of Task 4), so Vite transforms the kernel and the dynamic import. **Fallback if inlining does not cover the dynamic import: pack the plugin under test (`packFixture`) and load the tgz**, which costs a build per test file. Record the outcome in the Task 1 report.
- [ ] **Step 2:** Implement; core's `pnpm check` runs the moved rules through plugin-tools (same findings on the real repo: none); `check:bootstrap --write` for the new pins.
- [ ] **Step 3:** `pnpm exec vitest run packages/plugin-tools tools packages/testing`; `pnpm check`; `pnpm pack-plugins`; `pnpm build && pnpm release --dry-run --plugins plugins/model-fake` (plan: four libraries + model-fake).
- [ ] **Step 4: Commit** `feat(plugin-tools): marketplace command, resolvable packs, plugin rules in check`.

### Task 2: Core web e2e on fakes only (core PR 1)

**Files:** `packages/testing/fixtures/extensions/fake-connector/src/index.ts` (`kind: "openapi"` inspect mode), `packages/testing/test/fixtures.test.ts`; `apps/web/e2e/connector-openapi-wizard.spec.ts` (on the fake), `apps/web/e2e/embed-board.spec.ts` (deleted), `apps/web/e2e/global-setup.ts` (stale "move with plugins" comment, A3a deferred minor); `tools/checks/src/test-plugins.ts` (`OFFICIAL_EXCEPTIONS` keeps only `tools/checks/test/bootstrap.test.ts`; a listed exception that no longer loads its plugins is reported, rule `test-plugins-stale-exception`, A3a deferred minor), `tools/checks/test/test-plugins.test.ts`, `tools/ci/test-plugins.json`.

**Interfaces:** with deployment config `{ kind: "openapi" }`, `fake-connector`'s `inspect({ specUrl })` fetches a JSON document served by the test (`{ securitySchemes, operations: [{ name, method, path, annotations }] }`) and answers like connector-openapi's preview (auth hints from the security schemes, one tool per operation); without it the MCP-shaped behaviour is unchanged.

- [ ] **Step 1:** Red: `fixtures.test.ts` case for the openapi inspect mode; `test-plugins.test.ts` stale-exception fixture.
- [ ] **Step 2:** Implement; rewrite the wizard spec against the fake (same steps: spec URL, auth choice, operations, install, a call); delete `embed-board.spec.ts` after confirming every assertion it made is in `embed-panel.spec.ts` or `plugins/example-board/test` (list them in the report).
- [ ] **Step 3:** Web e2e locally (`pnpm exec playwright test` in `apps/web`), `pnpm check:test-plugins` (only the bootstrap exception left), `pnpm check`.
- [ ] **Step 4: Commit** `test(web): e2e on fakes only`.

### Task 3: Core release preparation (core PR 2, merged before R1)

**Files:** root `package.json` (`release` passes `--plugins plugins/model-fake`), `.github/workflows/release.yml` (comments; publish step), `tools/release/src/images.ts` + `images-release.ts` (gate), `tools/release/test/{images,workflow}.test.ts`, `packages/kernel/src/config/schema.ts` (`marketplaces.official.enabled` default `true`), `docs/config.md` (regenerated), kernel tests and test configs that must stay offline (`testKernelConfig`, `packages/kernel/test/helpers/*`, `apps/web/e2e/global-setup.ts`, `docker/test/*`, `docker/compose.dev.yaml` env if needed), `apps/web/messages/{en,zh}.json` (official marketplace hint), `.changeset/*.md` (all removed), `docs/deploy/{release,README,upgrade}.md`, AGENTS.md (npm and image release bullets).

**Interfaces:**
- Core's npm release publishes the four libraries and `@capybara-hq/plugin-model-fake` only; `tools/release/test/workflow.test.ts` pins `--plugins plugins/model-fake`.
- Image gate: `planImages` returns no builds and a notice "bootstrap.json has workspace entries: images are released only with npm-pinned bootstrap plugins" when any entry is `"source": "workspace"`, for `auto` and `manual` modes (a `dry-run` still builds); unit-tested.
- Official marketplace on by default; every test kernel config and the e2e / smoke stacks set `marketplaces.official.enabled: false` unless the test is about it (a test asserts the default; a grep-style test asserts `testKernelConfig` sets it off).

- [ ] **Step 1:** Red tests: image gate (workspace entry → nothing planned in auto and manual), the default flip (`resolveConfig({})` has `enabled: true`), `testKernelConfig` keeps it off.
- [ ] **Step 2:** Implement; remove every file under `.changeset/` except `config.json` and README (spec §12: the first changelog entry is "0.1.0 initial release"); runbook: the three-step first release (R1 here, R2 in the plugins repo, R3 = the push of core PR 3 or a manual run after it), `RELEASE_PR_TOKEN` for both repositories, the image gate.
- [ ] **Step 2b:** The Version Packages PR opened by `version-pr` from `.changeset/ecosystem-phase-a3a.md` (bumps to 0.1.1) must NOT be merged; removing every changeset here closes it.
- [ ] **Step 3:** `pnpm verify`; `pnpm changeset status` (nothing to release); `pnpm build && pnpm release --dry-run` (libraries + model-fake); `pnpm release:images --mode manual` dry plan shows the gate notice.
- [ ] **Step 4: Commit** `chore(release): libraries-first release, image gate, official marketplace on`.

### Task 4: Create `capybara-hq/plugins` (maintainer + agent)

**Files (new repository):** history from core via `git filter-repo`; root `package.json` (private; scripts `lint`, `typecheck`, `test`, `check`, `verify`, `doctor:env`, `wt:new`/`wt:rm`/`wt:ls`, `pack-plugins`, `version-packages`, `release`; devDependencies `@capybara-hq/plugin-tools`, `@capybara-hq/testing`, `@capybara-hq/plugin-model-fake`, `@capybara-hq/plugin-sdk` at `^0.1.0`, vitest, biome, typescript, tsx, changesets, commitlint), `pnpm-workspace.yaml` (`plugins/*`, `tools/*`), `tsconfig*.json`, `vitest.config.ts` (node project with `@capybara-hq/testing/global-setup`, the `@capybara-hq/source` condition), `biome.json`, `commitlint.config.ts`, `.changeset/config.json` (no `fixed` groups, `access: public`), `.capybara-plugin/marketplace.json` (`name: "capybara-official"`, owner "Capybara", no entries yet), `AGENTS.md` + `CLAUDE.md` (`@AGENTS.md`), `README.md`, `LICENSE`, `NOTICE`, `.github/CODEOWNERS` (`* @capybara-hq/maintainers`), `.github/workflows/{community,cla,ci,release}.yml`, `.agents/skills/*` (synced shared skills + the author half of the writing skills), `.claude/skills` symlink, `.claude/settings.json` + `.claude/hooks/branch-safety.sh` (from core), `tools/{ci,dev,worktree,checks}` (copies, Decision 8); per plugin: `package.json` `repository.url` `git+https://github.com/capybara-hq/plugins.git`, `homepage` under the new repository, devDependencies from npm instead of `workspace:`, `tsconfig.json` references.

**Steps:**
- [ ] **Step 1 (agent): history.** In a fresh clone of core at the merge of PR 1 and PR 2: `git filter-repo --path plugins/anthropic/ --path plugins/openai/ … --path plugins/example-board/ --replace-message <file mapping (?<!\w)#(\d+) to capybara-hq/core#\1>`, every plugin except `model-fake`; also keep the history of the tests A3a moved out of `packages/kernel/test` into `plugins/<name>/test`: derive the list with `git diff -M --name-status 55f71a1..<A3a merge> -- packages/kernel/test` (the Task 3 report table) and pass, for each old path, `--path <old> --path-rename <old>:<new>` so the pre-move commits land at the new location (check the old paths with `git log --follow` in core first; a file split in two needs both renames); check `git log --stat` touches nothing outside `plugins/` (after renames), `git log --follow` reaches pre-A3a commits on a moved test (for example a `slack*.dual` test), no tags left. Record the core commit it was cut from in the first scaffolding commit's body.
- [ ] **Step 2 (agent): scaffolding commits** on top (Conventional Commits): workspace, tooling, CI, skills, docs. `pnpm install` resolves core packages from npm only once R1 is out; until then, verify locally with a temporary `pnpm.overrides` to packed core tgz files (never committed).
- [ ] **Step 3 (agent): synced skills** from `/Users/grant/Capybara/github`: `node src/sync/cli.ts --to <plugins checkout> --version v1.0.0` (the release tag core's copies record; a newer `v1.x.y` if one exists, then core syncs to it too), then `check:synced-skills` passes; the author skills are core's writing skills trimmed to their author half (spec §6.2: core keeps the kernel half), descriptions within 1024 characters (`check:skills-frontmatter`).
- [ ] **Step 4 (maintainer): repository.** Create `capybara-hq/plugins` (public, Apache-2.0, default branch `main`, Discussions as in core), push `main` (allowed: no ruleset yet), enable private vulnerability reporting, add secrets `NPM_TOKEN` and `RELEASE_PR_TOKEN`, add the repository to the CLA signatures setup (`cla.yml` uses its own `cla-signatures` branch).
- [ ] **Step 5 (maintainer): settings.** Open a first PR (e.g. the README) with an issue so `community.yml` sets an `issue-linked` status (the settings script refuses rulesets until a gate workflow exists and one status was seen), then from `/Users/grant/Capybara/github`: `node src/settings/cli.ts apply capybara-hq/plugins --prune`, then `node src/settings/cli.ts check capybara-hq/plugins` → "no drift" (labels, rulesets `main-quality` / `main-review` / `main-merge`, CODEOWNERS mention, private reporting).

**Interfaces (the plugins repository):**
- CI plan (`tools/ci/src/affected.ts`, unit-tested): PRs run, by diff, the tests of each changed plugin plus the plugins that depend on it (by `plugin.json` dependencies and workspace devDependencies); `package.json`, `pnpm-lock.yaml`, `vitest.config.*`, `tsconfig*.json`, `.github/**`, `tools/**` run everything; docs-only diffs skip tests; pushes to `main` run everything. A core library upgrade (lockfile) runs everything.
- `ci.yml` jobs, all feeding `ci-ok`: `changes`; `ci` (full: `pnpm lint`, `pnpm typecheck`, `capybara-plugin check --base "$(git rev-parse HEAD^1)"` on PRs, `check:synced-skills`, `check:skills-frontmatter`, `capybara-plugin marketplace --check`, `pnpm pack-plugins` as an artifact, commitlint); `test` (by diff, Docker available for the sandbox-docker and testcontainers tests; live tests skip without their env vars).
- `pnpm doctor:env` (node, pnpm, docker, gh, remotes) and `pnpm verify` (lint, typecheck, check, marketplace check, commitlint, the planned tests) print core's contract (`--json`).
- `release.yml`: `version-pr` (push only; changesets/action with `RELEASE_PR_TOKEN`; `pnpm version-packages` = `changeset version && capybara-plugin sync-versions && capybara-plugin marketplace --write`), `publish` (fresh checkout of `github.sha`, `contents: read` + `id-token: write`; `capybara-plugin release --auto --provenance --marketplace .capybara-plugin/marketplace.json`; refuses while nothing is on npm, so the first run is a manual dispatch; uploads the packs with `SHA512SUMS` / `integrity.json`). A workflow test pins the layout like core's `tools/release/test/workflow.test.ts`.
- AGENTS.md: repository map, dependency rules (plugins → SDK; tests → SDK, testing, model-fake, the plugin itself; enforced by `capybara-plugin check`), the CI table with full / diff per check, release, live tests, "contract changes need a PR in core first".

- [ ] **Step 6:** Locally against packed core 0.1.0 candidates: `pnpm verify` green, `pnpm exec vitest run plugins` green (sandbox-docker with Docker), `capybara-plugin marketplace --check` reports every plugin missing (expected before R2's PR).
- [ ] **Step 7: Commits** in the new repository: `chore: import the official plugins from capybara-hq/core`, `ci: …`, `docs: …` (one per area).

### Task 5: R1 — core libraries 0.1.0 (maintainer)

- [ ] **Step 1:** Prerequisites in `docs/deploy/release.md` (npm scope, `NPM_TOKEN`, `RELEASE_PR_TOKEN`, environments); `pnpm changeset status` empty on `main`.
- [ ] **Step 2:** Actions → Release on core `main` with `dry_run: true`: npm plan = `plugin-sdk`, `kernel`, `testing`, `plugin-tools`, `plugin-model-fake`; images: dry-run builds pass; nothing pushed.
- [ ] **Step 3:** Run with `dry_run: false`. Check: `npm view @capybara-hq/<each> version` is 0.1.0 with provenance (`npm view --json … dist.attestations`); the image jobs planned nothing (gate notice in the run summary); no tag `v0.1.0` yet.
- [ ] **Step 4:** Merge freeze on core `main` for anything but Task 7 until R3 (a push before then publishes nothing new to npm and no image, but keep the window simple).

### Task 6: R2 — plugins 0.1.0 from `capybara-hq/plugins` (agent PR + maintainer dispatch)

- [ ] **Step 1 (agent):** In the plugins repository, drop the temporary overrides, `pnpm install` from npm, then a PR "chore: marketplace entries for 0.1.0": `capybara-plugin marketplace --write` (every public plugin at 0.1.0 with its sha512). CI green: `ci-ok`, `issue-linked`; `pnpm verify` green locally (Review Focus 5). Merge (maintainer).
- [ ] **Step 2 (maintainer):** Release workflow `dry_run: true`, then `dry_run: false` (first run is manual: auto refuses while nothing is on npm). The publish job refuses any pack whose sha512 differs from `marketplace.json` (Review Focus 2).
- [ ] **Step 3:** Check: `npm view @capybara-hq/plugin-<name>@0.1.0 dist.integrity` equals `marketplace.json` for each; provenance names `capybara-hq/plugins` and the workflow; `example-*` not published. Record the `main` commit that carries these entries (it becomes `marketplace.commit`).

### Task 7: Core moves the plugins out (core PR 3)

**Files:**
- delete `plugins/{anthropic,openai,openai-compatible,connector-mcp,connector-openapi,slack,lark,sandbox-docker,sandbox-e2b,object-store-s3,todo,example-counter,example-board}`; root `package.json` (their devDependencies), `pnpm-lock.yaml`, `tsconfig.json` references, `tsconfig.test.json`, `vitest.config.ts` (unchanged include still finds `plugins/model-fake`), `biome.json` if it lists them;
- `packages/kernel/bootstrap.json`: both entries `"source": "npm"`, `"npm": "@capybara-hq/plugin-<name>"`, version 0.1.0, the published integrity, and `"marketplace": { "url": "https://github.com/capybara-hq/plugins.git", "commit": "<Task 6 commit>" }`;
- `tools/checks/src/bootstrap.ts` + `bootstrap-network.ts` (`bootstrap-compose-ref` offline; `bootstrap-haproxy` and the official-URL rule online; Decisions 4–6), `tools/checks/src/compose-haproxy.ts` (drop `compose-haproxy-copy`), `tools/checks/src/test-plugins.ts` (`OFFICIAL_EXCEPTIONS` empty), their tests and fixtures (the bootstrap tests move to fixture manifests with `fake-bootstrap-a` / `-b` and the fake npm registry; no real plugin directory is packed);
- `tools/ci/test-plugins.json` (`model-fake` only), `tools/ci/src/affected.ts` (no workspace bootstrap entries to read: a `bootstrap.json` change runs `apps/capybara`, e2e and docker; `docker/sandbox-proxy/**` joins the network-check triggers), `tools/ci/test/affected.test.ts`;
- `apps/capybara/test/bootstrap.test.ts` (fixture manifest of fakes packed with `packFixture`; the real manifest is exercised by e2e and the docker smoke), `apps/web/e2e/global-setup.ts` (`pnpm pack-bootstrap --registry` downloads the pinned packages), `docker/kernel.Dockerfile` (npm entries: `pack-bootstrap --registry "$NPM_REGISTRY"`, build arg, network at build time only), `.dockerignore`;
- `docker/compose.yaml`, `docker/compose.dev.yaml` (git build contexts at `marketplace.commit`, Decision 4; comments), `docker/test/*.sh` if they reference moved paths;
- AGENTS.md per spec §6.5 (repository map without the moved plugins; dependency chain; "Plugins" and author rules point to `capybara-hq/plugins`; CI table without plugin rows; `check:test-plugins`, `check:compose-haproxy`, `check:bootstrap` texts), `.agents/skills/*` (core keeps the kernel half of each writing skill and points to the plugins repository's author skills), `docs/deploy/*`, `.github/workflows/ci.yml` comments (and the "Pack all official plugins" step packs `model-fake` and the fakes only), the spec's acceptance status.

**Interfaces:** `check:bootstrap --network` is required on this PR (it changes `bootstrap.json`) and green against npm and the plugins repository; the docker job builds the kernel image from npm pins and runs the compose smoke (attachments through the npm `object-store-s3`).

- [ ] **Step 0 (accepted pins):** the npm kernel 0.1.0 published in R1 ships `bootstrap.json` (kernel `files`) with workspace entries, which the kernel reads as its default manifest (`packages/kernel/src/extensions/bootstrap.ts`). This PR rewrites it to npm pins without a kernel release, so npm kernel 0.1.0 keeps pins that match no published tarball. Accepted for 0.1.0: the pins are used only by the image build and `capybara bootstrap`, and images build from the tree. Plan a kernel patch release (0.1.1, with a changeset) after R3 that ships the npm pins; schedule it in Task 8.
- [ ] **Step 0b (Dockerfile registry):** `docker/kernel.Dockerfile` gets `ARG NPM_REGISTRY` (default the public registry) passed to `pack-bootstrap --registry`; its header comment (which no longer claims an env var) is updated to name the build argument.
- [ ] **Step 1:** Red: the new check rules (`bootstrap-compose-ref`, `bootstrap-haproxy`, the official URL) with fixtures; `affected.test.ts` for the new mapping.
- [ ] **Step 2:** Implement and delete; `pnpm check:bootstrap --network` green; `pnpm check:test-plugins` lists only `model-fake`.
- [ ] **Step 3:** `pnpm verify` (full: root files change, so everything runs), web e2e, `bash docker/test/compose-smoke.sh`, `docker compose --profile sandbox build` from the git contexts.
- [ ] **Step 4: Commit** `refactor!: official plugins live in capybara-hq/plugins` (body: the plugins repository commit and the core commit the history was cut from). No changeset (R3 publishes images at `apps/capybara` 0.1.0; the npm libraries are unchanged by this PR except `packages/kernel/bootstrap.json`, which the image reads from the repository).

### Task 8: R3 — core images 0.1.0 and acceptance (maintainer + agent)

- [ ] **Step 1:** Merging Task 7 pushes to `main`: the image planner (npm already released, gate open) builds and pushes the four 0.1.0 images; if that run is cancelled or fails, a manual dispatch builds the missing tags. Then the tag `v0.1.0` and its GitHub release; set the four packages public (`docs/deploy/release.md` prerequisite 8).
- [ ] **Step 2:** End-the-freeze check: `npm view` for the five core packages and every plugin at 0.1.0; `docker buildx imagetools inspect ghcr.io/capybara-hq/capybara-api:0.1.0`; a fresh `docker compose up` at tag `v0.1.0` bootstraps both plugins offline (no network at init) and the admin console lists the official marketplace (enabled) with every plugin, the bootstrap plugins shown as installed.
- [ ] **Step 3:** The M7 live acceptance checklist (`docs/superpowers/plans/m7-live-acceptance-checklist.md`), whose "install `@capybara-hq/plugin-slack` from npm" step now installs the plugins repository's release; mark the spec §12 phase A items done with their evidence.
- [ ] **Step 4:** A test PR in the plugins repository (e.g. a todo docs change with a changeset) shows `pnpm verify`, `ci-ok` and `issue-linked` green and the Version Packages PR appending a `marketplace.json` entry — the last phase A acceptance item. Do not merge its Version Packages PR as part of acceptance.

## Carried from A3a (ledger "Carry to A3b" and deferred minors)

| Item | Where |
|---|---|
| Ruling 4: `connector-openapi-wizard.spec.ts`, `embed-board.spec.ts` | Task 2 (Decision 3) |
| Ruling 5 / Task 3 carry: plugin tests resolve `model-fake` from npm | Task 1 (Decision 2), Task 4 Step 6 |
| Task 3 carry: `compose-haproxy-copy` moves / drops with sandbox-docker | Task 7 (Decision 5) |
| Ruling 7: npm token for bootstrap downloads; enforce the official `marketplace.url` | Task 1, Task 7 (Decision 6) |
| Task 5 minors: unbounded npm tarball download, abbreviated packument accept header, tgz name / version not checked | Task 1 |
| Task 3 minors: `plugin-test-imports` misses bare `..` and package names as plain strings; stale `OFFICIAL_EXCEPTIONS` not reported | Task 1, Task 2 |
| Task 2 minor: global-setup comment "move with plugins" | Task 2 |
| Task 3 minor: stale Chinese comment in `plugins/sandbox-docker/test/docker-env.ts` | Task 4 Step 2 (the plugins repository's first docs commit) |
| Task 5 minors: `integrityOf` duplicated in `tools/checks`; defensive `ConfigError` in `syncOfficialFromConfig` untested; sync tests for http → git and an unchanged URL keeping `last_commit` | Task 7 (touches the same files) |
| Task 2 / 3 minors not tied to the split (fake-connector `kind` untested at kernel level, hard-coded fixture paths in `tools/checks` tests, `sandbox-artifacts` host-global `pkill`, fake-im deep relative imports in kernel fixtures, `affected.test` kernel→plugin case, ROOTED_STRING fragility) | Left to a later cleanup PR; not required for the split |
