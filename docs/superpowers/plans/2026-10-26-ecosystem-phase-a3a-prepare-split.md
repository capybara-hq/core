# Package Ecosystem Phase A3a: Prepare the Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the move of the official plugins out of core a mechanical step: core's own tests stop depending on official plugins (except `model-fake`), plugin behaviour tests live inside their plugins, the plugin toolchain becomes a publishable `@capybara-hq/plugin-tools`, and the official-marketplace and npm-bootstrap paths are ready — while every plugin stays in core and nothing is published.

**Architecture:** Fakes replace official plugins in core tests (one or more per extension point, in core); tests that exercise a real plugin's behaviour move to `plugins/<name>/test` and may use only `@capybara-hq/testing` + the SDK. `tools/pack-plugin` and the plugin-scoped checks and the npm half of `tools/release` become `packages/plugin-tools` (bin `capybara-plugin pack | check | release`), used by core's own scripts so they stay tested. The kernel's official-marketplace sync handles git URLs; the image build and `check:bootstrap` learn npm entries (verified by sha512, network only at build/check time).

**Tech Stack:** TypeScript pnpm monorepo, vitest, the dual-replica harness, `@capybara-hq/testing` fakes, esbuild (pack), oxc-parser (checks), Docker.

**Spec:** `docs/superpowers/specs/2026-10-22-package-ecosystem-design.md` §6.2 (plugin-tools), §6.3 (core tests after the split), §6.4 (release of the plugins repo, npm half), §5.5 (official marketplace), §7 (npm bootstrap entries, `check:bootstrap` network mode), §12. Decision 2026-10-26: phase A3 is split — A3a now (this plan), A3b (create `capybara-hq/plugins`, move the plugins, first release) after the UI work, phases B–D and manual acceptance.

## Global Constraints

