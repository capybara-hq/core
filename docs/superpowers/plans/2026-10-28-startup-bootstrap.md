# Startup Bootstrap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a starting kernel installs the bootstrap plugins itself, from an optional offline directory or from npm, so `pnpm pack-bootstrap` and `--bootstrap-dir` disappear and the image carries no packages.

**Architecture:** `BootstrapService.run` stops reading a mandatory directory before the lock; after the lock and the "done" re-check it resolves every entry's bytes (offline directory matched by sha512, else `fetchNpmPackage` with the pinned integrity), then installs as today. The CLI always runs it on `start`, with the directory from the new config key `bootstrap.dir`.

**Tech Stack:** TypeScript, Kysely/pg, vitest, `@capybara-hq/testing` (`startFakeNpmRegistry`, `startTestKernel`, dual-replica), Docker, GitHub Actions plan in `tools/ci`.

**Spec:** `docs/superpowers/specs/2026-10-28-startup-bootstrap-design.md`

## Global Constraints

- Config key `bootstrap.dir`, env `CAPYBARA_BOOTSTRAP__DIR`, default `"bootstrap"`, resolved against `process.cwd()` by the CLI; not hot; follow `.agents/skills/adding-config` (regenerate `docs/config.md`).
- New error code `bootstrap.download_failed` → 502, registered in `packages/kernel/src/errors.ts`.
- Downloads use `fetchNpmPackage` (`packages/kernel/src/packages/npm.ts`) with `expectedIntegrity = entry.integrity`; nothing else is trusted.
- Already done (`bootstrap_runs` row for the manifest sha256) ⇒ no directory read, no network.
- All bytes are obtained (and checked) before the first write; downloads happen inside the advisory lock.
- English for code comments, docs, commits; Conventional Commits, body lines ≤ 100; identity `git -c user.name=Grant -c user.email=284885069@qq.com`; trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Never run CI/action code against the real home directory; no force-push.

## Review Focus

- A restart of a bootstrapped deployment with the network down must start (done check first) — test with a registry that refuses every request.
- A file in the offline directory with the right name but wrong bytes must not be used, and must not block the npm fallback (matching is by sha512 only).
- A download whose bytes differ from the pin → `bootstrap.integrity_mismatch`, nothing written.
- Two replicas starting together on a fresh database download once (count registry tarball requests in the dual-replica test).
- The registry token is sent only to the registry origin (already enforced by `fetchNpmPackage`; keep a test that the bootstrap path passes `packages.npmToken`).

---

### Task 1: Kernel — resolve packages at run time

**Files:**
- Modify: `packages/kernel/src/extensions/bootstrap.ts` (`run`, replace `verifyFiles`; header comment)
- Modify: `packages/kernel/src/config/schema.ts` (`bootstrap.dir`), `docs/config.md` (regenerated)
- Modify: `packages/kernel/src/errors.ts` (`bootstrap.download_failed`: 502)
- Modify: `packages/kernel/src/kernel.ts` (`bootstrapDir` option doc: optional directory; the step runs when `bootstrap` is requested even if the directory does not exist)
- Test: `packages/kernel/test/extensions/bootstrap.test.ts`, `bootstrap.dual.test.ts`

