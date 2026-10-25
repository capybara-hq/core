# Package Ecosystem Phase A2: Bootstrap Plugins and Egress Proxies Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the CLI's built-in extensions with plugins pinned in `packages/kernel/bootstrap.json`, installed by an idempotent bootstrap step from tgz files baked into the image, and let marketplace and git downloads go through an HTTP(S) egress proxy.

**Architecture:** The SDK gains the bootstrap manifest parser and schema. The kernel gains a `BootstrapService` that, under a PG advisory lock, reads each pinned tgz from a directory, verifies its sha512, imports it into the catalog and installs + approves + enables it (source `bootstrap`), keeping `required` plugins enabled in every org and non-removable. The CLI drops its plugin dependencies and gains `capybara bootstrap`, run by compose's `init`; a kernel that starts without a completed bootstrap runs it once. The image's build stage packs the pinned plugins deterministically with `tools/pack-plugin` and verifies them against the manifest; when phase A3 publishes the plugins, the same manifest switches to npm downloads. The `builtin` source disappears. Separately, the net layer learns to tunnel through an HTTP CONNECT proxy.

**Tech Stack:** TypeScript, Kysely + PG migrations, NestJS kernel, `tools/pack-plugin` (reproducible tgz), Docker (kernel.Dockerfile, compose), vitest, the dual-replica harness.

**Spec:** `docs/superpowers/specs/2026-10-22-package-ecosystem-design.md` §7 (bootstrap), §12 phase A acceptance items for bootstrap, §5.1 (git access; proxy is new), Ruling 16 of plan A1 (`docs/superpowers/plans/2026-10-25-ecosystem-phase-a1-marketplaces.md` ledger: egress proxies and fake-IP DNS are A2's decision). Phase A3 (plugin-tools, fakes, the split, official marketplace on, `check:bootstrap` network mode) follows.

## Global Constraints

- **Pinned by sha512, never by trust.** The bootstrap step verifies each tgz against `integrity` before reading it; a mismatch fails the step with `bootstrap.integrity_mismatch` naming the plugin. Init never touches the network.
- **No published packages yet** (decided 2026-10-25: the first release follows phase A). Until A3 publishes the official plugins, each entry is sourced from the workspace: `"source": "workspace"` packs `plugins/<name>` with `tools/pack-plugin` (byte-reproducible) and the pinned integrity is that pack's sha512. A3 switches entries to `"source": "npm"` (the spec's shape) and adds the network half of `check:bootstrap`. Both shapes are valid manifest v1.
- **`builtin` goes away** (spec §7): the CLI no longer depends on `@capybara-hq/plugin-openai-compatible` / `-object-store-s3`; `KernelOptions.builtinExtensions` and the `builtin` extension source are removed (no aliases); `extension.builtin` becomes `extension.required` (409) for required bootstrap plugins.
- **Required plugins**: enabled in every org (existing and future) without org config rows — the kernel's `enabledPlugins(orgId)` unions the required bootstrap installs where it unions builtins today; every reader that queried `extension_org_configs` directly and missed builtins today must use the shared helper (inventory list in Task 3); not disableable or uninstallable at deployment or org level; an enterprise admin may upgrade them.
- **Proxy**: when `net.httpsProxy` is set, untrusted downloads tunnel through it with HTTP CONNECT; the kernel does not resolve the target itself (the proxy does), checks only the hostname rules (`allowedHosts`, IP-literal private ranges, `allowPrivateHosts`), and documents that SSRF protection for resolved addresses is then the proxy's job. `net.noProxy` (hostnames) bypasses it.
- Migrations from 0050, idempotent, destructive statements commented; `check:applied-migrations` forbids editing 0001–0049.
- New error codes get zh and en copy. One changeset `.changeset/ecosystem-phase-a2.md` (patch: plugin-sdk, kernel, testing, capybara). English comments; Conventional Commits, body ≤ 100, `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Tests from the repo root.

## Formats

### `bootstrap.json` v1 (SDK `packages/plugin-sdk/src/bootstrap.ts`, schema `schemas/bootstrap.v1.schema.json`)

```ts
export const BOOTSTRAP_MANIFEST_SCHEMA_VERSION = 1;
export type BootstrapEntry =
  | { name: string; source: "npm"; npm: string; version: string; integrity: string; required: boolean }
  | { name: string; source: "workspace"; path: string; version: string; integrity: string; required: boolean };