- **Nothing is published and no repo is created in A3a.** Plugins stay under `plugins/*`; `bootstrap.json` keeps its workspace entries; `marketplaces.official.enabled` stays `false` (the repo doesn't exist yet).
- **After A3a, the only official plugin core tests may load is `model-fake`** (it stays in core, spec §6.1). `tools/ci/test-plugins.json` lists nothing else for `packages/kernel/test`, `packages/testing/test`, `apps/capybara/test`, `tools/checks/test`, `apps/web/e2e`; `check:test-plugins` enforces it with a new rule (`test-plugins-official`, red-proven). Exceptions while plugins live in core: `packages/kernel/bootstrap.json` workspace entries (and the tests that pack the real manifest) — listed in the check with that reason.
- **Plugin behaviour tests move with their plugin**: a test whose subject is a real plugin's behaviour (Slack/Lark protocol, MCP / OpenAPI protocol, Docker sandbox, S3 semantics, todo tools, example-board embed) moves to `plugins/<name>/test/` and imports only `@capybara-hq/plugin-sdk`, `@capybara-hq/testing` and the plugin itself (no `packages/kernel/src` imports, no relative paths into core). Where a moved test needs a kernel facility not exported by `@capybara-hq/testing`, add the minimal export to testing (documented) rather than reaching into the kernel.
- **Kernel contract coverage stays in core** on fakes: what a kernel test asserted through a real plugin (catalog template checks against a loaded connector, channel inbound/outbound, connector sessions, sandbox lifecycle, storage service) is asserted through a core fake.
- **Fakes live in `packages/testing/fixtures/extensions/<name>`** (pack layout: `package.json`, `.capybara-plugin/plugin.json`, `src/index.ts`) so the plugins repo can reuse them later; existing kernel-only fixtures under `packages/kernel/test/fixtures/plugins/*` stay where they are.
- `@capybara-hq/plugin-tools` is a published package (not private): README, `files`, NOTICE, repository metadata per `check:release-metadata`; it may depend on `@capybara-hq/kernel` (package readers, SQL helpers) and `@capybara-hq/plugin-sdk`. Core's `pnpm pack-plugin`, `pack-plugins`, `pack-bootstrap`, `check:*` plugin checks and `pnpm release` npm half call into it.
- Frozen names and migration rules as in earlier plans. English comments; Conventional Commits, body ≤ 100, `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. One changeset `.changeset/ecosystem-phase-a3a.md` (patch: kernel, testing, plugin-tools, capybara as touched). Tests from the repo root.

## Review Focus

1. **Coverage lost in the move**: for every test that stops loading an official plugin, the kernel behaviour it covered is still asserted (on a fake) or now lives in the plugin's own tests. Task 1–3 reports carry a table: old test → new home.
2. **A moved plugin test that secretly depends on core internals** (relative import into `packages/kernel/src`, a core fixture path): it would break in the plugins repo. A check enforces it (Task 3).
3. **`capybara-plugin check` on a directory that is not this repo** (a temp dir with one plugin): it must find the plugin and run every plugin check, without `plugins/*` assumptions. Task 4 tests it.
4. **npm bootstrap entries**: a tampered or unpublished package fails the image build and `check:bootstrap`, never init. Task 5 tests it with the fake npm registry.
5. **Official marketplace as a git URL**: sync stores `form: git`, refuses mirrors with a clear config error, and stays disabled by default. Task 5 tests it.

---

### Task 1: Core fakes per extension point

**Files:** Create `packages/testing/fixtures/extensions/{fake-connector, fake-object-store, fake-tools-ui, fake-embed, fake-bootstrap-a, fake-bootstrap-b}/**`, `packages/testing/src/fixtures.ts` (exported paths + a `packFixture(name, outDir)` helper using plugin-tools/pack-plugin), tests under `packages/testing/test/fixtures.test.ts`.

**Interfaces (what each fake must cover — derived from the A3 inventory):**
- `fake-connector` (`connector@1`, HTTP to `startFakeMcpServer`-like server or in-memory): `endpointSchema`, `inspect` + preview, `open`/`close`, `auth()` + one `onUnauthorized` retry, `listTools`/`callTool`, `onToolsChanged`, `onElicit`, `connectorData`; plus a connector template file it accepts. Replaces connector-mcp/openapi in kernel catalog/connector/OAuth tests.
- `fake-object-store` (`object-store@1`, in-memory with presign that the kernel's storage tests and attachments HTTP tests can use — or backed by `startTestS3` through a minimal S3 client; builder's choice, documented): replaces object-store-s3 in kernel tests (attachments, skills, catalog, sandbox tools, evals).
- `fake-tools-ui` (tools + `ui.views` + migrations + a connector template + a skill + `permissions.storage`): replaces todo in UI / tools / catalog-package tests and the CLI test.
- `fake-embed` (`ui.embeds`): replaces example-board in embed tests.
- `fake-bootstrap-a` / `-b` (one model-provider-like extension, one object-store-like extension; pack layout): replace openai-compatible / object-store-s3 in bootstrap tests that use a test manifest.
- A dependency pair (requires/provides) replaces example-counter where tests need a dependency (reuse existing `dep-provider`/`dep-requirer` fixtures if they fit).

- [ ] **Step 1:** Failing tests: each fake packs with pack-plugin and reads back with `readPluginPackage`; each loads in a kernel test harness and provides its point.
- [ ] **Step 2:** Implement. **Step 3:** PASS; `pnpm check`. **Step 4: Commit** `test(testing): fake extensions per extension point`.

### Task 2: Kernel and CLI tests onto fakes

**Files:** every kernel / CLI / testing / tools/checks test listed in the A3 inventory as loading anthropic, openai, openai-compatible, object-store-s3, connector-mcp, connector-openapi, slack, lark, sandbox-docker, sandbox-e2b, todo, example-counter, example-board (except the tests moved in Task 3); `packages/kernel/test/helpers/plugin-packages.ts` (`packOfficialPlugin` removed; `packFixture` used); `tools/ci/test-plugins.json`; `apps/web/e2e/global-setup.ts` and e2e specs (connector-mcp/openapi/todo/example-board → fakes; the e2e bootstrap keeps the real manifest — allowed exception).

- [ ] **Step 1:** For each converted test, keep its assertions about kernel behaviour; record the old → new mapping in the report (Review Focus 1).
- [ ] **Step 2:** Convert; run each converted file; `pnpm exec vitest run packages/kernel packages/testing apps/capybara tools/checks` (background for the kernel); e2e locally.
- [ ] **Step 3: Commit** `test: core tests use core fakes instead of official plugins`.

### Task 3: Plugin behaviour tests move into their plugins; boundary check

**Files:** move into `plugins/<name>/test/`: slack (`slack*.dual`, `m4-segment2-slack.dual`, `m7-segment1.dual` slack parts), lark (`lark*.dual`, `m4-segment2-lark.dual`), connector-mcp (`mcp-e2e`, `mcp-interaction-e2e`, MCP parts of `m3-segment*.dual`, `m3-live`, OAuth e2e that need MCP), connector-openapi (`openapi-e2e`, openapi parts of `m3-*`), sandbox-docker (`sandbox-docker.smoke`, docker parts of `m5-segment2.dual`), object-store-s3 (S3 semantics tests), todo / example-board (their UI behaviour); `packages/testing/src/index.ts` (any minimal new exports, documented); `tools/checks/src/test-plugins.ts` (new rule `test-plugins-official` + a rule `plugin-test-imports` that a test under `plugins/*/test` imports nothing from core paths), fixtures, AGENTS.md CI section, `tools/ci/src/affected.ts` (plugin tests run when the plugin or testing changes — already true; verify).

- [ ] **Step 1:** Red-first tests for both new check rules (violating fixtures).
- [ ] **Step 2:** Move tests, adapt to `@capybara-hq/testing` only; where a facility is missing, export it from testing; run each plugin's tests.
- [ ] **Step 3:** `pnpm check` (the two new rules green on the real repo), `pnpm exec vitest run plugins packages/testing`.
- [ ] **Step 4: Commit** `test: plugin behaviour tests live in their plugins`.

### Task 4: `@capybara-hq/plugin-tools`

**Files:** Create `packages/plugin-tools/` (`package.json` published, `bin: { "capybara-plugin": "dist/cli.mjs" }`, README, NOTICE, `src/{pack/*, check/*, release/*, cli.ts}`, tests); move code from `tools/pack-plugin` (pack, bootstrap pack), `tools/checks` (deps plugin-boundary, plugin-state, plugin-permissions, plugin-pack, tool-design, migrations incl. applied-migrations for `plugins/*/migrations`, plugin-versions sync, source.ts, report), `tools/release` npm half (`planPublish`, `distTagFor`, `runPublish`, `integrityOf`); core's `tools/pack-plugin`, `tools/checks`, `tools/release` become thin callers (or are removed where fully replaced) — root scripts keep their names; `check:release-metadata` (plugin-tools published: README/files/NOTICE); AGENTS.md (repository map, dependency chain); `.github/workflows/release.yml` (publishes plugin-tools with the libraries; `tools/release/test/workflow.test.ts`).

**Interfaces:** `capybara-plugin pack [<dir>…] [--all <root>] [--out <dir>]`; `capybara-plugin check [--root <dir>] [--plugins <glob>]` (runs every plugin-scoped check; default plugin discovery: `<root>/plugins/*` if present, else `<root>` itself when it has `.capybara-plugin/plugin.json`); `capybara-plugin release [--dry-run] [--provenance] [--out <dir>] [--auto]` (npm half only; images stay in core).

- [ ] **Step 1:** Failing tests: Review Focus 3 (temp dir with one plugin outside this repo: `check` finds it and reports a seeded violation; `pack` produces a reproducible tgz); release planning tests moved and green.
- [ ] **Step 2:** Implement/move; core scripts delegate. **Step 3:** `pnpm check`, `pnpm exec vitest run packages/plugin-tools tools`, `pnpm pack-plugins`, `pnpm release --dry-run` (no publish). **Step 4: Commit** `feat(plugin-tools)!: publishable plugin toolchain`.

### Task 5: Official marketplace as git, npm bootstrap entries

**Files:** `packages/kernel/src/catalog/marketplaces.service.ts` (`syncOfficialFromConfig` stores `form` via `marketplaceForm()`, refuses mirrors on a git official URL with a config error naming the field), `config/schema.ts` (default URL `https://github.com/capybara-hq/plugins.git`, `enabled` default stays `false`; descriptions updated), web copy for the official marketplace state, tests; `packages/plugin-tools` bootstrap pack: npm entries downloaded from `packages.npmRegistry` (or `--registry`), verified by sha512, written to the out dir; `docker/kernel.Dockerfile` (comment: npm entries need network at build time only); `tools/checks/src/bootstrap.ts` (network mode: for npm entries fetch the packument + tarball and compare version + integrity; when `marketplace` is present, read `.capybara-plugin/marketplace.json` at `marketplace.commit` via the git reader and check each entry appears at the same version and integrity; runs by diff on PRs (when `bootstrap.json` changes), always on main and in release — state it in AGENTS.md / ci.yml; red fixtures with the fake npm registry and fake git server).

- [ ] **Step 1:** Failing tests for Review Focus 4–5.
- [ ] **Step 2:** Implement. **Step 3:** PASS; `pnpm check`. **Step 4: Commit** `feat: official marketplace via git, npm bootstrap entries`.

### Task 6: Docs, plan A3b, acceptance

- [ ] **Step 1:** Docs: AGENTS.md (repository map, dependency chain, CI rows for the new rules and plugin tests), skills (writing-* point to `capybara-plugin`; kernel-side parts marked "stays in core" for the split), docs/deploy (official marketplace URL), the spec (§6 as built for A3a; A3b steps).
- [ ] **Step 2:** Write `docs/superpowers/plans/<date>-ecosystem-phase-a3b-split-release.md`: create `capybara-hq/plugins` (settings script, synced skills, community/cla/CODEOWNERS, doctor:env/verify, ci-ok), move `plugins/*` except `model-fake`, plugins-repo release (version PR writes marketplace.json integrity), core first release order (SDK/kernel/testing/plugin-tools → plugins → bootstrap.json npm entries + marketplace commit → images), switch official marketplace on. A3b is executed after manual acceptance.
- [ ] **Step 3:** Acceptance: `check:test-plugins` shows no official plugin outside the allowed exceptions; `pnpm verify`; e2e; compose smoke.
- [ ] **Step 4: Commit** `docs: plugin-tools, fakes and the A3b plan`.