**Interfaces:**
- Produces: `BootstrapService.run(o: { manifest; dir?: string; signal?; carry? })` — `dir` optional; `KernelOptions.bootstrap?: { dir?: string }` replacing `bootstrapDir?: string` (when present the start runs the step).
- Produces: `resolveBootstrapPackages(manifest, { dir?, config, fetch? }): Promise<Map<string, Uint8Array>>` (exported from `extensions/bootstrap.ts` for the CLI's tests).

- [ ] Step 1: failing tests in `bootstrap.test.ts`: (a) empty dir + fake registry serving the packed fixture → `installed`, registry saw one tarball request per entry; (b) file in dir with any name matching the integrity → no registry request; (c) file named `<name>-<version>.tgz` with other bytes + registry serving the right bytes → installed from npm; (d) registry serving other bytes → `bootstrap.integrity_mismatch`, no `extension_installs` row; (e) registry down → `bootstrap.download_failed`, message names the registry origin and the directory; (f) workspace entry without file → `bootstrap.missing_file`; (g) run recorded, registry down, dir missing → second `run` returns the recorded result with zero registry requests; (h) `packages.npmToken` reaches the registry as `authorization`.
- [ ] Step 2: run them, see them fail.
- [ ] Step 3: implement: `run` re-checks done inside `locked`, then `resolveBootstrapPackages`, then the existing loop. Map `IntegrityMismatchError` → `bootstrap.integrity_mismatch`, other `NpmFetchError` / `PackageTooLargeError` / network errors → `bootstrap.download_failed`. Directory scan: `readdir` non-recursive, `*.tgz`, skip > `packages.maxBytes` with a warn, hash each once.
- [ ] Step 4: dual-replica test: fresh DB, two replicas start with `bootstrap: {}` against one fake registry → one tarball request per entry total, both serve.
- [ ] Step 5: `pnpm exec vitest run packages/kernel/test/extensions/bootstrap*.test.ts` passes; update every other caller of `bootstrapDir` (`packages/testing/src/dual-replica.ts`, `replica-runner.ts`, kernel tests listed by `grep -rln bootstrapDir`).
- [ ] Step 6: commit `feat(kernel): the bootstrap step downloads its packages from npm at start`.

### Task 2: CLI — always bootstrap on start

**Files:**
- Modify: `apps/capybara/src/commands/start.ts`, `commands/bootstrap.ts` (drop `DEFAULT_BOOTSTRAP_DIR` / `startBootstrapDir`; dir = `--dir` ?? `resolve(cwd, config.bootstrap.dir)`), `src/args.ts` (remove `--bootstrap-dir`; USAGE), `src/cli.ts`
- Test: `apps/capybara/test/{args,start,bootstrap}.test.ts`

- [ ] Step 1: tests: `start` passes `bootstrap: { dir: <cwd>/bootstrap }` by default and `CAPYBARA_BOOTSTRAP__DIR` overrides it; `--bootstrap-dir` is a usage error; `capybara bootstrap` against a fake registry and an empty dir installs; `--dir` with a matching file needs no registry.
- [ ] Step 2: fail → implement → pass.
- [ ] Step 3: commit `feat(cli): capybara start always runs the bootstrap step`.

### Task 3: Image, e2e, smoke tests, toolchain, CI plan

**Files:**
- Modify: `docker/kernel.Dockerfile` (no download, no `NPM_REGISTRY` / `NODE_USE_ENV_PROXY` args; `mkdir /app/bootstrap`), `docker/compose.yaml` (comments; optional commented volume for an offline directory), `docker/test/kernel-image.sh`, `docker/test/compose-smoke.sh`, `docker/test/web-image.sh` as needed (the kernel now downloads at start; keep the registry overridable through `CAPYBARA_PACKAGES__NPM_REGISTRY`)
- Modify: `apps/web/e2e/global-setup.ts` (drop `pack-bootstrap`; pass `CAPYBARA_PACKAGES__NPM_REGISTRY` and no `--bootstrap-dir`)
- Modify: root `package.json` (remove `pack-bootstrap`), `packages/plugin-tools` (remove `pack --bootstrap` and options only it uses, its tests and README; keep `src/pack/npm.ts`)
- Modify: `tools/ci/src/affected.ts` + `tools/ci/test` (the docker job no longer depends on `packages/plugin-tools` for the image download; keep `bootstrap.json` → apps/capybara, e2e, docker)
- Modify: `tools/release` only if a gate reads `/app/bootstrap` (the workspace-entry gate stays)
- Modify: `.gitignore` (`/bootstrap/`)
- Create: changesets — `@capybara-hq/kernel` patch, `@capybara-hq/plugin-tools` patch (removes `pack --bootstrap`), `@capybara-hq/capybara` patch

- [ ] Step 1: `grep -rn "pack-bootstrap\|--bootstrap-dir\|/app/bootstrap\|pack --bootstrap" --exclude-dir=node_modules .` lists every caller; fix each.
- [ ] Step 2: `pnpm lint && pnpm typecheck && pnpm check` and `pnpm exec vitest run tools packages/plugin-tools apps/capybara` pass.
- [ ] Step 3: build the kernel image locally if Docker is available (`docker build -f docker/kernel.Dockerfile .`), else leave it to CI.
- [ ] Step 4: commit `refactor: the image carries no bootstrap packages; remove pack-bootstrap`.

### Task 4: Docs

**Files:** `AGENTS.md` (every mention of pack-bootstrap, `/app/bootstrap`, "only the image build … download", the plugin-tools row, the CI table rows), `README.md` (dev flow: no pack-bootstrap / --bootstrap-dir; offline paragraph rewritten around `bootstrap.dir` and `npm pack`), `docs/deploy/*.md` (offline / mirror / mounted directory), `.agents/skills/writing-plugins/SKILL.md`, `.agents/skills/writing-extensions/SKILL.md`, `docs/superpowers/plans/2026-10-27-manual-acceptance-checklist.md` (start steps).

- [ ] Step 1: edit; `pnpm check` (terms, skills frontmatter) passes.
- [ ] Step 2: commit `docs: bootstrap plugins are installed by a starting kernel`.