// name: CATALOG_ITEM_NAME_RE; version exact semver; integrity SHA512_INTEGRITY_RE; path "plugins/<dir>"
export interface BootstrapManifest {
  $schema?: string;
  schemaVersion: 1;
  marketplace?: { url: string; commit: string };   // required once any entry is "npm" (A3)
  plugins: BootstrapEntry[];                        // names unique
}
export function parseBootstrapManifest(json: unknown): BootstrapManifest | { errors: string[] };
export function bootstrapFileName(e: BootstrapEntry): string;  // "<name>-<version>.tgz"
```

### Database (migration 0050)

- CHECK values add `'bootstrap'` to `extension_installs.source`, `extension_packages.source`, `extension_permission_snapshots.source`, `catalog_item_versions.source`; `extension_replica_status.source` drops `'builtin'` and adds `'bootstrap'` (rows with `'builtin'` are deleted first — the status table is rebuilt by each replica's reconcile).
- `extension_installs.required boolean NOT NULL DEFAULT false`.
- `bootstrap_runs (manifest_sha256 text PRIMARY KEY, completed_at timestamptz NOT NULL, results jsonb NOT NULL)` — "bootstrap done" = a row for the current manifest hash.

### Bootstrap step rules (spec §7)

| Installed state | Action |
|---|---|
| not installed | import into the catalog (source `bootstrap`, `source_ref` `bootstrap:<name>@<version>`), install, approve (snapshot source `bootstrap`, audit `extension.permissions_approved` with `source: "bootstrap"`), enable; `required` copied |
| installed, source `bootstrap`, version lower | upgrade to the pinned version, permissions pre-approved and audited |
| installed, version higher (or source not `bootstrap`) | untouched, never downgraded; `required` still applied |
| entry removed from the manifest | not uninstalled; `required` cleared |
| a declarative entry (no extension) | imported into the catalog only |

Audit: `bootstrap.completed { manifestSha256, results: [{ name, action, version }] }`. Lock: `pg_advisory_xact_lock(hashtext('capybara.bootstrap'))` around the whole run (one transaction per entry inside a session-level lock is acceptable; the builder picks, the test proves two concurrent runs install once).

## Review Focus

1. **Two replicas starting together** on a fresh database: bootstrap runs once, both replicas end up loading the plugins. Task 3 has a dual test.
2. **A tampered tgz in the image** (one byte changed): the step refuses with the plugin's name, nothing half-installed, the kernel does not start serving with a missing required plugin (it logs and exits non-zero from `capybara bootstrap`; `start` refuses to listen while a required entry failed). Task 3 tests it.
3. **Core upgrade**: a new manifest raises a version; an admin had upgraded another plugin by hand above the manifest; a third entry was removed. Exactly the table above happens. Task 3 tests it.
4. **Org created after bootstrap** sees required plugins enabled without rows; disabling one at org or deployment level returns 409 `extension.required`. Task 3 tests it.
5. **Behind a proxy with fake-IP DNS**: a git marketplace refresh succeeds through the proxy, a private literal IP is still refused, `noProxy` hosts go direct. Task 1 tests it with a local CONNECT proxy.

---

### Task 1: Egress proxy for untrusted downloads

**Files:** Create `packages/kernel/src/net/proxy.ts`, `packages/kernel/test/net/proxy.test.ts`; modify `net/safe-fetch.ts`, `net/public-address.ts` (policy type), `config/schema.ts` (`net.httpsProxy`, `net.noProxy`), `docs/config.md`, `catalog/git-source.ts` (no change expected — it uses safeFetch), `docs/deploy/README.md` (replace the "proxies not supported" paragraph).

**Interfaces:** `NetPolicy` gains `proxy?: { url: string; noProxy: string[] }`; `safeFetch` with a proxy and a non-`noProxy` host connects to the proxy (http or https proxy URL; proxy auth from URL userinfo), sends `CONNECT host:443`, checks the response, then TLS to the target with SNI; no local DNS for the target; hostname rules still apply (IP-literal private targets refused unless allowed; `allowedHosts`).

- [ ] **Step 1: Failing tests** with a local CONNECT proxy (node `http.createServer` handling `connect`) and a local TLS target (self-signed cert generated in the test; trust it via the dispatcher's `connect.ca`): fetch through the proxy succeeds and the proxy saw `CONNECT`; a target IP literal `10.0.0.1` is refused before contacting the proxy; `noProxy` host goes direct (with local resolution + pinning); a proxy answering 403 → `net.proxy_refused`; the target is never resolved locally (inject a lookup that throws).
- [ ] **Step 2:** Run `pnpm exec vitest run packages/kernel/test/net`. Expected: FAIL. **Step 3:** Implement (undici `ProxyAgent` with `requestTls` if it supports pinning-free CONNECT, else a custom connect). **Step 4:** PASS; `pnpm check`. **Step 5: Commit** `feat(kernel): tunnel marketplace downloads through an egress proxy`.

### Task 2: Bootstrap manifest and the workspace pin

**Files:** Create `packages/plugin-sdk/src/bootstrap.ts` (+ test), `packages/kernel/bootstrap.json`, `tools/checks/src/bootstrap.ts`, `tools/checks/src/cli/bootstrap.ts`, `tools/checks/test/bootstrap.test.ts` (+ fixtures); modify `packages/plugin-sdk/src/index.ts`, API snapshot, `tools/checks/src/package-schemas.ts` (register `bootstrap.v1`), schemas, root `package.json` (`check:bootstrap`), `tools/checks/src/cli/all.ts`, `.github/workflows/ci.yml` comments, `tools/ci/src/affected.ts` if needed, AGENTS.md CI section.

**Interfaces:** Formats above. `packages/kernel/bootstrap.json` lists `openai-compatible` and `object-store-s3`, `source: "workspace"`, `required: true`, with the integrity of their deterministic packs. `check:bootstrap` (full on PRs: packs two plugins, a few seconds; part of `pnpm check`): parses the manifest; for each workspace entry packs `path` and compares version and sha512; reports `bootstrap-stale` with the expected value. Network mode (npm entries vs. the official marketplace) is A3.

- [ ] **Step 1:** Failing SDK parser tests (both entry kinds, duplicate names, bad integrity, `marketplace` required with npm entries) and check tests (clean fixture passes; a fixture with a wrong integrity reports `bootstrap-stale`; a version mismatch too). Run: FAIL.
- [ ] **Step 2:** Implement; write `bootstrap.json` with real integrities (`pnpm check:bootstrap --write` prints/updates them — add a `--write` flag). Run: PASS; `pnpm check`; `pnpm gen:sdk-api`.
- [ ] **Step 3: Commit** `feat: bootstrap.json and check:bootstrap`.

### Task 3: Kernel bootstrap service, required plugins, no more builtins

**Files:** Create `packages/kernel/src/migrations/0050_bootstrap.sql`, `packages/kernel/src/extensions/bootstrap.ts`, `packages/kernel/test/extensions/bootstrap.test.ts`, `packages/kernel/test/extensions/bootstrap.dual.test.ts`; modify `kernel.ts` (remove `builtinExtensions`; `bootstrapDir` option + `start()` runs bootstrap when not done for the current manifest, before `host.load`; refuse to listen when a required entry failed), `extensions/host.ts` (remove builtin load path; `enabledPlugins` unions required installs), `extensions/sources.ts`, `approvals.ts` (`withPreApproved` only where still needed), `admin-ops.ts` / `installs.ts` / `admin-view.ts` / `org-config.ts` / `plugin-import.ts` (guards: `extension.required` replaces `extension.builtin`), every direct `extension_org_configs` reader listed in the A2 inventory (identity/binding.ts:104, channels/supervisor.ts:399,684, channels/connections.service.ts:597, orgs/directory-sync.ts:361, orgs/offboarding.ts:310, runtime/usage-report.ts:130, catalog/catalog.service.ts:1255, catalog/plugin-install.ts:963, catalog/plugin-upgrade.ts:1038) → a shared `enabledExtensionsQuery(db, orgId)` that includes required installs, `errors.ts`, messages, `packages/testing` dual-replica harness (`builtinExtensions` → `bootstrap: { dir, manifest }` that packs the given plugin dirs), every test using `builtinExtensions` (installs, lifecycle, admin-approve.http, deployment-config, permission-view, m6-segment2.dual, m6-segment3.dual).

**Interfaces:**
- `BootstrapService.run(o: { manifest: BootstrapManifest; dir: string; signal }): Promise<BootstrapResult>` with `BootstrapResult { manifestSha256; results: { name; action: "installed" | "upgraded" | "kept" | "imported" | "required_cleared"; version }[] }`; `isDone(manifestSha256): Promise<boolean>`.
- Error codes: `bootstrap.integrity_mismatch` (500, names the plugin), `bootstrap.missing_file` (500), `extension.required` (409).

- [ ] **Step 1: Failing tests** for every Review Focus item 1–4 and the rules table (fresh run; re-run no-op; raised version upgrades with pre-approval and audit; admin-upgraded kept; removed entry loses `required`; declarative entry catalog-only; tampered file refused; org created later sees required plugins; 409 on disable/uninstall/org disable; `start` refuses to listen when a required entry failed; dual: two replicas, one run). Run: FAIL.
- [ ] **Step 2:** Migration and implementation; convert the builtin-based tests to the bootstrap harness. Run `pnpm exec vitest run packages/kernel packages/testing`: PASS; `pnpm check`.
- [ ] **Step 3: Commit** `feat(kernel)!: bootstrap plugins replace built-in extensions`.

### Task 4: CLI, image and compose

**Files:** Modify `apps/capybara/package.json` (drop the two plugin deps), delete `apps/capybara/src/builtin-plugins.ts`, `apps/capybara/src/{args.ts, cli.ts, commands/*.ts}` (`capybara bootstrap [--dir <path>] [--manifest <path>]`; defaults `/app/bootstrap` and the packaged `bootstrap.json`; start/migrate/extensions/plugins stop passing builtins), `catalog/cli.ts` `loadCliObjectStore` (use a bootstrap-installed or config-declared object store that is approved — reuse Task 3's rules), `docker/kernel.Dockerfile` (build stage: for each entry pack the workspace plugin into `/out/bootstrap` and verify sha512 against the manifest; A3 swaps this for npm downloads), `docker/compose.yaml` (`init`: `migrate` → `bootstrap` → `admin create --if-none`), `docker/test/kernel-image.sh` (expects two `bootstrap` rows), `docker/test/compose-smoke.sh` (step 5 still works; assert init ran bootstrap once; a third up runs it no more), `apps/web/e2e/global-setup.ts` (start the kernel with a bootstrap dir), `apps/web/src/lib/admin-extensions.ts` + admin extension pages (`bootstrap` source and `required` badge replace `builtin`), web tests, `tools/ci/src/affected.ts` + `test-plugins.json` + AGENTS.md (the CLI no longer depends on the two plugins; docker job roots and the dependency chain change).

- [ ] **Step 1:** Failing CLI tests (`bootstrap` runs, prints results, is idempotent, exits 1 on a tampered file) and web tests (bootstrap source / required badge). Run: FAIL.
- [ ] **Step 2:** Implement. Run apps/capybara, apps/web, tools/ci, tools/checks, `pnpm check`, e2e locally; `bash docker/test/compose-smoke.sh`; `bash docker/test/kernel-image.sh`. Expected: PASS.
- [ ] **Step 3: Commit** `feat!: capybara bootstrap, image-baked bootstrap plugins`.

### Task 5: Docs and acceptance

- [ ] **Step 1:** Docs: writing-extensions (no builtins; bootstrap), writing-plugins (bootstrap entries), writing-object-store-providers (the CLI store rule now reads bootstrap installs), docs/deploy README + upgrade.md (init runs bootstrap; proxies; development deployments with `builtin` rows), AGENTS.md (repository map, dependency chain, rules), the spec (§7 as built: workspace source until A3, the `bootstrap_runs` table, `start` refusing to listen, proxy decision replacing Ruling 16's open item; acceptance status).
- [ ] **Step 2:** Acceptance: spec §12 A items for bootstrap, each named with its test (the "0.1.0 builtin deployment upgrades" item: development deployments — a DB from main with no install rows for the two plugins bootstraps them; name that test); DB from main migrates through 0050; `pnpm verify`; compose smoke; image test.
- [ ] **Step 3: Commit** `docs: bootstrap plugins and egress proxies`; hand-off note: next plan A3.
