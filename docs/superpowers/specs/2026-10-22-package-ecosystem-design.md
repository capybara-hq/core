# Plugins, extensions and marketplaces (terminology refactor, repo as marketplace, Claude Code plugin compatibility)

- Date: 2026-10-22 (first draft); updated 2026-10-24 against `main` after M7 (`5bb285b`); updated
  2026-10-25 with what phase 0b (package formats) built and the release decisions of that day;
  updated 2026-10-26 with what phase A1 (git marketplaces, versions, provenance, skill conflicts, org
  upgrades) built ("Phase A1 as built" below); updated 2026-10-26 again with what phase A2 (bootstrap
  plugins, egress proxies) built ("Phase A2 as built" below); updated 2026-10-26 a third time with
  what phase A3a (core fakes, plugin tests inside their plugins, `@capybara-hq/plugin-tools`, the
  official marketplace as git, npm bootstrap entries) built ("Phase A3a as built" below) and the
  steps of phase A3b (§6.6); updated 2026-10-26 a fourth time with what phase B (Claude Code
  plugin compatibility, pinned skills, qualified names, the tool-name map) built ("Phase B as built"
  below; Appendix A re-checked).
- Status: draft for maintainer review (PR #21). Decisions the maintainer made are marked
  **(decided)** (2026-10-22), **(decided, 2026-10-24)** (answers to the open questions of the
  post-M7 update) or **(decided, 2026-10-25)**; decisions the designer made are marked
  **(designer's call)** and may be overturned in review.
- Timing: starts after M7 (working name M8). It does not change the M6 / M7 plans. The terminology
  refactor and the package formats (phase 0) land **before the first public release**, so 0.1.0 ships
  with the new names and formats and no compatibility aliases **(decided, 2026-10-24)**. **The first
  release comes after the repo split (phase A), and every package starts at 0.1.0**
  **(decided, 2026-10-25)**, replacing "the first manual publish follows phase 0" (§6.4, §12).
  Phases B–D follow the release.
- Baseline (read against the code, not against the plans):
  - M6 (`docs/superpowers/plans/2026-10-22-m6-eval-admin.md`, C11–C15, C21–C32, D13–D17): plugin
    packages, the package store and the no-restart lifecycle (`packages/kernel/src/plugins`), the
    enterprise directory, catalogs, app bundles and org installs (`packages/kernel/src/directory`);
  - M7 (`docs/superpowers/plans/2026-10-23-m7-release.md`, E1–E11, F1–F14): `ctx.hooks`, the SDK API
    snapshot, the npm and image release (`tools/release`, `.github/workflows/release.yml`,
    `docs/deploy/release.md`), the gateway role;
  - M5 skills: the `skills_catalog` snapshot event, `skill_load`, `/skills/<name>/`;
  - the contributor workflow (`docs/superpowers/specs/2026-10-23-contributor-workflow-design.md`):
    the shared org repo `capybara-hq/.github`, whose second consumer is the plugins repo.
- Written in English (AGENTS.md "Language"). The 2026-10-22 draft was in Chinese; this is a full
  update, not a translation.

## What changed since the 2026-10-22 draft

- **M7 shipped the npm release path.** `tools/release` publishes the SDK, kernel and testing with
  `pnpm pack` and every `plugins/*` except `example-*` as the pack-plugin tgz, with `--provenance`,
  dist-tags by `distTagFor`, versions by changesets, and a "Version Packages" PR. Packs are
  byte-reproducible (fixed mtime, sorted entries). §6 now builds the plugins repo's release on this
  instead of inventing a path, and replaces the draft's "bot commits integrity back to `main`" (which
  the `main-quality` ruleset forbids) with integrity computed in the Version Packages PR.
- **Nothing is on npm or ghcr.io yet** (2026-10-24: `npm view @capybara-hq/plugin-sdk` is 404). The
  first release (0.1.0) is a manual dispatch after the release gate. So the rename lands before it,
  with no compatibility aliases **(decided, 2026-10-24)** (§12, §13).
- **The official catalog was never launched** (E1, F1): `catalogs.official.enabled` now defaults to
  `false`, `catalogs.official.url` is a placeholder, and the roadmap defers "the official catalog repo
  and package / catalog signing beyond npm provenance" to this project. §5.5 takes that over: no new
  signing scheme in phase A **(decided, 2026-10-24)**; the official marketplace is `capybara-hq/plugins`,
  on by default once live **(decided, 2026-10-24)**.
- **Built-in plugins are code in the image, resolved from the CLI's own dependencies**
  (`apps/capybara/src/builtin-plugins.ts`, source `builtin`). Moving them out of core means the CLI
  stops depending on them and the image bakes their tgz from `bootstrap.json` instead (§7).
- **Compose already has a one-shot `init` service** (`capybara migrate` then
  `capybara admin create --if-none`). The bootstrap step joins it (§7) instead of a new mechanism.
- **Kernel, CLI, web e2e and checks tests load official plugins by path** (`tools/ci/test-plugins.json`:
  30 kernel test files load `slack`, `lark`, `connector-mcp`, `todo`, `sandbox-docker`, …). The draft
  ignored this; core ships its own fake extensions **(decided, 2026-10-24)** (§6.3).
- **The plugin toolchain is private.** `@capybara-hq/pack-plugin` and `@capybara-hq/checks` are
  `"private": true`; the plugins repo cannot use them as they are (§6.2).
- **The SDK is 0.x and plugins declare `sdk: "^0.1.0"`**, which on 0.x accepts only 0.1.x. Across two
  repos every SDK minor would force a republish of every plugin. 2026-10-24 decided "0.1.0, then
  1.0.0 at the repo split"; 2026-10-25 replaced it: the SDK stays 0.x until the plugins repo is
  stable, additive changes ship as patches and a breaking change is a minor every plugin follows
  **(decided, 2026-10-25)** (§6.4).
- **Code facts the draft got wrong or assumed:** `app.yaml` is the only app manifest file (no
  `app.json`); `connector-mcp` speaks Streamable HTTP only (no SSE); there is no `ctx.models` (deferred
  until a consumer exists); skills, skill versions and connectors already record their source catalog
  item (`directory_item_id`, `directory_version`, migration `0037`); the `skills_catalog` event already
  has a field called `source` (the object prefix), so the new plugin field cannot reuse that name;
  extension names follow `PLUGIN_NAME_RE` (`^[a-z][a-z0-9-]{1,40}$`), stricter than catalog item names
  (`DIRECTORY_ITEM_NAME_RE`, `^[a-z0-9][a-z0-9-]{0,63}$`); the existing `/api/v1/orgs/:orgId/plugins`
  route and the `catalog.*` error codes collide with the new meanings; there is a
  `directory.maxBundleBytes` config key; there is no Gemini plugin (E5).
- **The contributor workflow exists now.** The plugins repo must be a full consumer of
  `capybara-hq/.github`: `pnpm doctor:env`, `pnpm verify`, `gate.yml@v1`, synced shared skills with
  `check:synced-skills`, the same rulesets, CODEOWNERS, the CLA workflow (§6.2).
- **`ctx.hooks` landed** (five mount points, observe or deny only). It stays an extension
  registration; it is still not used to translate Claude Code hooks.
- **The UI refresh spec** (`2026-10-22-ui-refresh-design.md`, branch `docs/ui-refresh`) shares
  three seams with this one: the sidebar entries, the sub-agent view, and pinned skills on the agent
  page. It is **not** ordered after the split or the rename: it proceeds independently, its copy uses
  whatever names the code has at the time, and the copy follows when the rename lands **(decided, 2026-10-24)**
  (§15).

## Phase A1 as built (2026-10-26)

Phase A1 (plan `docs/superpowers/plans/2026-10-25-ecosystem-phase-a1-marketplaces.md`) built the
marketplace and upgrade half of phase A: git marketplaces and single-plugin repos, path and git
sources, direct git import, content digests and "content changed at the same version", npm
provenance display, skill name conflicts and org in-place upgrades. Migrations 0046 to 0049. The rest
of phase A (`bootstrap.json`, the repo split, `@capybara-hq/plugin-tools`, the official marketplace
on by default, the first release) is phase A2 and later. The decisions below were made while
planning and building it; the sections they refine point here.

**Decisions** (all **(designer's call)**):

1. **Private addresses with an allowlist** (§5.1). Every download whose URL comes from a marketplace
   or an admin (manifests, mirrors, archive sources, git sources, git marketplaces, direct git import)
   goes through one network layer (`packages/kernel/src/net`): https only (`http` only to loopback
   with `marketplaces.allowInsecureLoopback`, testing only), no redirects, every resolved address
   public (the ranges of the sandbox egress proxy, including v4-mapped, NAT64 and 6to4), and the
   connection pinned to the checked address (no second DNS lookup). Exceptions:
   `marketplaces.allowPrivateHosts` (default `[]`, for internal GitLab and mirrors, the offline case
   of §5.1) and the configured `packages.npmRegistry` origin. Refusals are
   `marketplace.private_address` / `marketplace.redirect` (422).
2. **Git client**: `isomorphic-git` (pure JS, any smart-HTTP host, GitLab and Gitea included) with an
   http client built on the network layer. Files are read from the fetched pack, never checked out;
   its object store is a temp dir removed after each operation. Limits: depth 1, one commit, no tags,
   no submodules (never fetched; a submodule or symlink entry under the plugin's path is refused with
   `marketplace.git_unsupported_entry`), LFS pointer files read as plain files, the pack at most
   `packages.maxBytes`, at most 5000 files and 4 × `packages.maxBytes` unpacked
   (`marketplace.git_too_large`), 120 s per operation; other failures are `marketplace.git_failed`.
   The optional token (stored as `catalog-token:<id>`) goes only to the marketplace URL's origin.
3. **Git plugins without `package.json`** are allowed (§4.1 needs it only for npm); their package name
   is null. Without `plugin.json`, a directory with `skills/` is a skills-only plugin named after the
   marketplace entry (or, for a single-plugin repo, the repository name; for a direct import, the last
   segment of the path, else the repository name), versioned per §5.3, published by the marketplace's
   `owner.name`, else `<host>/<owner>` of the repository. A git plugin **with an extension** still
   needs `package.json` (its host ranges are checked) and is refused without one.
4. **One reader**: the tgz reader is split into unpacking and `readPluginFiles(files, opts)`, so a tgz
   and a git tree go through every check alike; a git plugin with an extension is packed into a
   deterministic tgz and read as an upload.
5. **Content digest** (§5.3): sha256 hex over the sorted file list, one line
   `path + "\0" + sha256(content) + "\n"` per file; computed for every import, tgz included, and
   stored on the version (`content_digest`).
6. **Same version, changed content** (§5.3): re-importing an imported release whose digest differs
   records `<version>+git.<sha12>` (git) or `<version>+sha256.<12>` (archive, npm, upload); the same
   digest is `catalog.version_exists` ("already imported"). Versions imported before digests are
   compared by integrity when both have one.
7. **Provenance** (§5.5): npm sources only, from `<registry>/-/npm/v1/attestations/<name>@<version>`;
   the SLSA provenance statement is parsed for repository, commit and workflow; signatures are not
   verified; any failure (no attestation, offline, timeout, malformed) shows "provenance not
   checked" and never fails an import.
8. **Skill conflicts** (§9.2): checked when an install is planned and in the upgrade preview, before
   anything is written; a reinstall or upgrade of the same item adds a version; the org's own skill
   or another item's skill is 409 `plugin.skill_conflict` with the message of §9.2, one line per
   skill, and `details: [{ skill, source }]`.
9. **Upgrade ledger** (§10): `plugin_install_components.template_id` maps a connector component to its
   template id; a changed template rewrites only template-owned fields of the existing connector.
10. **Upgrade with an extension** (§10): the target must be the catalog version whose extension is the
    one the deployment runs; declarative plugins may target any imported version (rollback). An
    install whose extension version differs from the deployment's shows "upgrade pending"
    (`deploymentPending`).
11. **Upgrade approval** (§10): follows the item's policy like install: `needs_approval` without a
    grant gives a request for that version (after approval the org admin runs the upgrade again);
    `disabled` is `catalog.item_disabled`.

**Rulings made while building** (all **(designer's call)**; only those that change what users or
plugin authors see):

- The npm registry is trusted by origin (an admin setting, https required) and fetched outside the
  marketplace network rules; marketplace npm sources carry no tarball URL, so no marketplace-
  controlled URL reaches it. A manual refresh in which every URL fails on the same network rule
  returns 422 with that rule's code.
- `allowPrivateHosts` IP and CIDR entries match **IP-literal URLs only**; a DNS name must be listed as
  a hostname, so a public name an attacker points into an allowed range is still refused. Link-local
  and metadata addresses stay refused even for listed hosts; prefixes shorter than /8 (IPv4) or /16
  (IPv6) are invalid config. SIIT addresses (`::ffff:0:a.b.c.d`) are judged by the embedded IPv4
  address.
- A `path` entry in an http marketplace stays unimportable (`reason: "path_needs_git_marketplace"`,
  422 `marketplace.path_unsupported`); a git marketplace whose url or ref changed since its last
  refresh refuses path imports until refreshed (409 `conflict`). `marketplaces.allowedHosts`
  (hostnames or IPs, no port; default unrestricted) applies to marketplace entries, not to a direct
  git import, which is the admin's own action. Items without a package name are identified by their
  git source, so an unrelated repository never adds versions to them.
- A pinned commit the server will not serve (GitLab and Gitea can refuse non-tip commits) fails with
  "the server refused to serve commit <sha>; pin a branch or tag tip instead".
- "Content changed at the same version" compares, for an entry that follows a branch, the branch head
  resolved at refresh (bounded per refresh) and, for a plugin in a sub-directory, the git tree oid of
  that directory, so a monorepo commit that leaves a plugin alone does not flag it. Only the plugin's
  own source is compared (never an upload or another marketplace's import).
- The provenance repository-mismatch warning is given for git marketplaces only (the http form stores
  no declared repository).
- An extension-bearing plugin's upgrade target is chosen by the deployment's extension package
  (sha256), newest import on ties.
- Default tool policies on upgrade: rows still at the kernel default (`derived`) are updated like
  `template` rows, so rollback is symmetric; only org-set policies stay. Upgrade approval uses
  item-level grants, valid across versions, as install does.
- Connectors installed before 0049 have no `template_id` and are left alone by upgrades (the preview
  says so). A target without the extension is treated as the "removed" row of §10. A template that
  switches connector kind is refused. Each step is journaled in `plugin_installs.upgrade`; an upgrade
  interrupted by a crash is undone by the next preview, upgrade or uninstall once older than
  `catalog.staleInstallMinutes`.
- The upgrade preview returns the target version's templates (the dialog never uses the latest
  version's), and host, git and target errors carry structured details so the UI localizes them.

**Not built in A1**: reading `.claude-plugin/marketplace.json` and `.claude-plugin/plugin.json` (phase
B, with the Claude reader); refusing an import without valid provenance (§5.5, a later option);
upgrading a dependency installed at a version outside a new range automatically (it stays
`catalog.dependency_unresolved` until the org upgrades that dependency).

## Phase A2 as built (2026-10-26)

Phase A2 (plan `docs/superpowers/plans/2026-10-26-ecosystem-phase-a2-bootstrap.md`) built `bootstrap.json`
and the bootstrap step (§7), removed the built-in extensions, and added egress proxies for marketplace
and git downloads (§5.1). Migration 0050. The rest of phase A (`@capybara-hq/plugin-tools`, the fake
extensions, the repo split, the official marketplace on by default, `check:bootstrap`'s network half,
the first release) is phase A3. §7 is refined by "As built (phase A2)" at its end; the decisions that
change what users, operators or plugin authors see are summarized here (all **(designer's call)**):

1. **Workspace source until A3.** Nothing is published before the first release, so every entry of
   `packages/kernel/bootstrap.json` is `"source": "workspace", "path": "plugins/<dir>"`, pinned by the
   sha512 of its `tools/pack-plugin` pack (byte-reproducible across macOS and linux: fixed mtimes,
   sorted entries, gzip header OS byte fixed). The npm shape of §7 (`"source": "npm"`, top-level
   `marketplace` required once an entry uses it) is valid manifest v1 and comes with A3. The manifest
   is strict (unknown keys are errors): it ships with core, so there is no forward-compatible reader.
2. **`capybara bootstrap`** is its own command (§16), run by compose `init` between `migrate` and
   `admin create --if-none`. `capybara start` runs the step when `/app/bootstrap` exists or
   `--bootstrap-dir` is given and the manifest is not done; from a source checkout it does not (dev
   runs keep config-declared extensions).
3. **"Done" is a `bootstrap_runs` row** for the sha256 of the parsed manifest, written with the audit
   `bootstrap.completed { manifestSha256, results }` only when every entry succeeded. The run holds a
   session advisory lock (`capybara.bootstrap`, try-lock with backoff, interruptible by `stop()`).
4. **A required entry that fails stops the start**: `capybara start` never listens. A failed optional
   entry is logged; the step runs once more after the startup reconcile (a declarative entry's catalog files need the object store, itself a bootstrap plugin on
   a fresh deployment) and otherwise on the next start. `capybara bootstrap` makes the same second
   pass and then matches `start`: it exits 1 when a required entry still fails or a package is
   missing or does not match its pin (so compose's `init` fails), and exits 0 with warnings when only
   optional entries still fail (nothing is recorded as done, so the next run retries them).
5. **Only entries new to the manifest are installed** (absent from the last completed run): an optional
   plugin an enterprise admin uninstalled stays uninstalled; a required one is always installed.
6. **Upgrades keep the admin's desired state**: a bootstrap install at a lower version is upgraded
   (new permissions pre-approved and audited) but an admin-disabled optional plugin stays disabled.
7. **Config-declared names win**: an entry whose name is in the startup `extensions` list is `kept`
   with no install record.
8. **Required plugins** (`extension_installs.required`) are enabled in every org without org config
   rows; one shared query (`packages/kernel/src/extensions/enabled.ts`) replaced every direct read of
   `extension_org_configs`. Disabling one in an org or on the deployment, or uninstalling it, is 409
   `extension.required` (replacing `extension.builtin`); its org config can still be set and an
   enterprise admin can upgrade it. The admin console shows install source "Bootstrap" and a
   "Required" badge.
9. **Load source**: the kernel has two load sources, `config` and `install`; a bootstrap plugin is an
   install record (install source `bootstrap`), so `extension_replica_status.source` is
   `('config', 'install')` (0050 deletes the `builtin` rows; each replica rebuilds its rows).
10. **Bootstrap packages are kept in PostgreSQL** (`blob_store = 'pg'`), so installing an extension
    never needs the object store. The CLI's object store (`loadCliObjectStore`) may now be an enabled,
    approved and configured install record (the bootstrap `object-store-s3`), skipped while its
    package's migrations have not run.
11. **Egress proxies** (§5.1; this answers the item phase A1 left open, Ruling 16 of its ledger:
    egress proxies and fake-IP DNS resolvers, under which every name resolves into `198.18.0.0/15` and
    looks private): `net.httpsProxy` (secret; `http://` or `https://`, optional userinfo sent as Basic
    `Proxy-Authorization`, never logged) and `net.noProxy` (hostnames or IPs, subdomains match). With a
    proxy, every https marketplace, mirror, archive and git download tunnels with `CONNECT`; the kernel
    does TLS to the target itself (certificate checked for the target's name) and **does not resolve
    the target**: SSRF protection for DNS names is then the proxy's job (documented in
    `docs/deploy/README.md`). The kernel still refuses private and link-local IP-literal targets
    (unless `allowPrivateHosts`), and still applies `allowedHosts`, https only and no redirects.
    `noProxy` hosts and loopback go direct with local resolution and pinning. A non-2xx answer is
    `net.proxy_refused`. Opening the tunnel is bounded by 10 s. npm registry downloads
    (`packages.npmRegistry`, trusted by origin) do not use the proxy yet; A3 revisits this when the
    bootstrap entries move to npm (only the image build downloads them; init stays offline).

**Not built in A2**: the network half of `check:bootstrap` (comparing entries with the official
marketplace at `marketplace.commit`) and `"source": "npm"` entries in the real manifest (A3); bootstrap
plugins shown as "installed" in the official marketplace (it is not live; their catalog records are
shaped like a marketplace import, with source `bootstrap`); npm downloads through the proxy.

## Phase A3a as built (2026-10-26)

Phase A3 was split on 2026-10-26 **(decided, 2026-10-26)**: A3a (plan
`docs/superpowers/plans/2026-10-26-ecosystem-phase-a3a-prepare-split.md`) makes the move of the
official plugins a mechanical step while every plugin stays in core and nothing is published; A3b
(plan `docs/superpowers/plans/2026-10-26-ecosystem-phase-a3b-split-release.md`, §6.6) creates
`capybara-hq/plugins`, moves the plugins, and runs the first release. A3b is executed after manual
acceptance. No migration. The decisions below refine §6.2, §6.3, §6.4, §5.5 and §7 (all
**(designer's call)**):

1. **Fakes live in `@capybara-hq/testing`** (`packages/testing/fixtures/extensions/<name>`, pack
   layout, so the plugins repository can reuse them): `fake-connector` (`connector@1`, a slim MCP
   client for `startFakeMcpServer`, every kernel-facing behaviour of a connector: auth before each
   request and one refresh, routing by the reviewed definition through `_meta["fake/route"]`,
   `onToolsChanged`, `onElicit`, resources / prompts, `inspect`; deployment config `kind` because
   the web install wizard knows only `mcp` / `openapi`), `fake-object-store` (backed by
   `startTestS3`: presigned URLs and multiple replicas need a real store), `fake-tools-ui` (tools, a
   view, a migration, a skill, a template), `fake-storage-user` (`ctx.storage`), `fake-embed` (page
   and conversation embeds speaking the host bridge), `fake-bootstrap-a` / `-b` (a model provider
   with a required secret, an object store in PG), `fake-dep-provider` / `-requirer` (on the
   registered `counter@1`, so the SDK API does not change) and `fake-im` (moved from the kernel's
   fixtures). `packFixture(name, outDir)` packs one with `@capybara-hq/plugin-tools`, an optional
   peer imported lazily (a devDependency would close a testing -> plugin-tools -> kernel -> testing
   cycle); `fakeExtensionEntry(name)` loads one by path inside this workspace only.
2. **Kernel contracts stay in core on fakes; a real plugin's behaviour moves into the plugin.**
   Every kernel, CLI, testing, checks and web e2e test that loaded an official plugin now loads a fake
   (old test -> new home tables in the Task 2 and Task 3 reports of the A3a ledger). Tests whose
   subject is the plugin moved to `plugins/<name>/test`, kernel-level ones included (Slack / Lark
   dual-replica tests, the MCP and OpenAPI end-to-end and live tests, the Docker sandbox smoke and
   artifacts tests, example-board's board and SSE, todo's view through a kernel). Where a file
   covered both, it was split; `mcp-e2e` exists twice on purpose (the plugin copy for the protocol,
   the core copy on `fake-connector` for the kernel contract) and `mcp-interaction-e2e` stays in core
   on the fake (its subject is the kernel's elicitation and resume).
3. **Plugin tests reach nothing in core**: they import only the SDK, `@capybara-hq/testing`,
   `@capybara-hq/plugin-model-fake` (a devDependency, loaded by package name with
   `resolveFrom: <plugin dir>`) and the plugin itself. `@capybara-hq/testing` gained the kernel
   helpers those tests need (`startTestKernel`, `testKernelConfig`, accounts, orgs, agents, runs,
   events, `openSse`, `truncateTables`, `pidOwningLocalPort`, `createDb` / `kernelDb` and kernel
   texts), so the kernel index exports eight more names. `check:test-plugins` gained two rules:
   `test-plugins-official` (a core test root loads only `model-fake`, plus listed exceptions with
   their reasons: `tools/checks/test/bootstrap.test.ts` for the workspace bootstrap entries, and the
   web e2e setup for `connector-openapi-wizard.spec.ts` and `embed-board.spec.ts`, whose home A3b
   decides) and `plugin-test-imports` (no other `@capybara-hq/*` import, no relative path out of the
   plugin, no repo-root path into `packages/` or `apps/`). `check:deps` allows `testing`,
   `plugin-model-fake` and `plugin-tools` in a plugin's devDependencies and tests. The sandbox-docker
   tests start the socket proxy from a copy of `docker/sandbox-proxy/haproxy.cfg` inside the plugin,
   kept byte-identical by the new `check:compose-haproxy` rule `compose-haproxy-copy`.
4. **`@capybara-hq/plugin-tools`** (`packages/plugin-tools`, published, bin `capybara-plugin`):
   `pack` (the packer and the bootstrap pack, moved from `tools/pack-plugin`, bytes unchanged),
   `check` (the plugin-scoped checks moved from `tools/checks`: the SDK boundary, extension state,
   permissions, plugin packing, tool design, migrations and, with `--base`, edited applied
   migrations; plugin discovery is `<root>/plugins/*`, else the root itself when it is a plugin,
   else `--plugins <glob>`), `sync-versions` (copies `package.json` versions into `plugin.json` and
   the extension manifest; the plugins repo needs it for its Version Packages PR) and `release` (the
   npm half of `tools/release`: publish plan, dist tags, auto mode, libraries first in the order SDK,
   kernel, testing, plugin-tools). Every relative path resolves against the current directory; core's
   root scripts (`pack-plugin`, `pack-plugins`, `pack-bootstrap`, `release`, `sync:plugin-versions`)
   run its CLI from source and `pnpm check` runs its checks on core's plugins and fakes. The bin is a
   committed shim over `dist/` (a dist bin breaks `pnpm install` before a build). Subpath exports
   `./pack`, `./release` and `./source` do not load the kernel. `tools/pack-plugin` is gone;
   `tools/release` keeps only the image release.
5. **The official marketplace is a git repository**: the default `marketplaces.official.url` is
   `https://github.com/capybara-hq/plugins.git` and `enabled` still defaults to `false` until A3b. A
   git URL with `mirrors` is a config error naming the field (`marketplaces.official.mirrors`: a git
   marketplace has no mirrors; point the URL at a mirror repository instead). The sync stores the
   marketplace's `form` and drops `etag` and `last_commit` when the URL or form changes.
6. **npm bootstrap entries** (§7): `capybara-plugin pack --bootstrap <manifest> --registry <url>`
   (default `CAPYBARA_PACKAGES__NPM_REGISTRY`, else the public registry) downloads each
   `"source": "npm"` entry, checks its sha512 against the pin and writes nothing for a failing entry
   (unpublished or tampered: the image build fails, init is never reached). `check:bootstrap
   --network` adds the rules `bootstrap-npm` (published at its version; packument `dist.integrity`
   and tarball sha512 equal to the pin) and `bootstrap-marketplace` (the official marketplace's
   `.capybara-plugin/marketplace.json` at `marketplace.commit`, read with the kernel's git reader,
   lists each npm entry at the same version, package and integrity). It runs by diff on PRs (only when
   `packages/kernel/bootstrap.json` changes; plan output `bootstrap-network`), always on `main`, in
   `pnpm verify` when the plan says so, and in the release workflow before publishing.

**Rulings made while building** (all **(designer's call)**):

- The npm download in the bootstrap pack sends no token and follows registry redirects (the bytes
  are checked against the sha512 either way); a registry token and a size cap come in A3b.
- `check:bootstrap --network` does not require `marketplace.url` to be the official URL (tests use
  another repository); A3b decides whether to enforce it.
- The two web e2e specs on real plugins (`connector-openapi-wizard.spec.ts`, `embed-board.spec.ts`)
  stay in core until A3b; embed coverage on a fake is `embed-panel.spec.ts`.
- A plugin's tests run when the plugin, `packages/testing` (which runs everything) or `model-fake`
  (their devDependency) changes; a plugin change no longer runs the kernel's tests.
- The CI `ci` job waits for the `changes` job (about 10 s) so the network check can be conditional.
- The scheduled hourly directory scan can add a `schedule` sync audit in dual-replica tests under
  load; tests that count syncs count only the triggers they cause.

**Not built in A3a** (A3b, §6.6): the `capybara-hq/plugins` repository, the move, any publish,
`"source": "npm"` entries in the real manifest, the official marketplace on by default, a registry
token for bootstrap downloads.

## Phase B as built (2026-10-26)

Phase B (plan `docs/superpowers/plans/2026-10-26-ecosystem-phase-b-claude-compat.md`) built Claude
Code plugin compatibility: the Claude reader and translation report (§8), Claude marketplaces in git
refresh (§5.1), pinned skills, provenance in the snapshot, qualified names and the tool-name map
(§9), and the web review and agent pages. It was planned and built against `main` with the official
plugins still in core, before A3b and the first release (§12 puts B after them); every core test runs
on `model-fake` and the fakes, so it does not depend on the split. Migration
`0051_claude_compat.sql` (additive: `catalog_item_versions.source_format` / `translation` /
`license_text` / `license_truncated`, `skill_versions.source_format` / `suggest_pinned`,
`marketplace_entries.claude`, `marketplaces.skipped`). The UI refresh A branch ships
`0052_conversations_account_agent_idx.sql`, so phase B merges first and nothing collides; if UI A
merged first, B's 0051 would have to become 0053, since the migrator refuses a file older than one
already applied (`db/migrator.ts`) on any database that ran 0052. New error code
`agent.pinned_invalid` (400); new drift reason `pinned_changed`.

**Appendix A re-check** (2026-10-26; the plan's header notes from the Claude Code CHANGELOG at
2.1.310, the official and superpowers marketplaces and `obra/superpowers@2ce8aa15` 7.0.1, then the
docs pages "Plugin manifest reference", "Plugin marketplaces" and "Marketplace reference", reachable
when Task 2 ran; no Claude Code CLI was available, so `claude plugin validate` was not run). What
differs from Appendix A, and what the reader does (nothing new fails an import; differences became
report items):

1. Marketplace sources use a `source` discriminator: `{ source: "github", repo, ref?, sha? }`,
   `{ source: "url", url, ref?, sha? }`, `{ source: "git-subdir", url, path, ref?, sha? }`,
   `{ source: "npm", package, version?, registry? }`, a string is a relative path (`"./"` = the
   root). `archive` sources are **zip** files: skipped as `claude_source_unsupported` (Capybara's
   archive reader is tgz-only and Claude plugins are read from git only), as are `command` and
   non-https `url` sources (`http://`, `file://`, `git@`); `git-subdir.url` accepts `owner/repo`.
2. `metadata.pluginRoot` applies **only to bare names** (no `/`); `./x` is unaffected. Further
   top-level keys (`$schema`, `description`, `metadata.description` / `version`, `renames`,
   `forceRemoveDeletedPlugins`, `allowCrossMarketplaceDependenciesOn`, `relevance`, `headers`,
   `headersHelper`) are ignored. Entry names may contain `.`, `_` and uppercase in Claude; Capybara
   skips them as `invalid_name`.
3. `plugin.json` gained `experimental` (`themes`, `monitors`, `evals`), `settings`,
   `defaultEnabled`, `metadata`, directory-listing fields (`icon`, `documentationUrl`, `supportUrl`,
   `privacyPolicyUrl`, `termsOfServiceUrl`), `types` (mods), `workflows`, `userConfig`; mods,
   monitors, themes and `claude plugin eval` are new since 2026-10-22. All are `not_applicable`
   (each `experimental.<key>` by name; `types` is `hooks_module`).
4. `commands` may be an object map (`name -> { source | content, … }`), reported per key; `hooks`
   and `mcpServers` may be arrays mixing paths and inline objects; `mcpServers` also takes `.mcpb` /
   `.dxt` paths and https bundle URLs (`mcp_unsupported_transport`); a hooks file needs the
   `{ "hooks": … }` wrapper, an inline object is the event map itself. `.mcp.json` comes in two
   shapes, `{ mcpServers: { … } }` and a flat map of servers (the official `github`, `gitlab`,
   `linear` plugins).
5. Paths must start with `./`; `skills` also accepts `.` / `./` (the root); the `agents` scan is
   recursive. `${CLAUDE_PROJECT_DIR}` joins the variables of `skill_claude_variables`.
6. `dependencies` entries are `"name"`, `"name@marketplace"` or `{ name, marketplace?, version? }`:
   the part after `@` is a **marketplace**, not a range. `name@mkt` maps to `{ name, version: "*" }`
   with `detail.marketplace`; anything else is an ignored `unknown_field` item.
7. Strict mode: with `plugin.json` present and `strict: false`, the docs make **any** entry component
   a conflict. The reader keeps the plan's narrower rule (a conflict, refused, only when both sides
   declare components; otherwise the entry's are used), since the re-check was not allowed to add
   import failures. With `plugin.json` present, entry `mcpServers` / `lspServers` / `userConfig` /
   `channels` do not apply (`unknown_field` `entry.<key>`); without it the entry is the manifest.
8. When an entry whose source is the root lists `skills`, Claude loads only those. **Not
   implemented**: the default `skills/` scan still runs.
9. Claude does not check `version` against semver; `displayName` exists in `plugin.json` too (the
   overlay carries no display fields, so `plugin.json`'s is used).
10. superpowers 7.0.1 has no `commands/` or `agents/`; the fixture adds `commands/brainstorm.md` and
    `agents/code-reviewer.md` from tag v5.0.7 (documented in its `FIXTURE.md`) so the acceptance
    report has a command and an agent. `obra/superpowers-marketplace` lists superpowers at 5.0.7 with
    `strict: true` while its `plugin.json` says 7.0.1 (see ruling 3 below).

**Decisions** (the plan's list, all **(designer's call)**; outcomes as built):

1. `pinned_changed` was added as a step-replay drift reason (ruling 9 gives its exact comparison);
   the tool map needs none (its text is in the log).
2. Translated templates target `connector-mcp`; when it is not loaded they get the static checks
   (`endpointChecked: false`) and a `connector_not_loaded` warning instead of §4.1's refusal; org
   install checks against the loaded connector (`plugins/connector-mcp/test/claude-template.test.ts`
   covers the loaded case: `endpointChecked: true`).
3. Claude `npm` sources are skipped (`claude_npm_unpinned`): no integrity to verify.
4. `displayName.zh` copies `en` (the manifest schema needs a non-empty zh).
5. `skill_load` keeps `maxLength: 64`; the tool definition and its spec hash are unchanged.
6. Skills without `name` or `description` frontmatter are `skill_invalid` (never rewritten).
7. An http MCP server without headers or `oauth` becomes `auth: none` with `mcp_auth_none`; all
   credential-bearing translated templates are `ownership: "personal"`.
8. A revert snapshot drops the reverted draft's pinned entry; the next run start restores the real
   version's body.
9. Pinned bodies are read from object storage at run start (sha256-checked, outside the transaction,
   bounded retry), never stored in PG.
10. "Suggest pinned" applies to every plugin import, is chosen at confirm (`pinnedSuggestions`) and is
    not part of `reviewHash`.
11. Claude plugins are read from git only; an uploaded or npm tgz without `.capybara-plugin/plugin.json`
    stays `catalog.invalid_manifest`.
12. Detection without `plugin.json`: `hooks/hooks.json`, `.mcp.json`, `commands/`, `agents/`, a root
    `SKILL.md`, or an entry of a Claude marketplace; only `skills/` stays the A1 skills-only plugin.
13. `license_text` (≤ 64 KiB, enforced in code, `licenseTruncated` past it) is stored for every
    plugin version.
14. A design component `Disclosure` (`packages/design/src/display/disclosure.tsx`, spec
    `docs/design/spec.md` §6.5) shows SKILL.md bodies, the license and the pinned suggestion.
15. The tool-name map is fixed English text (`runtime/context/claude-tools.ts`), not tailored to the
    agent's tools ("when it is in your tools").
16. Pinned order is the owner's; over 32 KB at run time the later ones are dropped with a warning.
17. Phase timing: built before A3b on `main` with plugins in core, every core test on fakes.

**Rulings made while building** (all **(designer's call)** unless noted):

1. **Refusals** (`catalog.invalid_manifest`) are six paths, not the plan's four: a name Capybara
   cannot use, an unreadable / non-object `.claude-plugin/plugin.json` or one without `name`, a
   `strict: false` conflict, a component path leaving the root, a plugin with no importable skill and
   no template, and a translated manifest that fails `parsePluginManifest`. After the review fixes
   (overlapping or reserved skill directories become `skill_invalid`; a root path for `commands` /
   `agents` / `hooks` / `mcpServers` is an item) the last one has no known trigger and stays as a
   guard. Hostile input (wrong types, `__proto__` keys, 1000 hook handlers, 200 servers, controls
   and bidi characters in names) is a report item; wrong-typed known fields are `unknown_field` with
   `detail.problem`; the report holds at most 500 items plus one `{ more }` item (hooks 100 per
   kind); names, paths and string details pass through `printable`, and the CLI prints the review
   through the same filter. Declared component paths (final review I1): each of `skills`,
   `commands`, `agents`, `hooks`, `mcpServers` takes at most 100 distinct entries over
   `plugin.json` and the marketplace entry (repeats are skipped, the rest are one `unknown_field`
   item `{ problem: "too many paths", more }`; a path leaving the root still refuses wherever it
   is), and each JSON file is parsed at most once per translation, so a hostile manifest cannot
   stall an api replica (10 000 repeats of a 100 K hooks file translate in milliseconds).
2. **`package.json` is dropped from the translated tree** (npm metadata for other harnesses) but
   counts in the content digest. A relocated root `SKILL.md` excludes every other accepted skill
   directory, the not-applicable and other-harness files, `.<x>-plugin/`, `.capybara-generated/` and
   `package.json`.
3. **Versions**: `plugin.json`'s version wins (Claude's rule), so the entry-version check of import is
   skipped for Claude plugins; the name check stays. **Limitation** (not fixed): the marketplace view
   still matches releases by the entry's version, so for obra/superpowers-marketplace (entry 5.0.7,
   plugin 7.0.1) `contentChanged` is never true and importing entry "5.0.7" records 7.0.1. Option for
   later: store the recorded plugin version per entry and match on it.
4. **Entry digest**: the marketplace entry's `strict` and component fields decide what is imported,
   so `claudeContentDigest` folds their canonical JSON into the content digest when the entry has
   components (display fields stay out; an entry without components keeps the files' own digest,
   equal to a direct git import). An entry in another repository can change while the plugin's
   commit does not, so `recordedVersion` falls back from a taken `+git.<sha12>` to `+sha256.<12>`.
   **Limitation**: the marketplace view's `contentChanged` is commit / tree based and does not flag
   an entry-only change (display only; the import works).
5. **Marketplace parser** is lenient per entry: an entry without a name or a duplicate is skipped
   (`invalid_entry`, named `plugins[i]`), entries past 5000 become one skipped row
   `plugins[5000…<last>]`; only a non-object top level, a missing `name` or a non-array `plugins`
   fails the refresh. `MarketplaceEntryView.format` is `claude-code` only for entries of a Claude
   marketplace file: a single-plugin Claude repository lists its entry as `capybara` although its
   import is detected as Claude.
6. **`PluginReview.repository`** (the Claude manifest's `repository`) is display only: not hashed,
   not stored; the CLI and the web label it "from the plugin, not verified". `claudeManifestIgnored`
   and `licenseTruncated` are in `reviewHash`. The confirm audit is `catalog.imported` with
   `suggestedPinned` (the final pinned names).
7. **`skills.pinned` schema bound is 100, not 3**, so a fourth pin reaches
   `agent.pinned_invalid { reason: "too_many" }` instead of `validation_failed`;
   `PINNED_SKILLS_LIMITS.count` is the one source of the 3. Reasons: `not_selected`, `not_found`,
   `duplicate`, `too_many`, `too_large` (with `totalBytes`, naming the first skill past the limit).
8. **`too_large` only when the pinned list changed**: a pinned skill's new version must not block an
   unrelated edit of the agent. At run time `fitPinned` keeps pinned skills in order until the first
   that does not fit and drops it and the rest (`log.warn("pinned skills over the limit")`); the
   agent page shows the warning ("runs keep what fits" when the list is unchanged, "saving is
   refused" when it changed).
9. **`pinned_changed` semantics**: for a non-baseline reconstruction without `definition_missing`, the
   candidate's `skills.pinned` (deduplicated, capped at 3) is compared with the **original agent
   version's** `skills.pinned` (same normalisation); the recorded snapshot's pinned ids only when that
   definition is missing. A params-only replay of a run whose original version pins a since-deleted
   skill therefore shows no drift.
10. **Updated-skills notice** (ruling on review M3): when a snapshot has `pinned`, its pinned ids are
    left out of the "Updated skills (call skill_load again …)" list, and the catalog part is skipped
    when nothing else in it changed (the pinned notice carries the new body). Logs without `pinned`
    render exactly as before; for them a later snapshot renders the catalog change text when the
    skills differ or when neither pinned nor the map differ, which keeps every pre-phase-B log
    byte-identical.
11. **Pinned read failures**: a permanent failure (no SKILL.md in the manifest, missing object,
    integrity mismatch, non-UTF-8, unparsable) is logged at error with the skill id and source,
    is not retried, and fails the run before any model request with code `storage.unavailable`,
    `details: [{ reason: "pinned_unreadable", skillId, name, source }]` and the owner-facing message
    `Pinned skill "<name>" cannot be read; ask the agent's owner to unpin it or upload it again.`
    A transient failure says `File storage is temporarily unavailable, so this agent's pinned skills
    cannot be read; send the message again later.` Pinned skills that keep changing during the read
    (three attempts) fail the run with `conflict`: `The pinned skills kept changing while the run
    started; send the message again.` A tampered object fails the run rather than silently unpinning.
    The web shows `errors.run.pinned_unavailable` (plus the kernel's line) and
    `errors.run.pinned_conflict`; the attachment-storage text is unchanged.
12. **`appendCatalog` normalizes pinned**: an entry stays only while `skills` holds the same id,
    version and source (pinned ⊆ skills), and bodies are re-fitted to 32768 bytes; this covers the
    shared-agent trial of `skill_write` and a name-shadowing write.
13. **Suggest pinned on upgrade** (review M7, fixed in the final wave): `skill_versions.suggest_pinned`
    is written when an install or upgrade writes a new skill version; for an unchanged skill the
    upgrade's finishing transaction (the version switch) sets the target's flag on the skill's
    current version when that version comes from the plugin's catalog item (a version the org
    uploaded since is left alone). Rolling back flips it back the same way.
14. **Web**: `pinnedSuggestions` is sent only when the admin changed the ticked set (a confirm without
    changes posts exactly `{ reviewHash, deployExtension }`); "expanded by default" (§8.4) is the
    "Suggest pinned" disclosure being open when `sessionStart`; the catalog item shows the latest
    version's report and license plus a format column per version; translation messages name only
    the always-present detail keys of a code, optional ones are extra lines. The agent page's
    over-limit warning sums `entryBytes` (whole SKILL.md), while the run fits UTF-8 body bytes, so the
    page warns slightly earlier than a run drops a skill.
15. **Translated personal templates at org install** (fixed in the final wave): a template with
    `ownership: "personal"` and a static credential needs the installer's own credential in
    `connectors.<id>.credential` (`ConnectorsService.create` lists tools with it and stores it as the
    installer's personal credential). Install planning's `missingTemplateInput` now asks for it, so
    an install (or an upgrade adding such a template) without it is 400 at
    `connectors.<id>.credential` before anything is written, instead of 502 `plugin.install_failed`
    (`credential.missing`) at the connector step; a dependency's template still says "install it on
    its own first". The web wizard asks the installer for their own credential (required before
    going on) with a hint that other members add theirs in My connections. A changed template on an
    existing personal connector (upgrade `credentialsChanged`) stays optional, as before. Follow-up
    (not built): create personal static connectors without a first `listTools`, as `oauth_code`
    ones are, taking the snapshot at the first member's connect.
16. **Git tree reads**: `readGitTree` caches parsed trees by oid during one walk (the visit bound is
    unchanged); a tree-only DAG with many paths took seconds under load before.
17. **License too long** (batch-3 m6, final wave): `catalog_item_versions.license_truncated` records
    what the review's `licenseTruncated` said; the version API returns `licenseTruncated` and the
    catalog item page shows the "too long" line.
18. **Web, final wave**: the pinned picker judges stale pins only once both the org and the agent's
    own skill lists are read (a loading or unreadable list keeps the pins and shows a status line);
    report items whose group the web does not know are listed under "Other"; the marketplaces page
    lists the first 20 skipped entries and how many more (plural title); a SKILL.md body, skill
    description or LICENSE with bidi or control characters gets a warning line on the import review.

**Acceptance status** (§12 Phase B; files under `packages/kernel/test/catalog/` unless stated): all
four items are covered end to end on one kernel with `model-fake`, a local fake git server and no
network in `claude-superpowers.e2e.test.ts`:

- adding the superpowers repository as a git marketplace and importing superpowers, the report
  listing hooks, commands and the other ignored parts: "adding the superpowers repo as a git
  marketplace and importing superpowers; …" (`hooks_not_run SessionStart`,
  `command_manual_invocation brainstorm`, `agent_needs_subagents code-reviewer`,
  `other_harness .codex-plugin`, `sessionStart: true`, MIT license text); also `claude-import.test.ts`
  and `claude-git-marketplaces.test.ts`; the live `claude-live.test.ts` imports the real
  `https://github.com/obra/superpowers.git` (≥ 10 skills, `sessionStart`, MIT) only with
  `CAPYBARA_TEST_CLAUDE_SUPERPOWERS=1` (behind a proxy add `CAPYBARA_TEST_HTTPS_PROXY=<url>`, used as
  `net.httpsProxy`);
- the admin ticks `using-superpowers` as pinned, the org installs it, an agent selects the skills and
  pins it: "the admin ticks using-superpowers as pinned and the org installs it; …" (`GET skills`
  shows `suggestPinned`); also `claude-install.test.ts`, `packages/kernel/test/agents/pinned-skills.test.ts`
  and the web tests (`apps/web/test/agent-skills.test.tsx`, `apps/web/e2e/skills.spec.ts`);
- the model loads `brainstorming` (`superpowers:brainstorming` also loads): "asked for a new feature,
  the model loads brainstorming first (…)" (the first request's `system[0]` holds the
  `<pinned_skill name="using-superpowers" version="1">` block and the tool map; both `skill_load`
  results hold the brainstorming body); also `packages/kernel/test/skills/skills-runtime.test.ts`;
- replaying that conversation reproduces its requests exactly: "replaying that conversation
  reproduces its requests exactly" (every `model_call` reconstructed with `drift: []` and equal to
  what the provider received; a full-run replay with zero `tool_unmatched` sends the same requests);
  also `packages/kernel/test/evals/reconstruct.test.ts` (the pinned / tool map / compaction baseline
  and the `pinned_changed` drift cases).

The translated template with the real `connector-mcp` (endpoint checked, org install with a bearer,
tools listed) is `plugins/connector-mcp/test/claude-template.test.ts`, which uses only
`@capybara-hq/testing` and moves with the plugin in A3b.

**Not built in B**: a root-source entry's `skills` restricting the default scan (re-check item 8);
`claude plugin validate` against the fixtures; `contentChanged` for entry-only changes and for
entries whose version differs from `plugin.json` (rulings 3, 4); personal static connectors created
without a first `listTools` (ruling 15's follow-up); Claude npm sources with registry integrity
(§14); commands, `disable-model-invocation` skills (phase D) and agents (phase C).

**Known limitations** (final review, recorded rather than fixed):

- **Pinned bodies are read on every run start** (m3): `recordSkillsCatalog` reads each pinned
  SKILL.md from object storage (up to three GETs plus sha256) even when the latest snapshot already
  holds the same pinned id, version and source, so a storage blip fails a run whose pinned set did
  not change although the bodies are in the log. Option: read `lockLatestCatalog` first and reuse
  the logged bodies when the candidates are the same; decision 9 stays for changed pins.
- **`MarketplaceEntryView.format` is unused by the web** (m4): the marketplace entry list shows no
  "Claude Code" marker although the field is there (cosmetic).
- **`</pinned_skill>` in a pinned body closes the wrapper early** (m5): `pinnedBlock` does not escape
  it; native skills have the same exposure and the owner chose to pin. Escaping would change
  model-visible text, so it can only apply to new snapshots (bodies render from the log).
- **A relocated root `SKILL.md` takes every non-excluded file** (m6): a repository with `SKILL.md`
  at the root and a large `docs/` or `src/` can exceed the skill package limits, which refuses the
  import (`catalog.invalid_manifest` from `checkContent`) instead of a `skill_invalid` item.

## 0. Background

It started with a question: can [obra/superpowers](https://github.com/obra/superpowers) (MIT, process
skills for coding agents) run on Capybara? Checking showed:

- every skill in it is a valid Agent Skill, so M5's skills can take them as they are;
- but it is distributed as a **Claude Code plugin**: a repo is a marketplace
  (`.claude-plugin/marketplace.json`), the plugin manifest is `.claude-plugin/plugin.json`, and
  components sit in conventional directories (`skills/`, `agents/`, `hooks/`, `.mcp.json`, …);
- the two things it relies on most are missing in Capybara:
  - forced injection at conversation start (a SessionStart hook puts the whole of `using-superpowers`
    into context);
  - sub-agents (`subagent-driven-development`, `dispatching-parallel-agents`);
- the same repo carries `.codex-plugin/`, `.cursor-plugin/` and so on: each platform has its own
  manifest, and **only `skills/` is shared**;
- in the ecosystem a "plugin" is a bundle, while Capybara calls in-process code a plugin and the
  bundle an "app". The words don't line up.

The maintainer's requirements and decisions (2026-10-22, all **(decided)**):

1. Be compatible with the Claude Code plugin format, and define Capybara's own `.capybara-plugin/`.
2. Like Claude Code, **a repo is a marketplace**; Capybara runs an official marketplace.
3. Review the existing extension mechanisms as a whole and **reuse them**: one complete mechanism, no
   parallel wheels.
4. Every manifest is JSON, never YAML.
5. One official repo, **`capybara-hq/plugins`** (two repos: core + plugins):
   - the sources of the official extensions move out of core into it;
   - its marketplace manifest declares every official component, including the ones core installs by
     default;
   - GitHub Actions publish it to npm.

   The repo name and the marketplace name are unrelated; a repo "is a marketplace" only because it
   carries a manifest. The official marketplace is this repo, and it is enabled by default once live
   **(decided, 2026-10-24)** (§5.5).
6. Core ships `packages/kernel/bootstrap.json`, which pins the components installed by default and
   their versions; deployment init installs them. This replaces D13's built-in plugins.
7. **Terminology refactor** (after M7; before the first public release, with no compatibility
   aliases **(decided, 2026-10-24)**):
   - "plugin" (插件) means the install and distribution bundle, like a Claude Code plugin
     (`.capybara-plugin/plugin.json`; components: an extension, skills, connector templates (remote
     MCP), agent templates, hooks via the extension, UI; plugins may depend on plugins);
   - the old in-process "plugin" becomes an **extension** (扩展);
   - "capability" (能力) becomes **extension point** (扩展点), and means only a versioned contract;
   - `ctx.*` is the **platform API**;
   - "catalog source" (目录来源) becomes **marketplace** (市场); the enterprise directory's English
     identifier becomes **catalog**, freeing `directory` for directory sync (通讯录);
   - "app" (应用) as a bundle is retired; only "external app" (外部应用) remains;
   - 对话 (conversation) vs 会话 (session, login only) in Chinese UI text.
8. Org-level in-place upgrade of an installed plugin is in scope, in phase A.
9. Version ownership: a plugin that contains an extension follows the deployment version; a purely
   declarative plugin has per-org versions and rollback (§10).

## 1. Terms

### 1.1 Old and new

| New term | Chinese | Meaning | Was |
|---|---|---|---|
| **plugin** | 插件 | The install and distribution unit, like a Claude Code plugin. Manifest `.capybara-plugin/plugin.json`. Holds the components below; may depend on other plugins | app bundle (D17, C31) |
| **extension** | 扩展 | The in-process code inside a plugin: `ctx`, the permission manifest, approval, providing and consuming extension points. At most one per plugin | plugin (D14) |
| **extension point** | 扩展点 | A platform contract with a major version, e.g. `channel@1`. An extension **provides** it or **consumes** it (`requires` / `optional`) | capability |
| **registration** | 注册项 | What an extension registers through the platform API: tools, hooks, HTTP routes, UI, tables. Unversioned, declared in the permission manifest | — |
| **platform API** | 平台接口 | `ctx.db`, `ctx.kv`, `ctx.storage`, `ctx.tools`, `ctx.hooks`, `ctx.ui`, … | platform capabilities |
| skill | 技能 | unchanged | |
| connector template | 连接器模板 | Endpoint and auth preset (C30). The landing spot for a Claude plugin's remote MCP servers | unchanged |
| connector | 连接器 | A configured remote service instance in an org | unchanged |
| agent template | agent 模板 | An agent definition inside a plugin, for sub-agents (§11) | — |
| **marketplace** | 市场 | A manifest listing importable plugins and where to get them; hosted in a git repo or at an https URL | catalog source (`catalog_sources`) |
| **catalog** | 企业目录 | The plugins imported into a deployment and available for orgs to install | enterprise directory (`directory_items`) |
| bootstrap plugin | 预装插件 | A plugin declared in `bootstrap.json` and installed at deployment init | built-in plugin (D13, C14) |
| conversation / session | 对话 / 会话 | 对话 is talking to an agent; 会话 is only a login session | mixed in the UI |
| external app | 外部应用 | A third-party system calling the kernel over HTTP (the three-layer model). The only meaning "app" keeps | three meanings |
| embed | 嵌入页面 | An iframe UI provided by an extension | embedded app |

- `directory` stays the English name of the directory-sync extension point `directory@1` and its
  routes (`/api/v1/orgs/:orgId/plugins/:plugin/directory`).
- Model features such as `capabilities.vision` / `documents` are properties of a model, not extension
  points, and are not renamed.

### 1.2 Extension points today (`CAPABILITIES` in `packages/plugin-sdk/src/capability.ts`, renamed `EXTENSION_POINTS`)

| Extension point | Purpose | Cardinality | Access | Org-scoped |
|---|---|---|---|---|
| `model-provider@2` | model vendors | multi | brokered | no |
| `connector@1` | connector protocols (MCP, OpenAPI) | multi | brokered | no |
| `channel@1` | IM channels | multi | pass-through | yes |
| `identity-source@1` | third-party login | multi | pass-through | no (deployment) |
| `directory@1` | directory sync | multi | pass-through | yes |
| `sandbox@1` | sandboxes | single | brokered | no |
| `object-store@1` | object storage | single | brokered | no |
| `secret-store@1` | secret storage | single | brokered | no |
| `config-source@1` | startup config source | single | pass-through | no |
| `counter@1` | test example | multi | pass-through | no |

- Reserved: `embedding-provider@1`, `rerank-provider@1` (with `ctx.models`, deferred until a consumer
  exists).
- "Brokered" means usable only through the platform API; "pass-through" means reachable through
  `ctx.capabilities` (renamed `ctx.extensionPoints`).
- Registrations (tools, hook mount points, routes, UI, tables) are not extension points.

## 2. Goals, non-goals, anti-goals

**Goals**

- **One install unit: the plugin.** It is read from three forms:
  - a tgz (npm or upload);
  - a repo directory with `.capybara-plugin/`;
  - a Claude Code plugin directory (translated).

  After reading, all three go through the same import, review, catalog, org install, upgrade and
  uninstall flow.
- **One kind of source: the marketplace.** A marketplace is a manifest at an https URL or a git repo;
  a repo's manifest may be in Capybara or Claude Code format.
- **Two repos**: core holds only the platform; every official plugin lives in `capybara-hq/plugins`,
  which is also the official marketplace.
- **Bootstrap**: core installs its core plugins from `bootstrap.json` at deployment init.
- **Runtime gaps closed** for plugins like superpowers: pinned skills, qualified skill names, a tool-name
  map; sub-agents get their own design (§11).
- **Terminology refactor** done after M7 and before the first public release, so 0.1.0 ships only
  the new names **(decided, 2026-10-24)**.

**Non-goals**

- Running Claude Code hooks of any type (shell command, http, prompt, …). The kernel never runs
  third-party commands on its own hosts. Capybara hooks come only from extensions through `ctx.hooks`.
- stdio MCP (accepted in M6, C32).
- The local IDE / terminal parts of Claude Code plugins: LSP servers, output styles, themes,
  monitors, `bin/`, `settings.json`, `userConfig`, channels.
- A public marketplace service (hub). A marketplace is a repo, in line with D16.
- Codex, Cursor or other platform manifests in this project. Readers are per format and can be added
  later.
- Building code at install time (D14 unchanged).

**Anti-goals** (failures even if it technically works)

- Two parallel install paths: e.g. Claude plugins bypassing review or the uninstall ledger, or the
  repo form and the tgz form keeping separate data.
- A Claude plugin that "installs successfully" while part of it silently does nothing. Everything not
  translated is listed item by item on the review page, with the reason.
- The kernel pulling and enabling new content because a marketplace repo got a new commit. C25's
  "browse first, materialize on import, new versions are imported by hand" still holds.
- The first release shipping any old name in a published artifact (SDK exports, package formats,
  routes, config keys, CLI), which would turn it into a name to keep compatible.
- The repo split making a contract change in core undetectable until the plugins repo breaks.

## 3. How existing mechanisms fold in (as of `main` after M7)

| Existing mechanism | After |
|---|---|
| Plugin package (D14 / C11: npm-pack tgz, `capybara` section with `kind: "plugin"` in `package.json`, single-file ESM `dist/index.mjs`, only `@capybara-hq/plugin-sdk` and `zod` host-provided, static manifest, permission manifest) | Becomes the **extension component** of a plugin. Packing rules, permission manifest, approval and the no-restart lifecycle (D15) are unchanged; the static manifest moves from the `capybara` section to `plugin.json` |
| Connector-template and skill packages (C21, `kind: "connector-template"` / `"skill"`) | Replaced by a plugin with one component |
| App bundle (C31, `kind: "app"`, `app.yaml`) | Replaced by a plugin with dependencies: referenced plugins become dependencies, templates and skills become components |
| Enterprise directory (`directory_items` / `directory_item_versions`, four kinds, policies allow / needs_approval / disabled, `directory_requests`, `directory_org_grants`) | Renamed to the catalog; only one kind remains (plugin). Policies, requests and approvals unchanged |
| Catalog sources (D16, `catalog_sources` / `catalog_entries`, `index.json` v1, `parseCatalogIndex`) | Renamed to marketplaces; adds the git form; `index.json` is replaced by `marketplace.json` |
| Org app install (T26, `app_installs`, `app_install_components`, `AppInstaller`) | The **only** org install flow, for plugins. Component ledger unchanged; adds in-place upgrade (§10) |
| Deployment plugin install (`plugin_installs`, `plugin_packages`, content-addressed store, `plugin_directory_sources`) | Becomes the deployment install of extensions (renamed `extension_*`) |
| Built-in plugins (D13 / C14, source `builtin`, `BUILTIN_PLUGINS` in the CLI) | Bootstrap plugins declared in `bootstrap.json` (§7) |
| Config-declared plugins (C15, `plugins` / `pluginConfig`, source `config`) | Unchanged in role (dev mode and existing deployments); renamed keys (§13) |
| `ctx.hooks` (M7) | Unchanged; an extension registration. Not used to translate Claude hooks |
| Agent definition `skills` (`orgSkills`, `writePolicy`) | Gains `skills.pinned` (§9.1); sub-agent templates later (§11) |
| Skill and connector provenance (`skills.directory_item_id`, `skill_versions.directory_item_id`, `connectors.directory_item_id`) | Reused as the "which plugin did this come from" record (§9.2) |
| npm release (`tools/release`, `release.yml`, changesets, provenance, `integrity.json` artifact) | The base of the plugins repo's release (§6) |
| Contributor workflow (`capybara-hq/.github`, `gate.yml@v1`, synced skills, rulesets) | The plugins repo is its second consumer (§6.2) |

**What is actually new**:

- the unified plugin manifest;
- the git form of marketplaces and `marketplace.json`;
- the Claude Code reader;
- pinned skills, qualified names, the tool-name map;
- org in-place upgrade;
- `bootstrap.json` and the bootstrap step;
- the plugins repo and a published plugin toolchain;
- sub-agents (separate design).

Everything else is reuse and renaming.

**As built in phase 0b** (plan `docs/superpowers/plans/2026-10-25-ecosystem-phase0b-formats.md`):

- **The catalog routes are the plugin routes** **(decided, 2026-10-25)**: there is no separate
  `/api/v1/admin/plugins`. Import is `POST /api/v1/admin/catalog/import/file` / `…/import/npm` (prepare,
  `{ stagingId, review }`), `GET …/catalog/imports/:stagingId` (the staged review again, so a review link
  can be shared or reopened; 404 once expired or confirmed) and `POST …/catalog/imports/:stagingId/confirm
  { reviewHash, deployExtension }`; a marketplace import is `POST /api/v1/admin/marketplaces/:id/entries/
  :name/import { version? }`, confirmed through the same route. `POST …/catalog/items/:id/install-deployment`
  installs an item's extension (`catalog.no_extension` without one). Org install stays
  `POST /api/v1/orgs/:orgId/catalog/:itemId/install` with the body `{ version?, connectors?: { <template
  id>: … }, extensionConfig? }`; `GET / DELETE /api/v1/orgs/:orgId/plugin-installs…` are unchanged. No
  aliases for the removed one-step and `plugins/prepare/*` routes.
- **One kind**: the `kind` columns of `catalog_items` and `marketplace_entries` and every `kind`
  parameter are dropped; a catalog version stores the normalized `plugin.json` (`manifest`) and
  `extension_sha256`; marketplace entries are keyed by `(marketplace, name, version)`
  **(decided, 2026-10-25)**.
- **Old catalog content is removed by migration 0044** **(decided, 2026-10-25)**: every catalog item
  predates the new format and cannot be converted in SQL (the bundle manifests live only in object
  storage), so 0044 deletes catalog items, versions, org plugin installs and their components,
  requests, grants, extension catalog sources, staged imports and marketplace entries (refetched at
  the next refresh), and unlinks org skills, connectors and extension installs from them. Org skills,
  connectors and deployment extension installs stay. Objects under `deployment/directory/` are left
  unreferenced. Only development databases have such rows.
- **Legacy extension blobs need a repack** **(decided, 2026-10-25)**: a stored extension package in the
  old format is not read (`extension.legacy_format`); the admin console shows "Repack needed" and
  every replica records it failed until it is reinstalled from a repacked tgz. Builtin extensions load
  from module paths and are unaffected.
- **Zip upload to the catalog is removed; a plugin is always a tgz** **(decided, 2026-10-25)**: skills and connector
  templates reach the catalog only inside a plugin tgz. (An org's own skill upload as zip, M5, is unchanged.)
- **The CLI**: `capybara plugins list` and `capybara plugins import <file.tgz | npm:…>
  [--deploy-extension] [--yes]` run the same review against PG. A plugin with files needs object
  storage, which the CLI gets by running the object-store extension's `setup` with only `ctx.config`
  / `ctx.provide`, and only for a builtin or config-declared provider that is approved and configured;
  otherwise it refuses with `storage.unavailable` **(designer's call)**. The CLI loads no connector
  extensions, so templates of connectors from outside the plugin get only the static checks there.

## 4. Plugin format

### 4.1 Layout and manifest

A plugin is a directory (repo form) or that directory packed as a tgz (npm / upload form):

```
<plugin root>/
  .capybara-plugin/plugin.json    plugin manifest (optional, see below)
  skills/<name>/SKILL.md          skills (scanned by default)
  connectors/<id>.json            connector templates (scanned by default)
  agents/<name>.json              agent templates (reserved, §11)
  dist/index.mjs                  extension entry (built, single-file ESM)
  migrations/                     extension migrations
  ui/                             extension UI static files
  package.json                    needed when published to npm; name / version match the manifest
```

The extension paths are the ones `tools/pack-plugin` already produced (`dist/index.mjs`,
`migrations/`, `ui/`), so the extension tgz was already laid out as a plugin
**(designer's call; the draft used an `extension/` directory)**.

`plugin.json` (JSON Schema `packages/plugin-sdk/schemas/plugin.v1.schema.json`, generated by
`pnpm gen:package-schemas`, drift-checked by `check:package-schemas`; files may set `$schema`):

```jsonc
{
  "schemaVersion": 1,
  "name": "superpowers",                                // ^[a-z0-9][a-z0-9-]{0,63}$
  "version": "7.0.1",                                   // semver
  "publisher": "Jesse Vincent",
  "description": "…",                                   // ≤ 1024
  "displayName": { "zh": "…", "en": "…" },              // optional
  "icon": "./assets/icon.svg",                          // optional
  "license": "MIT",                                     // optional, SPDX
  "homepage": "https://…",                              // optional
  "dependencies": [                                     // optional: plugins this one depends on
    { "name": "todo", "version": "^1" }
  ],
  "skills": [                                           // optional; omitted = scan skills/*/SKILL.md
    { "path": "./skills/using-superpowers", "pinned": true }   // pinned: suggested as pinned (§9.1)
  ],
  "connectorTemplates": [                               // optional; omitted = scan connectors/*.json
    { "path": "./connectors/github.json" }              // the template id is the file's base name
  ],
  "agents": [],                                         // reserved; rejected when non-empty until §11 lands
  "extension": {                                        // optional; written by the packer, never by hand
    "entry": "./dist/index.mjs",
    "manifest": {},                                     // StaticExtensionManifest
    "migrations": "./migrations",
    "ui": "./ui"
  }
}
```

(The comments are explanation; real files are strict JSON.)

**Connector template files** **(designer's call)**: each `connectors/<id>.json` (JSON Schema
`connector-template.v1.schema.json`) is strict and holds what C30's package section held, minus the
package fields:

```jsonc
{
  "displayName": { "zh": "…", "en": "GitHub" },
  "description": "…",                                   // optional
  "icon": "./icons/github.svg",                         // optional; .svg / .png in the plugin
  "template": {                                         // C30's template, unchanged, checked by validateConnectorTemplate
    "plugin": "connector-mcp", "pluginVersion": "^0.1.0", "connector": "mcp",
    "endpoint": { "url": "https://…" }, "editableEndpoint": ["url"],
    "auth": { "type": "oauth_code", "ownership": "personal" },
    "defaultToolPolicies": { "search": "allow" }
  }
}
```

- `connectorTemplates` in `plugin.json` lists `{ "path": "./…/<id>.json" }` refs (at most 20); the
  id is the base name (`CATALOG_ITEM_NAME_RE`), unique in the plugin. `skills` likewise lists
  `{ "path": "./…", "pinned"? }` directory refs (at most 50). Listed paths override scanning; a listed
  path that does not exist is an error.
- At import a template is checked against its connector extension when that extension is loaded;
  when the connector is the plugin's own extension or a dependency's, only the static checks run and
  the review says the endpoint was not checked; any other connector that is not loaded refuses the
  import **(designer's call)**. Org install checks again against the connector of the moment.

**As built in 0b** **(designer's call)**: in a tgz, `.capybara-plugin/plugin.json` is always present
(the packer writes it, and a plugin source must have one); "the manifest is optional" below applies to
plugins read from git (phase A) and Claude plugins (phase B). A plugin must contain an extension, a
skill or a connector template.

- **The manifest is optional.** Without `plugin.json` the default layout is read; the name comes from
  the marketplace entry (the repo name for a single-plugin repo) and the version follows §5.3. Same as
  Claude Code. A skills-only plugin can contain nothing else.
- **Paths** are relative to the plugin root, start with `./` and never leave the root
  (`isSafePackagePath`).
- **Names** **(designer's call)**: a plugin name follows the catalog item rule
  (`CATALOG_ITEM_NAME_RE`). A plugin with an extension must have the same name as its extension, so
  its name must also match `EXTENSION_NAME_RE`. The extension's identity
  (PG schema `plugin_<name>`, storage prefix `plugins/<name>/<orgId>/`, tool keys, hook ownership)
  stays keyed by that one name.
- **Dependencies**:
  - only a plugin name and a semver range;
  - resolved against imported catalog versions that satisfy the range; the review page shows the
    result;
  - when unresolved, the enterprise import still completes, but an org install is refused with the
    plugin to import first;
  - no integrity lock in the manifest (unlike C31's `lock`): each dependency was verified against its
    own source when it was imported **(designer's call)**.
- **Extension**:
  - the packer (§6.2) builds `dist/index.mjs` and writes the static manifest into
    `plugin.json` → `extension.manifest`, as `pack-plugin` writes `capybara.manifest` today;
  - loading still checks the static manifest against the module's exported manifest
    (`manifest_mismatch`);
  - at most one extension per plugin.
- **A plugin read from git** that contains an extension must contain its built `dist/index.mjs`
  (committed, as GitHub Actions do), otherwise it is rejected with "the plugin has an extension but no
  build output".
- **When both `.capybara-plugin/` and `.claude-plugin/` exist**, Capybara's wins; the review page says
  so.

### 4.2 The M6 / M7 formats are replaced, not read **(decided, 2026-10-24)**

Nothing has been published, so phase 0 replaces the M6 / M7 formats instead of keeping readers for
them (no compatibility aliases):

| M6 / M7 format | Replaced by |
|---|---|
| Extension tgz (`package.json` `capybara.kind = "plugin"`, `CapybaraPackageSection`) | a plugin with only an extension (`plugin.json` with `extension`) |
| Skill / connector-template package (C21) | a plugin with one component |
| App bundle (C31, `capybara.kind = "app"`, `app.yaml`) | a plugin with `dependencies`, templates and skills |
| `index.json` (D16) | `marketplace.json` (§5.2) |

Phase 0 converts every package, fixture and test in core to the new format, removes the
`capybara` section, `PACKAGE_KINDS`, `app.yaml` and `parseCatalogIndex`, and regenerates the JSON
Schemas. **The SDK keeps its `yaml` dependency** **(decided, 2026-10-25)**: `parseSkillMd` reads SKILL.md
frontmatter, which is YAML by the Agent Skills format; only `app.yaml` goes (the earlier text assumed
`yaml` served only `app.yaml`; "every manifest is JSON" is about Capybara's own manifests). A tgz in an
old format is rejected with `catalog.legacy_format` / `extension.legacy_format` and a message naming the
new format and `pnpm pack-plugin` **(designer's call: follows from no aliases)**.

### 4.3 Review and permissions

- Importing a plugin has exactly one review (as C31's prepare / confirm with `reviewHash`):
  - the extension's permission manifest (sensitive entries highlighted, as `permission-view.ts`);
  - each skill's body (expandable);
  - connector templates' endpoints and auth requirements;
  - the dependency resolution;
  - the source (host, repo, commit sha or integrity; npm provenance when present, §5.5);
  - the license;
  - for Claude plugins, the translation report (§8.4).
- **Permission approval is for the extension**: a purely declarative plugin needs no permission
  approval, only content review.
- An extension upgrade that asks for more permissions needs re-approval, as today (D15,
  extension-model spec §7.3).

## 5. Marketplaces

### 5.1 Two forms

| Form | Address | Manifest file | Refresh |
|---|---|---|---|
| http (D16, exists) | https URL, optional mirrors | `marketplace.json` | ETag, as C26 |
| **git (new)** | https git URL; `owner/repo` expands to `https://github.com/owner/repo.git`; optional branch or tag, default branch otherwise | at the repo root, in order: `.capybara-plugin/marketplace.json` → `.claude-plugin/marketplace.json` → a single plugin (below) | periodically resolve the branch head; skip when the commit is unchanged |

- **Single-plugin repo**: no marketplace manifest at the root, but the root is a plugin (it has
  `.capybara-plugin/plugin.json`, `.claude-plugin/plugin.json` or `skills/`) → a marketplace with one
  entry. An enterprise admin can paste any repo URL.
- Each refresh records the commit sha; browsing and import are based on it (C25: browsing caches only
  the manifest; import downloads and materializes).
- Refresh runs as today: one maintenance job for all replicas every
  `catalogs.refreshIntervalMinutes` (renamed `marketplaces.refreshIntervalMinutes`).
- **Git access constraints** (the implementation is the builder's choice: a git client library or the
  host's archive API):
  - https only, no cross-host redirects;
  - loopback and private addresses denied by default (this also closes the M7 deferred item
    "private-network default-deny for catalog tarball downloads", for every marketplace download),
    with a testing-only `allowInsecureLoopback` like `catalogs.allowInsecureLoopback`;
  - one shallow commit or archive; no submodules, no LFS;
  - total size, file count and time limits, reusing `packages.maxBytes` and adding what is missing;
  - an optional access token stored in secrets, like C26's enterprise catalog token
    (`catalog-token:<id>`).
- **Offline deployments** mirror the repo to an internal GitLab and point the marketplace at the
  mirror; npm sources go through `packages.npmRegistry` (an internal npm mirror).
- **Entries pointing to other repos or hosts** **(designer's call)**:
  - allowed; Claude marketplaces do it all the time;
  - fetched under the same constraints;
  - the review page and the catalog version record **the actual host, repo and commit sha**, and say
    "follows a branch" when no `commit` is pinned;
  - an enterprise admin may set an optional host allowlist `marketplaces.allowedHosts` (default:
    unrestricted). Entries outside it show as not importable.
- **Importing one plugin straight from git** **(designer's call)**: a one-off like file upload; no
  marketplace is created and no updates are tracked. The catalog records repo, commit sha and path,
  then the same review and materialization. To track updates, add the repo as a marketplace.

### 5.2 Marketplace manifest (`marketplace.json`)

```jsonc
{
  "schemaVersion": 1,
  "name": "capybara-official",                          // display name, unrelated to the repo name
  "owner": { "name": "Capybara", "url": "https://…" },
  "description": "…",
  "plugins": [
    {
      "name": "superpowers",
      "summary": { "en": "…", "zh": "…" },
      "version": "7.0.1",                               // optional; defaults to the plugin's own (§5.3)
      "minKernel": "1.0.0",                             // optional
      "permissions": { "keys": [], "sensitive": [] },   // optional, display only (as C26)
      "source": { "path": "./plugins/superpowers" }     // one of four, below
    }
  ]
}
```

The entry list is called `plugins`, as in Claude's `marketplace.json`. `source` is one of:

| Form | Shape | Notes |
|---|---|---|
| same-repo path | `{ "path": "./plugins/x" }` | read at this refresh's commit |
| git | `{ "git": { "url": "https://…", "ref": "main", "commit": "<40 hex>", "path": "." } }` | `ref`, `commit`, `path` optional; with `commit` that commit is used, otherwise `ref`'s head at refresh time, recorded |
| npm | `{ "npm": { "package": "@x/y", "version": "1.2.0", "integrity": "sha512-…" } }` | integrity is `SHA512_INTEGRITY_RE`; downloads are verified against it, never npm metadata (AGENTS.md) |
| archive | `{ "archive": { "url": "https://…/x.tgz", "integrity": "sha512-… or sha256-…" } }` | |

- **Any source may hold any plugin**, as long as what comes back is a valid plugin; a plugin with an
  extension needs its build output (§4.1).
- **Phase 0b imported npm and archive sources only** **(decided, 2026-10-25)**: `path` and `git`
  sources were parsed, validated and stored, but refused at import. **Phase A1 imports them**
  ("Phase A1 as built"): a `git` source at its pinned `commit`, else at its `ref`'s head resolved at
  import (not at refresh) and recorded; a `path` source from a git marketplace's own repository at its
  last refreshed commit. `marketplace.source_unsupported` is gone. `version`, when given next to an npm source, must equal
  `source.npm.version` **(designer's call)**.
- It replaces D16's `index.json` (never published, §4.2), so it starts at `schemaVersion: 1`. One
  entry is one version; a marketplace that wants several versions lists the plugin once per version
  **(designer's call)**.
- JSON Schema `packages/plugin-sdk/schemas/marketplace.v1.schema.json`, generated and drift-checked
  as `catalog-index.v1.schema.json` was (which it replaced; removed in phase 0b). Unknown fields are
  ignored (forward compatible), as in `index.json`.

### 5.3 Versions and "a new version is available"

- **Entry version**, in Claude Code's order for both formats **(designer's call)**: the plugin manifest
  (`plugin.json` / `package.json`) → the entry's `version` → `0.0.0-git.<sha12>` (archives:
  `0.0.0-sha256.<12>`).
- **Ordering**: semver, ignoring build metadata; two versions that differ only in build metadata
  (`1.0.0` vs `1.0.0+git.abc`) are ordered by import time. Range matching ignores build metadata too.
- **Content digest**: on import, sha256 over the normalized file tree (sorted by path, hashing path
  and content), stored with the source commit sha or integrity on the catalog version. As built:
  Decision 5 of "Phase A1 as built"; the git fallback is `0.0.0-git.g<sha12>` and the archive one
  `0.0.0-sha256.h<12>` (the letter keeps an all-digit hash valid semver).
- **Same version, changed content**: when a repo moves on, the version is unchanged but the digest
  differs, the UI says "content changed at the same version". Re-importing records
  `<version>+git.<sha12>` (semver build metadata) and never overwrites the imported version.
- Otherwise as C25: notify, never pull automatically.

### 5.4 What is stored (designer's call)

- Each catalog version keeps **the upstream file tree byte for byte**, plus:
  - the normalized plugin manifest (the original for native plugins, the translation for Claude
    plugins);
  - the translation report (Claude plugins only).
- Org installs use the stored manifest and never re-translate; a translator upgrade affects only later
  imports.
- The digest covers only the upstream tree, so a translator change never reports "content changed".
- Choices the admin makes on the review page (e.g. "suggest pinned") are the version's **review
  choices**: not in the digest, in `reviewHash`, and carried to the next imported version of the same
  plugin as defaults.
- Where bytes live is unchanged: extensions in the content-addressed package store
  (`plugin_packages`, `plugin_blobs`), other files in object storage under the catalog version prefix
  (today `directory/<item_id>/<version>/`).

### 5.5 Trust in the official marketplace

M7 deferred "package and catalog signing beyond npm provenance" to this project. Phase A adds **no
new signature scheme** **(decided, 2026-10-24)**. Instead (details designer's call):

- the trust anchor of a marketplace is its https origin plus, for git, the commit sha the admin
  browsed; for npm sources the sha512 in the manifest at that commit;
- for npm sources, import also fetches the package's npm provenance attestation when the registry
  offers one and shows "built from `<repo>@<sha>` by `<workflow>`" on the review page; a mismatch
  between the attested repo and the marketplace's declared repo is a warning, not a refusal; offline
  imports show "provenance not checked" (built in A1: Decision 7; the mismatch warning for git
  marketplaces only);
- strict verification (refuse without valid provenance, or a signed manifest) is a later option that
  the stored records allow without migration.

**The official marketplace** is `capybara-hq/plugins` (`.capybara-plugin/marketplace.json` at its root)
and is **enabled by default once it is live** **(decided, 2026-10-24)**. Phase 0 renames the config to
`marketplaces.official.*` while it is still off (F1); phase A, when the repo publishes, sets
`marketplaces.official.url` to `https://github.com/capybara-hq/plugins.git` and the default of
`marketplaces.official.enabled` to `true`. Browsing is read-only and nothing is imported without an
admin; offline deployments set it to `false`, and bootstrap plugins need no network either way.

## 6. Repos and release

### 6.1 Two repos (decided)

| Repo | Holds | Publishes |
|---|---|---|
| `capybara-hq/core` (this one) | `plugin-sdk`, kernel, `testing`, `design`, CLI, web, checks and tools, `packages/kernel/bootstrap.json`; test-only extensions (§6.3) | npm: SDK, kernel, testing, the plugin toolchain (§6.2); images: the four ghcr images |
| **`capybara-hq/plugins`** | every official plugin (with or without an extension) and `.capybara-plugin/marketplace.json` | npm: every plugin, as its plugin tgz, with provenance |

- **Moved out of core**: model providers (`anthropic`, `openai`, `openai-compatible`); channels
  (`slack`, `lark`); connector protocols (`connector-mcp`, `connector-openapi`); sandboxes
  (`sandbox-docker`, `sandbox-e2b`); object storage (`object-store-s3`); `todo`; and the reference
  implementations `example-counter` and `example-board`, which become examples in the plugins repo
  **(designer's call)**.
- **Stays in core**: `model-fake` (the compose smoke test and the no-key trial use it) and the
  test-only extensions of §6.3.
- **Every official plugin is published to npm, including purely declarative ones**
  **(designer's call; revises the draft, which read declarative plugins from the repo path)**. One
  source kind for the official marketplace means one integrity rule (sha512), bootstrap can pin every
  entry the same way, and offline deployments mirror one thing (npm). The packer packs a declarative
  plugin without running esbuild.
- The marketplace `name` is `capybara-official`, shown as "Capybara official".

### 6.2 What the plugins repo needs from core and from `.github`

**From core** (all published to npm):

- `@capybara-hq/plugin-sdk` and `@capybara-hq/testing` (already published: dual-replica helpers, fake
  platforms such as `startFakeSlack` / `startFakeMcpServer`);
- **a published plugin toolchain** **(designer's call)**: today `tools/pack-plugin` and `tools/checks`
  are private. Core publishes one package, `@capybara-hq/plugin-tools`, with a `capybara-plugin` bin:
  - `pack` (from `tools/pack-plugin`, extended to write `plugin.json` and pack declarative plugins);
  - `check` (the plugin-scoped checks moved out of `tools/checks`: the plugin / SDK boundary of
    `check:deps`, `check:extension-permissions` including `perm-hooks` / `perm-ui` / `perm-storage`,
    `check:plugin-pack`, the tool design rules, plugin migrations);
  - the checks keep their red-fixture tests, now in core's `plugin-tools` package, and core's own
    `pnpm check` runs the same code against core's test extensions.
- The SDK API snapshot (`check:sdk-api`, `check:sdk-api-changeset`) matters more: the plugins repo
  builds against published SDK versions.

**From `capybara-hq/.github`** (the contributor-workflow spec, §8 there; the plugins repo is its
second consumer):

- `pnpm doctor:env` and `pnpm verify` with the same contract as core (JSON with `--json`);
- `community.yml` calling `gate.yml@v1` (status `issue-linked`), and `ci-ok` as the only required CI
  check;
- synced copies of the shared skills (`onboarding`, `contributing`, `reviewing-prs`) with
  `check:synced-skills`;
- the rulesets applied by the settings script (`main-quality`, `main-review`, `main-merge`),
  CODEOWNERS, the CLA workflow;
- its own `AGENTS.md`, its own diff-based CI plan (one plugin changed → that plugin's tests), stating
  for each check whether it runs in full or by diff on PRs (core's CI policy).

**Author-facing skills move**: `writing-plugins`, `writing-channels`, `writing-connectors`,
`writing-model-providers`, `writing-sandbox-providers`, `writing-object-store-providers`,
`writing-plugin-ui`, `writing-apps` and the plugin half of `writing-tools` move to the plugins repo
(renamed for the new terms, e.g. `writing-extensions`, `writing-plugins` for bundles). Core keeps the
kernel side of each contract (what the kernel owns: locking, leader election, dedupe, redaction, the
`SandboxService` lifecycle) in kernel skills **(designer's call)**.

### 6.3 Core's tests after the split

Today `tools/ci/test-plugins.json` lists the official plugins that core tests load by path
(`packages/kernel/test`: 10 plugins in 30 files; `apps/web/e2e`: 6; `apps/capybara/test`: 2;
`tools/checks/test`: 4; `packages/testing/test`: 1). After the split **core ships its own fake
extensions** **(decided, 2026-10-24)**:

- Core's tests use test-only fake extensions that live in core, e.g. one small fake per extension point
  (`channel-fake`, `connector-fake`, `sandbox-fake`, …), next to the fake platforms that
  `@capybara-hq/testing` already has and `model-fake`. Kernel tests that today use `slack` or
  `connector-mcp` as a realistic provider switch to these. Where they live and which exist is the
  builder's choice (§16).
- **Behavior tests of a real extension move with it** to the plugins repo (they already use
  `@capybara-hq/testing`).
- Core's tests never install published plugins from npm: that would make every contract change wait
  for a plugin release before core's tests could pass.
- `apps/web/e2e` and `docker/test/compose-smoke.sh` use `model-fake` and the fake extensions, plus the
  bootstrap plugins installed the way production installs them (§7), which also smoke-tests the pinned
  versions.
- `check:test-plugins`, `test-plugins.json` and the CI rules in `tools/ci/src/affected.ts` shrink to
  the fake extensions; AGENTS.md's repository map, dependency chain and "CI and checks" change in the
  same PR.

### 6.4 Release of the plugins repo (designer's call)

Built on what M7 shipped in core (`tools/release`, `docs/deploy/release.md`), npm half only:

1. A plugin change lands on `main` of `capybara-hq/plugins` through a PR with a changeset (each
   plugin versioned independently; no `fixed` groups).
2. On push to `main`, the `version-pr` job opens or updates the "Version Packages" PR. **The same job
   packs every bumped plugin and writes its new version and sha512 into `marketplace.json`.** Packs are
   reproducible (pack-plugin's fixed mtime and sorted entries), so the reviewed PR carries the exact
   integrity that will be published. No bot ever commits to `main` (`main-quality` forbids it).
3. Merging that PR runs `publish` (fresh checkout of `github.sha`, `contents: read` + `id-token`): pack
   each version missing from npm, **refuse when its sha512 differs from `marketplace.json`**, then
   `npm publish --provenance` with the dist-tag rule of `distTagFor`. Self-healing and re-runs work as
   in core.
4. The npm planning and publishing code is the npm half of core's `tools/release` (`planPublish`,
   `distTagFor`, `runPublish`), shipped in `@capybara-hq/plugin-tools` (`capybara-plugin release`)
   rather than copied. Moving it to a reusable workflow in `.github` waits for a third repo.

**SDK versions** **(decided, 2026-10-25; replaces the 2026-10-24 "1.0.0 at the split")**. Plugins
declare `sdk: "^0.1.0"`; on 0.x a caret accepts only the same minor, and the extension host refuses an
extension whose range `SDK_VERSION` does not satisfy. Therefore:

- **the first release comes after the repo split (phase A)**, and every package (SDK, kernel, testing,
  the CLI and images, every plugin) starts at **0.1.0**;
- **the SDK stays 0.x until the plugins repo is stable**; 1.0.0 is a later decision;
- while on 0.x, **additive SDK changes ship as patches** (0.1.x, which `^0.1.0` accepts), and **a
  breaking change is a minor** (0.2.0) that every plugin follows with a release declaring the new
  range; the SDK API snapshot and its changeset check make every such change visible.

**Core-side updates**: when plugins are released, a PR in core bumps `bootstrap.json` (by hand or by a
bot PR using a token like `RELEASE_PR_TOKEN`). A contract change needs a PR in each repo; the SDK API
snapshot and semver (a breaking change is a major) make it visible.

**Development mode** (D15): a core developer can load extensions from a local clone of the plugins
repo through config-declared plugins (source `config`); how paths are configured is the builder's
choice.

### 6.5 Rule changes in core

- AGENTS.md: the repository map no longer lists `plugins/*` (only `model-fake` and the test
  extensions); the dependency chain loses the CLI → `plugin-openai-compatible` /
  `plugin-object-store-s3` edges; the "Plugins" rule points to the plugins repo; the CI table loses
  the plugin rows.
- `check:release-metadata`: the plugin rules move to the plugins repo; `@capybara-hq/plugin-tools`
  becomes a published package (README, `files`, NOTICE).
- Core's release workflow publishes `@capybara-hq/plugin-tools` with the SDK, kernel and testing.

### 6.6 As built (phase A3a) and the steps of phase A3b

After A3a (top of this document) core is ready for the move: no core test loads an official plugin
except `model-fake` and two listed exceptions, every plugin's own tests live in the plugin and reach
only published packages, the toolchain is the publishable `@capybara-hq/plugin-tools`, the official
marketplace is configured as the git repository (still off), and the bootstrap pack and
`check:bootstrap --network` understand npm entries. Phase A3b (plan
`docs/superpowers/plans/2026-10-26-ecosystem-phase-a3b-split-release.md`, executed after manual
acceptance of A3a) then:

1. hardens the toolchain for a second repository while the plugins are still in core: published
   plugins resolvable by package name (model-fake from npm in plugin tests), `plugin-test-imports` and
   the plugin rules of `check:release-metadata` move into `capybara-plugin check`, a
   `capybara-plugin marketplace` command writes and checks `marketplace.json` entries (version and
   sha512 per pack), `capybara-plugin release` refuses a pack whose sha512 differs from
   `marketplace.json`, and the bootstrap download gets a token and a size cap; the two web e2e
   specs move onto fakes;
2. prepares core's first release: core publishes only the four libraries and `model-fake`, the
   image release refuses a `bootstrap.json` with workspace entries, the official marketplace
   defaults to on, and the pending changesets are cleared;
3. creates `capybara-hq/plugins` from core's history (`git filter-repo`, every plugin except
   `model-fake`), as a full consumer of `capybara-hq/.github` (settings script, synced skills,
   `community.yml`, `cla.yml`, CODEOWNERS, `pnpm doctor:env` / `pnpm verify`, `ci-ok`, its own
   AGENTS.md and diff-based CI plan) with the author half of the writing skills;
4. releases in this order: core's libraries (SDK, kernel, testing, plugin-tools) and `model-fake`
   at 0.1.0; then every plugin at 0.1.0 from the plugins repository with provenance and a
   `marketplace.json` that carries their sha512; then core moves the plugins out, pins the
   bootstrap entries to npm at the plugins repository's commit (`check:bootstrap --network` on) and
   publishes the 0.1.0 images.

## 7. Bootstrap plugins and `bootstrap.json` (decided; details designer's call)

Core ships `packages/kernel/bootstrap.json`, declaring which plugins a deployment installs by default
and at which version. Deployment init installs them; it is a required step of init. It replaces D13 /
C14's built-in plugins (`BUILTIN_PLUGINS` in `apps/capybara/src/builtin-plugins.ts`, source
`builtin`).

```jsonc
{
  "schemaVersion": 1,
  "marketplace": {                                       // the official marketplace commit, for checking
    "url": "https://github.com/capybara-hq/plugins.git",
    "commit": "<40 hex>"
  },
  "plugins": [
    { "name": "openai-compatible", "npm": "@capybara-hq/plugin-openai-compatible", "version": "1.4.0", "integrity": "sha512-…", "required": true },
    { "name": "object-store-s3",   "npm": "@capybara-hq/plugin-object-store-s3",   "version": "1.1.0", "integrity": "sha512-…", "required": true }
  ]
}
```

- **Fields** **(designer's call)**:
  - `required: true` is a core dependency:
    - installed to the deployment and enabled in **every org** (existing and future), like C14's
      built-ins today (pre-approved, always enabled, no org enablement);
    - can be neither disabled nor uninstalled at deployment or org level; only an enterprise admin
      upgrades it.
  - `required: false` is installed to the deployment and imported into the catalog by default; orgs
    choose to install it as usual, and an enterprise admin may remove it later. (The UI refresh's
    "Artifacts is a plugin, installed by default" fits here.)
- **Every entry is an npm tgz** (§6.1), so every entry is verified by sha512. JSON Schema
  `packages/plugin-sdk/schemas/bootstrap.v1.schema.json`.
- **Consistent with the official marketplace**: every entry must appear, at the same version and
  integrity, in the official marketplace at `marketplace.commit`. A check `check:bootstrap` verifies
  it; it needs the network (GitHub and npm), so it runs by diff on PRs (only when `bootstrap.json`
  changes), always on `main` and in the release workflow (core's CI policy requires stating this). It
  has a red fixture test like every check.
- **Offline**: `docker/kernel.Dockerfile` downloads the pinned tgz files at image build time, verifies
  them by sha512 and bakes them into the image. Init installs from the image, verifies again and
  **never touches the network**.
- The CLI no longer depends on the plugin packages; the kernel no longer receives `builtinPlugins`.
  The `builtin` install source is replaced by `bootstrap`.

**The bootstrap step**:

- It is a CLI command (`capybara bootstrap`, or a phase of `capybara migrate`: builder's choice) run
  by compose's existing `init` service after `migrate` and before `admin create --if-none`. A kernel
  that starts and finds bootstrap not done runs it once itself (deployments without the init
  container).
- Idempotent, under a PG advisory lock, so when several replicas start at once only one runs it.
- Imports each entry into the catalog and installs the extension-bearing ones to the deployment:
  - permission snapshot source `bootstrap`, pre-approved, audited;
  - records are shaped exactly like a marketplace import, with source `bootstrap`.
- Afterwards these plugins are managed **like any other**: visible in the official marketplace and
  upgradable.

**When core is upgraded** (a new `bootstrap.json` raises a version):

- installed version below the manifest's and install source still `bootstrap` (the admin hasn't
  upgraded it by hand): the bootstrap step upgrades it. Core's release vouched for that version, so
  more permissions are pre-approved too, and audited **(designer's call)**;
- installed version above the manifest's: untouched, **never downgraded**;
- a new entry is installed; a removed entry is not uninstalled, it only loses `required`.

**Migration of existing deployments**: plugins with source `builtin` (no install record today) get an
install record with source `bootstrap` on the first bootstrap run, so deployments that ran `main`
before bootstrap upgrade without losing `openai-compatible` / `object-store-s3`. (The first
release now follows phase A (§12), so 0.1.0 already ships bootstrap and this step serves development
deployments **(designer's call)**.)

**As built (phase A2)** (see "Phase A2 as built" at the top for the decisions):

- `packages/kernel/bootstrap.json` lists `openai-compatible` and `object-store-s3`, both
  `"required": true`, as `"source": "workspace"` entries until A3. The SDK owns the format
  (`parseBootstrapManifest`, `bootstrapFileName` = `<name>-<version>.tgz`, schema
  `bootstrap.v1.schema.json`); `pnpm check:bootstrap` (full on PRs, part of `pnpm check`) repacks every
  workspace entry and fails on a stale version or integrity (`--write` rewrites them).
- `docker/kernel.Dockerfile` packs the entries with `pnpm pack-bootstrap` (refusing a stale pin) into
  `/app/bootstrap`; the kernel image contains no plugin code otherwise. The CLI depends only on the
  kernel; `KernelOptions.builtinExtensions` and the `builtin` source are gone (no aliases).
- `BootstrapService` (`packages/kernel/src/extensions/bootstrap.ts`) checks every file against its
  sha512 before the lock and before writing anything (`bootstrap.missing_file` /
  `bootstrap.integrity_mismatch`, 500, naming the plugin). Each entry goes through the normal import
  (`PluginImport.prepare` with source kind `bootstrap` and ref `bootstrap:<name>@<version>`, then
  `confirm` with `deployExtension`): catalog version, package (kept in PG) and install record with
  source `bootstrap`, permission snapshot source `bootstrap`, audit `extension.permissions_approved`
  with `source: "bootstrap"`. Results per entry: `installed`, `upgraded`, `kept`, `imported`
  (declarative), and `required_cleared` for a required install whose entry left the manifest.
- A package already in the store under another source (the same tgz imported from a marketplace) keeps
  that source, so its install is not a bootstrap install and later manifests never upgrade it.
- Migration of existing deployments: the residue of the built-in extensions (name owners, `builtin`
  replica status rows, deployment config in PG, org rows) needs no conversion. 0050 drops the status
  rows; the first run installs both plugins under the names they already own and the saved config
  applies.

## 8. Claude Code plugin translation

### 8.1 Principles

- The structures map almost one to one: Claude plugin → Capybara plugin, component by component.
- Translation happens **on import** (materialization), producing the normalized manifest and a
  translation report; then the common flow.
- **Allowlist translation**: only what the tables below list is translated; everything else is
  reported as "ignored" with a reason. Claude Code's format keeps gaining fields; unknown fields never
  fail, they are listed.
- Skill files are never modified (no rewriting of tool names or qualified names in bodies). Adaptation
  happens at run time (§9).
- The format reference is Appendix A (checked 2026-10-22). Before implementing, re-check it against
  the docs of the day and test against `claude plugin validate`.

### 8.2 Plugin-level fields

| Claude (`plugin.json`, optional) | Capybara plugin manifest |
|---|---|
| `name` (required) | `name`; rejected with the reason when it doesn't match `^[a-z0-9][a-z0-9-]{0,63}$` |
| `version` | used when valid semver, otherwise §5.3 |
| `description` / `displayName` | `description` / `displayName.en` (zh empty) |
| `author.name` | `publisher`; falls back to the marketplace's `owner.name` |
| `license` / `homepage` / `repository` | same fields (`repository` display only) |
| `dependencies` | `dependencies`; dependencies must be imported separately, the review page says so |
| no `plugin.json` | default layout; name from the marketplace entry or repo name |
| component fields on the marketplace entry, `strict` | Claude's merge rule: with `strict: true` entry fields are appended to `plugin.json`; with `strict: false` and components declared on both sides it is a conflict, rejected |

### 8.3 Components

| Claude component | Handling | Report |
|---|---|---|
| `skills/*/SKILL.md`, paths in `plugin.json` `skills`, a single root `SKILL.md` | **imported as skills**, validated as M5 (name rules, XML tags, size) | N imported |
| skills with `disable-model-invocation: true`, `commands/` | **not imported**: they need manual invocation, which Capybara lacks (phase D) | "needs manual invocation, not supported yet" |
| skill frontmatter `context: fork` (run as a sub-agent) | not imported in phases A–B; phase C handles it as a sub-agent. Importing it as a plain skill would change its meaning | "needs sub-agents, not supported yet" |
| skill frontmatter `allowed-tools`, `disallowed-tools`, `model`, `effort` | imported, keys ignored: tool access is the agent's and policy's, the model is the agent's | warning "ignored restrictions: …" |
| skill frontmatter `user-invocable: false` | imported normally | — |
| `.mcp.json` / `mcpServers` with type `http` / `streamable-http` | **translated to connector templates** (`connector-mcp`): `url` into the endpoint preset; `${VAR}` in `headers` become auth fields filled at org install (`Authorization: Bearer ${X}` → bearer); `oauth` → MCP OAuth; a `${VAR}` in `url` makes `url` editable (`editableEndpoint`) with a hint | translated / needs input at install |
| `sse` (deprecated), `ws`, `stdio`, `.mcpb` / `.dxt` | ignored (`connector-mcp` speaks Streamable HTTP only) | "unsupported transport" |
| `agents/*.md` | ignored in phases A–B; translated to agent templates in phase C (§11) | "sub-agents not supported yet" |
| `hooks/hooks.json` / `hooks` | **never run**. The report lists each event and handler type. With `SessionStart`: "this plugin may rely on injecting content at conversation start; pin the matching skill below" | "ignored: hooks" + hint |
| `lspServers`, `outputStyles`, `themes`, `monitors`, `workflows`, `bin/`, `settings.json`, `userConfig`, `channels`, … | ignored | "not applicable to Capybara" |
| `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}`, `${user_config.*}` in skill bodies | not rewritten | warning "the skill references Claude Code variables; its scripts may not run" |

A Claude plugin carries no code Capybara could load, so the translation **has no extension** and needs
no permission approval.

### 8.4 Translation report on the review page

- Five groups: imported, converted, needs input, ignored, warnings; each item with a reason.
- **Pinned suggestion**: the plugin's skills, each with a "suggest pinned" checkbox; expanded by
  default when the plugin has a SessionStart hook.
- License and source: repo URL, commit sha, license name; the LICENSE text is stored with the version
  and can be expanded.
- No automatic prompt-injection scanning in this project; that belongs to a public marketplace
  (architecture spec §7.4).

## 9. Runtime additions

### 9.1 Pinned skills

The replacement for Claude Code's SessionStart injection, and a native mechanism any plugin can use.

- The **agent definition** gains `skills.pinned: string[]` (skill ids, each already selected by this
  agent through `orgSkills` or an agent-scoped skill). Like `writePolicy`, it has no default, so
  existing definitions don't gain a version. The owner sets it on the agent page.
  - Selecting a skill marked "suggest pinned" ticks "pinned" by default; the owner can untick it.
- **Limits** **(designer's call, tunable)**: at most 3 pinned skills per agent, bodies totalling
  ≤ 32 KB; saving beyond that is refused. The agent page shows a token estimate.
- **Log**: the `skills_catalog` snapshot event gains `pinned: [{ id, version, name, body }]`. The body
  goes into the log, so replay can rebuild the request from the log. This is new model-visible input:
  it needs a matching `DriftReason` and the zero-drift fixtures (`reconstruct.test.ts`,
  `rename-compat.test.ts`) run before and after (AGENTS.md "Evals and replay").
- **Rendering**:
  - in the system cache segment, after the skills catalog, an English note followed by each pinned
    skill's body;
  - when the pinned set or a pinned body changes after the conversation has sent requests (added,
    removed, new version), a system message is appended at the current position, as the catalog
    change reminder does today; the sent prefix never changes **(designer's call)**:
    - added or new version: the full body, stating "replaces the previous version";
    - removed: the name only;
    - history stays append-only; context grows, bounded by the limits and by compaction, which keeps
      only the current versions;
  - after compaction the current pinned bodies are restored the way `skillsCurrentText` restores the
    catalog.
- Pinned skills can still be loaded with `skill_load` (to copy their files into the sandbox).
- **Shared agents** **(designer's call)**: changing the pinned list is the owner editing the agent
  definition, producing a new agent version; it doesn't go through the R3 / R4 skill-change approval
  (R4 covers the agent changing skill content with `skill_write`). A new version of a pinned skill
  takes effect at each conversation's next run, as catalog changes do today (Ruling M17).

### 9.2 Skill provenance and name conflicts

T26 today: when an org installs an app and an org skill with the same name exists, the install adds a
new version to it (`createVersionFromFiles`). For plugins from outside sources that lets one plugin
silently overwrite an org's own skill or another plugin's skill, and a pinned skill's body goes into
every conversation. So:

- Provenance is the existing `skills.directory_item_id` (null = the org's own skill, uploaded or
  written by an agent; otherwise the catalog item of the plugin), kept per version in
  `skill_versions.directory_item_id`.
- Installing a plugin that brings a skill whose name exists:
  - same catalog item (reinstall, upgrade): add a version;
  - different provenance: **the install fails** **(decided, 2026-10-24)** with `plugin.skill_conflict`, and
    nothing changes. The message names each conflicting skill and its current source (the org's own
    skill, or the plugin it came from, with that plugin's name and version), e.g. `Skill "brainstorming"
    already exists in this org (source: plugin "acme-process" 1.2.0). Remove or rename it, then install
    again.` The same check runs in the upgrade preview (§10). Built in A1 (Decision 8): the check
    runs while planning, before anything is written, and conflicts inside one install tree (two
    plugins bringing the same skill) are refused too, naming the dependency.
- Skill names must be unique for `/skills/<name>/` and load-by-name, so storage is not namespaced per
  plugin. The org resolves the conflict first (delete or rename the existing skill), then installs.
- This tightens T26. Existing data already carries provenance (migration `0037`), so no backfill is
  needed beyond app-bundle installs, whose skills record the app's item (designer's call: provenance
  and the message details).

### 9.3 Qualified names

- Each `skills_catalog` item gains the source plugin's name in a new field `plugin` (when provenance is
  a catalog item; e.g. `superpowers`). The existing `source` field (object prefix) is unchanged.
- `skill_load` accepts `<plugin>:<name>`: when the prefix equals the skill's source plugin name, it
  resolves as `<name>`; otherwise "not in the catalog" as today, listing available names.
- The catalog shown to the model keeps unprefixed names. References like
  `superpowers:test-driven-development` in superpowers' bodies then load directly; Claude Code uses the
  same namespace syntax.

### 9.4 Tool-name map

- Skill versions gain a source format (`capybara` / `claude-code`). When the catalog snapshot contains
  a `claude-code` skill, the snapshot carries an English tool-name map.
- The map text is written into the snapshot event, not built at render time, so a later change to the
  text never affects replay (new model-visible input: `DriftReason` as §9.1).
- Contents (re-check against the builtin tools of the day):
  - `Bash` → `sandbox_bash`; `Read` / `Write` / `Edit` / `Glob` / `Grep` → `sandbox_read` /
    `sandbox_write` / `sandbox_edit` / `sandbox_glob` / `sandbox_grep`;
  - `Skill` → `skill_load`;
  - `TodoWrite` → the `todo` extension's tools (when enabled);
  - `AskUserQuestion` → `ask_user`;
  - `Task` / `Agent` (sub-agents) → the sub-agent tool after phase C; before that "not available, do the
    steps yourself in order";
  - anything else: "not available".
- Separately, offer superpowers upstream a `references/capybara-tools.md`; it already has per-platform
  tool maps. That is outreach, not a precondition.

## 10. Org install, upgrade and uninstall of plugins

**Install and uninstall** reuse T26's app install flow and component ledger (`AppInstaller`,
`app_installs`, `app_install_components`), with the plugin as the subject. A plugin's dependencies
install before it and are recorded as components; the uninstall rules are unchanged:

- only components this install created and that nothing else uses are removed;
- kept components are listed in the report with the reason (`pre_existing`, `used_by_agents`,
  `used_by_other_install`, `used_by_connectors`, `used_by_plugins`).

An extension-only plugin keeps today's meaning of an org install: enabling the extension in that org.

**Dependency installs as built in phase 0b** **(designer's call)**:

- each dependency resolves to the highest imported, non-deleted catalog version satisfying its range
  (prereleases included), checked for the whole tree before any request or row exists: unresolved ->
  `catalog.dependency_unresolved` naming the dependency and range; disabled anywhere in the tree ->
  `catalog.dependency_disabled` naming it; a cycle, or nesting deeper than 10 levels ->
  `catalog.dependency_cycle`. A dependency installed in the org at a version outside the range is
  unresolved until org upgrades exist (phase A);
- a dependency not yet in the org gets its own plugin install row, recorded in the parent's ledger as
  a component of kind `plugin` (`ref` = that install's id, migration 0045); one already in the org is
  recorded as pre-existing. Failure rolls back nested installs with the rest;
- dependencies take no install input: one whose connector templates need a credential or an OAuth
  client is installed on its own first (400 saying so), and a dependency's extension is enabled
  without org config;
- uninstall removes a dependency install with the last install that uses it (ownership passes to
  another install that still does, `used_by_other_install`); deleting a dependency install that a live
  install still uses directly returns 200 with nothing removed and that reason, not an error.

**Catalog policy for dependencies** **(designer's call)**:

- Approval follows the policy of the plugin being installed, as C22 does for apps: one request and one
  approval per install; dependencies are not approved separately.
- Exception: a dependency whose catalog item is `disabled` refuses the install, naming the dependency.
  "Disabled" is the enterprise admin's explicit ban and is not bypassed.

**Version ownership** (decided 2026-10-22):

- **A plugin with an extension follows the deployment version**:
  - the extension is in-process code and the whole deployment runs one version at a time (D15). When
    the enterprise admin upgrades it on the deployment (re-approving permissions when needed), the
    extension changes for every org at once;
  - each org's declarative components (skills, connectors, dependencies) stay at the old version; the
    UI says "the deployment is on vX; upgrade this org's plugin" and the org admin runs the in-place
    upgrade below;
  - an org can upgrade only to the deployment's current version and cannot roll back on its own;
  - the install record keeps the org's version and the deployment's; when they differ it shows
    "upgrade pending";
  - extension authors must tolerate declarative components lagging one version behind, just as D15
    rolling upgrades run old and new replicas side by side; this goes into the extension authoring
    guide.
- **A purely declarative plugin** (skills, connector templates, …): each org picks any imported
  version and may roll back.

**In-place upgrade** (decided 2026-10-22; replaces M6's "app upgrades are not supported"):

- **Entry**: an org's installed plugin shows "upgrade available" when the catalog has a newer imported
  version.
  - Upgrades follow the item's policy like installs: `needs_approval` goes through a request,
    `disabled` cannot upgrade.
  - A declarative plugin may also "upgrade" to an older imported version, as a rollback; an
    extension-bearing plugin's target can only be the deployment's current version.
- **Two steps**:
  1. preview: the kernel diffs the current and target manifests and returns component changes and the
     inputs needed;
  2. confirm: the org admin confirms with `diffHash`; a mismatch returns 409.
- **Per component**:

| Component | Added | Changed | Removed |
|---|---|---|---|
| extension | enable in this org (it must be installed on the deployment, otherwise `catalog.not_deployed`) | the deployment already runs the target version; nothing to do for the org | per the uninstall rules: disable only if this install enabled it and nothing else uses it |
| dependency plugin | installed by the install flow | the new range must resolve in the catalog, otherwise fail | per the uninstall rules |
| skill (by name) | created, provenance this plugin | new version; agents' selection and pinning are by id and unchanged; conversations pick it up at their next run | kept if an agent selects it, marked "no longer in the plugin" |
| connector template (by id) | new connector; credentials needed (listed in the preview) | template-owned fields (endpoint preset, auth preset, default policies) updated on the existing connector, credentials kept; re-entry only when the auth method or required credentials change; tool definitions go through snapshots and drift review as usual (architecture spec §7.3) | kept if an agent uses it |

- **Default policies**: tool policies the org changed stay; only those still at the template default
  are updated. As built, a tool still at the kernel's default (`policy_source = 'derived'`) counts as
  "at the default" too, so a rollback restores it **(designer's call)**.
- **Failure rollback**: when any step fails, the org's declarative components return to the old
  version, functionally as before the upgrade (the extension belongs to the deployment and is out of
  scope):
  - components created by this upgrade are undone;
  - skills that got a new version point back to the old version (`revertVersionIn`);
  - modified connectors get their old fields back.

  The install's status and version stay; the error records only the step and error code.
- **Concurrency**: one upgrade or uninstall per install at a time (status `upgrading`, under the org
  lock as installs are today).
- **Audit**: `plugin.org_upgraded` with `from`, `to` and the component diff (naming: §13).
- **As built in A1** (Decisions 9–11 and the rulings in "Phase A1 as built"): routes
  `POST /api/v1/orgs/:orgId/plugin-installs/:installId/upgrade/preview { version }` and
  `…/upgrade { version, diffHash, connectors?, extensionConfig? }` (409 `plugin.upgrade_stale`,
  `plugin.upgrade_target_invalid`; 502 `plugin.upgrade_failed`, the install staying `installed` at
  the old version with the error and the step); a dropped component an agent still uses stays in the
  ledger marked `dropped`; the web shows "upgrade available" and an upgrade dialog.

## 11. Sub-agents (phase C, separate design doc)

superpowers' `subagent-driven-development`, `dispatching-parallel-agents` and
`requesting-code-review` need sub-agents, and Claude plugins' `agents/` needs a landing spot. This
spec only sets direction and constraints:

- **Shape**: a builtin tool (name to be decided). The parent agent starts a child run with an agent
  template (from a plugin's `agents`, or the agent's own definition) and a task; the child's final
  result returns as the tool result.
- **Multi-replica**: the child run is its own queue job; the parent never waits in process. The parent
  call suspends and resumes like `InputRequired`: the child's completion resumes the parent run.
- **Log**: the child has its own event log (a child conversation); the parent log records the dispatch
  and the result. The trajectory viewer links parent to child.
- **Permissions only narrow**: the child's tools are a subset of the parent's and its policies are no
  looser; approvals still go to the person who started the conversation.
- **Limits**: dispatch depth 1; per parent run a concurrency cap and a token cap, counted against the
  parent conversation's usage.
- **Sandbox**: by default shared with the parent conversation, since superpowers' workflows hand work
  over in one workspace. Isolation is for that design to decide.
- **Hooks**: child runs are chat runs, so `ctx.hooks` fire for them as for the parent; that design
  says whether the payload's scope names the parent.
- **Translation**: Claude `agents/*.md` (`name`, `description`, `model`, `tools`, `skills`,
  `maxTurns`, …) become agent templates; `model` maps to a purpose (extension-model spec §4.2), never a
  hard-coded model id.
- The plugin manifest accepts non-empty `agents` only then.
- The UI refresh's sub-agent view (its §5.6) is the display side of this; it can ship against fake
  data first but needs this runtime to be real.

## 12. Phases

| Phase | Content | Depends on |
|---|---|---|
| **0 Terms and format** (before the first release) | The renames of §13, with no compatibility aliases; plugin manifest v1 (`plugin.json`) and `marketplace.json` replacing the M6 / M7 formats (§4.2); the catalog keeps one kind; org install switches from "app" to "plugin"; terms updated in the architecture spec, the extension-model spec, AGENTS.md, the skills and `docs/deploy/*` | M7 |
| **A Repos and marketplaces** | Git marketplaces; single-plugin repos; importing from git; provenance display (§5.5); `@capybara-hq/plugin-tools` published; fake extensions in core (§6.3); the first release, 0.1.0 for every package (§6.4); the `capybara-hq/plugins` repo as a `.github` consumer, official plugins moved out of core, its release (§6.4); `bootstrap.json` and the bootstrap step; the official marketplace `capybara-hq/plugins` on by default (§5.5); skill provenance and name conflicts; org in-place upgrade | 0 |
| **B Claude compatibility** | The Claude reader (`marketplace.json`, `plugin.json`, skills, remote servers in `.mcp.json`); the translation report and review page; pinned skills; qualified names; the tool-name map | A |
| **C Sub-agents** | A design doc first; plugins' `agents`; Claude `agents/` translation | B; the UI refresh's sub-agent view |
| **D (optional)** | Manual skill invocation (a `/` menu in the composer); then importing `commands/` and `disable-model-invocation` skills | B; the UI refresh's composer |

**Ordering around the first release** **(decided, 2026-10-25; replaces the 2026-10-24 ordering, in
which the first manual publish followed phase 0)**:

1. Phase 0 (0a terms, 0b package formats) is implemented and merged into `main`. Nothing is published
   after it.
2. Phase A splits the repos and builds what the first release needs (git marketplaces, bootstrap,
   `@capybara-hq/plugin-tools`, fake extensions in core, the plugins repo's release).
3. Only then does the M7 release gate run its **first manual publish** (checklist
   `docs/superpowers/plans/m7-live-acceptance-checklist.md`; its "install `@capybara-hq/plugin-slack`
   from npm" step then installs from the plugins repo's release). Every package ships as **0.1.0**, in
   core and in the plugins repo. The changesets accumulated before it are cleared before that run as
   M7's F3 did, so versions don't move past 0.1.0 (`docs/deploy/release.md`, "If a changeset merges
   before the first manual run").
4. Phases B–D follow, as normal releases: from 0.1.0 on, released names are compatibility-bound again
   and migrations follow the zero-downtime rules (architecture spec §8.5). The SDK versioning of §6.4
   applies.

**Acceptance**:

- **Phase 0**:
  - no old name remains in the SDK's public API snapshot, the package formats, the HTTP routes, the
    config reference (`docs/config.md`), the CLI help or the error codes (§13);
  - every package, fixture and test in core uses the new formats; a tgz in an old format is rejected
    with a message naming the new format;
  - a development database migrated from M7 `main` migrates forward (the rename migrations run on
    existing data, as `0033_rename_apps_to_connectors.sql` did);
  - replaying an M7-era conversation reproduces its requests exactly (zero-drift fixtures);
  - the release dry run (`dry_run: true`) passes on the renamed `main`.
- **Phase A** (status 2026-10-26: the items marked A1 are built in phase A1, those marked A2 in
  phase A2 and those marked A3a in phase A3a; each names its tests, files under
  `packages/kernel/test/catalog/` for A1 and `packages/kernel/test/extensions/` for A2 unless stated;
  the others wait for phase A3b):
  - (A1) an enterprise admin adds a test marketplace repo; after refresh its plugins are listed:
    `git-marketplaces.test.ts` "refresh reads .capybara-plugin/marketplace.json at the branch head;
    an unchanged commit is skipped" and "a single-plugin repo is a marketplace with one entry (…)";
    `marketplaces.test.ts` (refresh caches entries, ETag 304); `m6-segment3.dual.test.ts` step 1
    (the maintenance job's refresh seen on the other replica);
  - (A1) importing a declarative plugin (skills + a connector template) and an extension-bearing npm
    plugin (refused when the integrity doesn't match): `git-marketplaces.test.ts` "importing path
    entries reads the marketplace commit: …" (git-decl: a skill and a connector template checked
    against the loaded connector) and "an extension plugin from git is packed and reviewed like a
    tgz; …"; `marketplaces.test.ts` "an npm entry: verified against the marketplace's sha512, …"
    and "integrity mismatch: tgz matches the npm metadata but not the marketplace -> 502
    marketplace.integrity_mismatch, nothing created"; `m6-segment3.dual.test.ts` steps 1 (tampered
    integrity) and 2 (todo: extension + template + skill from a marketplace);
    `apps/capybara/test/plugins.test.ts` "imports a plugin folder from a git repo: …" (CLI);
  - (A1) after the repo moves on: "content changed at the same version": `git-marketplaces.test.ts`
    "a repo moving without a version bump shows contentChanged; re-importing records +git.<sha12>"
    and "a monorepo commit touching one plugin's directory flags only that plugin";
    `marketplaces.test.ts` "an archive whose content changed at an imported version shows
    contentChanged; re-importing records +sha256.<12>"; `versions.test.ts` (digest and recorded
    version rules);
  - (A1) org in-place upgrade: skills get a new version, agents' selection and pinning unchanged,
    connector credentials kept, a skill an agent selects but the new version dropped is kept:
    `plugin-upgrade.test.ts` "preview lists added / changed / removed skills, templates and
    dependencies; confirm applies them" (agent version and `orgSkills` unchanged; agents have no
    per-agent pinning yet, that is phase B); `m6-segment3.dual.test.ts` step 7;
  - (A1) a failure injected at the connector step rolls the whole install back to the old version:
    `plugin-upgrade.test.ts` "the connector step fails after skills got new versions and a
    dependency was installed: the org ends exactly as before" and "creating an added connector
    fails (the remote refuses the credential): everything before it is undone";
  - (A1) installing fails when another plugin brought a same-name skill, and the message names the
    skill and its current source: `plugin-install.test.ts` "another plugin's skill: the message
    names that plugin and its version; …" and "the org's own skill: 409 plugin.skill_conflict with
    one line per skill, nothing written"; `plugin-upgrade.test.ts` "a skill the target brings that
    the org already has (its own): the preview is 409 plugin.skill_conflict";
  - (A2) a fresh deployment without network runs init: bootstrap plugins installed, approved, usable
    (A3: shown as "installed" in the official marketplace, which is not live yet); two replicas
    starting together run it once: `bootstrap.test.ts` "a fresh deployment" (installs, pre-approves
    and enables every entry, recorded like a marketplace import; a second run does nothing; an org
    created later has the required plugins enabled without config rows; 409 `extension.required`)
    and "tampered and missing packages (Review Focus 2)"; `bootstrap.dual.test.ts` "runs once and
    both replicas load the plugins"; `apps/capybara/test/bootstrap.test.ts` (since A3b a manifest
    of packed fakes pinned like npm entries: tampered byte, missing directory, installs, re-run, a
    declarative entry through the installed store; the real npm pins are exercised by the web e2e
    setup and the docker smoke tests); `docker/test/kernel-image.sh` (the image's
    `/app/bootstrap`, `capybara bootstrap` twice) and `docker/test/compose-smoke.sh` (init bootstraps
    from the image once across three `up`s; attachments through the bootstrap
    `object-store-s3`);
  - (A2) a deployment from before bootstrap (built-ins with source `builtin`) upgrades to bootstrap
    without losing them: `bootstrap-from-builtin.test.ts` "migrates through 0050 and bootstraps both
    plugins without losing their config" (a database migrated through 0049 with the residue a
    1461e27 kernel leaves: name owners, `builtin` status rows, a deployment config in PG, no install
    records); also checked by hand on a database a 1461e27 kernel ran on (A2 Task 5 report);
  - (A2) with a core that raises a bootstrap version, init upgrades the plugin; one an admin upgraded
    further by hand is untouched: `bootstrap.test.ts` "a core upgrade (Review Focus 3)" > "raises a
    pinned version, keeps a hand-upgraded plugin, clears required from a removed entry" (also: an
    admin-disabled optional plugin stays disabled, an uninstalled one stays uninstalled);
  - (A2) behind an egress proxy with fake-IP DNS, a git marketplace download succeeds, a private
    literal IP is still refused and `noProxy` hosts go direct: `packages/kernel/test/net/proxy.test.ts`
    "git through the egress proxy" and "safeFetch through an egress proxy";
    `packages/kernel/test/config/net-proxy.test.ts`;
  - (A3a, preparation) core tests load no official plugin but `model-fake` and the two listed
    exceptions (`pnpm check:test-plugins`, rules `test-plugins-official` and `plugin-test-imports`,
    `tools/checks/test/test-plugins.test.ts`); every plugin's own tests pass from its directory
    (`pnpm exec vitest run plugins`); `capybara-plugin check` and `pack` work on a directory outside
    this repository (`packages/plugin-tools/test/cli.test.ts`); a tampered or unpublished npm
    bootstrap entry fails the bootstrap pack and `check:bootstrap --network`
    (`packages/plugin-tools/test/bootstrap.test.ts`, `tools/checks/test/bootstrap.test.ts`, with the
    fake npm registry and git server); the official marketplace as a git URL stores `form: git`,
    refuses mirrors and stays off (`packages/kernel/test/catalog/marketplaces.test.ts`);
  - (A3b) core has no official plugins left; they install from `capybara-hq/plugins` through npm; the
    plugins repo's `pnpm verify`, `ci-ok` and `issue-linked` are green on a PR. Built in core PR 3
    (2026-10-28, branch `refactor/plugins-moved-out`): the plugins are deleted from core,
    `bootstrap.json` pins `openai-compatible` and `object-store-s3` `0.1.0-rc.0` from npm at
    `marketplace.commit` `08e336d` of `capybara-hq/plugins` (`pnpm check:bootstrap --network`
    green, with the new rules `bootstrap-marketplace-url`, `bootstrap-haproxy` and
    `bootstrap-compose-ref`, `tools/checks/test/bootstrap.test.ts`), `tools/ci/test-plugins.json`
    lists only `model-fake` and `OFFICIAL_EXCEPTIONS` is empty; the image, the web e2e setup and
    the compose smoke test download the pins. Still open: R3 (the rc images) and the plugins
    repository acceptance PR (plan Task 8);
  - dual-replica acceptance (A1: an upgrade on one replica visible on the other,
    `m6-segment3.dual.test.ts` "7. upgrade across replicas: …"; A2: `bootstrap.dual.test.ts`, and
    `m6-segment2.dual.test.ts` / `m6-segment3.dual.test.ts` run with bootstrap plugins instead of
    built-ins).
- **Phase B** (status 2026-10-26: built, ahead of A3b; every item is covered by
  `packages/kernel/test/catalog/claude-superpowers.e2e.test.ts`, the tests per item are listed in
  "Phase B as built"):
  - adding `obra/superpowers` as a marketplace and importing superpowers; the report lists hooks,
    commands and the other ignored parts;
  - the admin ticks `using-superpowers` as pinned and the org installs it; an agent selects the skills
    and pins `using-superpowers`;
  - asked for a new feature, the model loads `brainstorming` first (`superpowers:brainstorming` also
    loads);
  - replaying that conversation reproduces its requests exactly.
- **Phase C**: superpowers' `subagent-driven-development` runs a small plan in Capybara.
  As built: `packages/kernel/test/subagents/superpowers-sdd.e2e.test.ts` runs a two-task plan with
  the superpowers 7.0.1 skills on fakes (implementer, reviewer, resumed fix, re-review, parallel final
  review, then zero-drift replay); the live run is `docs/superpowers/plans/phase-c-live-acceptance-checklist.md`.
  Deviations and rulings: "Phase C as built" in `2026-10-26-subagents-design.md`.

Each phase gets a detailed plan (writing-plans), reviewed by the maintainer before execution.

## 13. Terminology refactor (phase 0, before the first release)

Principles:

- **No compatibility aliases** **(decided, 2026-10-24)**. Nothing is published, so every externally visible name
  (SDK exports, package formats, HTTP routes, error codes, config keys, CLI) changes directly in phase
  0 and the first release (0.1.0) ships only the new names. This is the C28 precedent (connectors were
  renamed without a compatibility layer while unreleased). The colliding names (`capybara plugins`,
  the `catalog.*` error codes) simply take their new meaning; for HTTP, the catalog routes are the
  plugin routes and no `/admin/plugins` or `/orgs/:orgId/plugins` route is added (phase 0b,
  **(decided, 2026-10-25)**, §3).
- **Internal names** (tables, internal modules, UI text) change in the same phase.
- **The log stays stable**: event payload field names and model-visible text are not renamed, so
  replay never drifts (as C27 / C28). Audit actions written from phase 0 on use the new names
  (`extension.*` for code, `plugin.*` for bundles, e.g. `plugin.org_installed`,
  `plugin.org_upgraded`); rows already in development databases are not rewritten
  **(designer's call)**.
- **Data locations keep their names** **(designer's call)**: extension PG schemas `plugin_<name>`,
  storage prefixes `plugins/<plugin>/<orgId>/`, kv / queue / Redis prefixes, the `/plugin-ui` proxy
  path and embed tokens. They are invisible to users and renaming them is churn without benefit.
- **One release, no dual-write**: there are no deployments to roll from, so tables are renamed by
  migrations in one release, in the order the migration plan fixes (`plugin_installs` →
  `extension_installs` before `app_installs` → `plugin_installs`). Migrations stay idempotent
  (`IF EXISTS` / `IF NOT EXISTS`) because development databases exist.
- **Changesets**: phase 0 PRs add changesets as usual (`check:sdk-api-changeset` requires one when the
  SDK snapshot changes); they are cleared before the first manual publish, after phase A (§12).

| Area | Change |
|---|---|
| SDK | `definePlugin` → `defineExtension`; `PluginManifest` → `ExtensionManifest`; `PluginContext` → `ExtensionContext`; `StaticPluginManifest` → `StaticExtensionManifest`; `CapabilityRef` / `CAPABILITIES` / `CAPABILITY_CARDINALITY` / `parseCapability` → `ExtensionPointRef` / `EXTENSION_POINTS` / … / `parseExtensionPoint`; `PLUGIN_NAME_RE` → `EXTENSION_NAME_RE`; `ctx.capabilities` → `ctx.extensionPoints`; `CatalogIndex` / `parseCatalogIndex` → `MarketplaceManifest` / `parseMarketplaceManifest`; `AppManifest`, `PACKAGE_KINDS` and the `capybara` package sections removed (§4.2); phase 0b adds `PluginManifest` (now the bundle's manifest), `parsePluginManifest`, `ConnectorTemplateFile`, `parseConnectorTemplateFile`, `MarketplaceManifest`, `parseMarketplaceManifest`. Manifest fields `provides` / `requires` / `optional` unchanged. The API snapshot (`plugin-sdk.api.md`) is regenerated; the SDK's first release is 0.1.0 (§6.4) |
| SDK package | `@capybara-hq/plugin-sdk` keeps its name: it is the SDK for making plugins; plugin npm names (`@capybara-hq/plugin-slack`, …) keep theirs, since they now name bundles correctly |
| Package format | `.capybara-plugin/plugin.json` and `marketplace.json`; the `capybara` section of `package.json` is gone (§4.2) |
| Tables | `plugin_installs` / `plugin_packages` / `plugin_blobs` / `plugin_name_owners` / `plugin_replica_status` / `plugin_permission_snapshots` / `plugin_org_configs` / `plugin_deployment_configs` / `plugin_directory_sources` → `extension_*`; `directory_items` / `directory_item_versions` / `directory_requests` / `directory_org_grants` → `catalog_*`; `catalog_sources` / `catalog_entries` → `marketplaces` / `marketplace_entries`; `app_installs` / `app_install_components` / `app_import_staging` → `plugin_installs` / `plugin_install_components` / `plugin_import_staging`; `*.directory_item_id` columns → `catalog_item_id` |
| HTTP | `/api/v1/admin/plugins` (code) → `/api/v1/admin/extensions`; `/api/v1/admin/directory` → `/api/v1/admin/catalog`; `/api/v1/admin/catalogs` → `/api/v1/admin/marketplaces`; `/api/v1/orgs/:orgId/directory` → `/api/v1/orgs/:orgId/catalog`; `/api/v1/orgs/:orgId/app-installs` → `/api/v1/orgs/:orgId/plugin-installs`; plugins are managed through the catalog routes (`/api/v1/admin/catalog/import*`, `/api/v1/admin/catalog/imports/:stagingId…`, `/api/v1/orgs/:orgId/catalog/:itemId/install`, `/api/v1/orgs/:orgId/plugin-installs`; no `kind` parameters; phase 0b); org extension config moves to `/api/v1/orgs/:orgId/extensions`; `/api/v1/orgs/:orgId/plugins/:plugin/directory` (directory sync) → `/api/v1/orgs/:orgId/extensions/:extension/directory`. Web switches in the same PR (it is the only client); `CAPYBARA_WEB_MAX_PACKAGE_BYTES`' route list in `docs/config.md` follows |
| Error codes | `plugin.*` (code) → `extension.*`; `directory.*` → `catalog.*`; `catalog.*` (marketplace) → `marketplace.*`; `app.*` (bundle install) → `plugin.*` |
| Config | `catalogs.*` → `marketplaces.*`; `directory.maxBundleBytes` → `catalog.maxBundleBytes` (then removed in phase 0b: plugins no longer fetch extension packages at import); `plugins` / `pluginConfig` → `extensions` / `extensionConfig`; `pluginHost.*` → `extensionHost.*`; `pluginPermissions.*` → `extensionPermissions.*`; env var names follow; regenerate `docs/config.md`; update `docker/compose.yaml` and `docker/.env.example` where they set these |
| CLI | `capybara plugins …` manages plugins (`list`, `import` in phase 0b); `capybara extensions review / approve / install / state` for extensions; compose's `init` and `compose-smoke.sh` use the new commands |
| UI | the admin console's "Plugins" page lists plugins, with the extension as part of a plugin's detail; "embedded app" → "embed"; Chinese 会话 meaning a conversation → 对话 (e.g. "allow for this conversation"). The UI refresh is not coupled to this (§15): whatever copy exists when phase 0 lands follows the rename |
| Docs | architecture spec, extension-model spec (rewriting "keep the name plugin, not extension"), AGENTS.md, skills, `docs/config.md`, `docs/deploy/*`, `docs/releases/0.1.0.md` |

## 14. Risks and trade-offs

- **A large refactor delays the first release**: the 0.1.0 publish waits for phase 0 **(decided, 2026-10-24)**
  and then for phase A **(decided, 2026-10-25)**.
  In exchange there is no compatibility layer to build or remove. Renames are their own phase, never
  mixed with features.
- **Two repos cost coordination**: contract changes need a PR in each; the SDK API snapshot and its
  changeset check make breaking changes visible. On 0.x additive SDK changes are patches, which
  `^0.1.0` keeps accepting; a breaking change is a minor that every plugin must follow with a release
  (§6.4), the price of staying on 0.x until the plugins repo is stable.
- **Core's tests lose their realistic providers** (§6.3): the fake extensions can drift from what the
  real extensions do. Kernel contract changes must update the fakes in the same PR, and the real
  extensions' own tests in the plugins repo catch the rest when they move to a new SDK.
- **Claude Code's format changes fast**: allowlist translation plus the "ignored" report means a new
  field is ignored at worst, never installed wrong.
- **A branch-following marketplace is trust on first use**: content is locked by commit sha and digest,
  but whether the first content is trustworthy is the admin's judgment at review. That is weaker than
  D16's sha512-pinned manifest; the UI shows the source type.
- **npm sources in Claude marketplaces carry no integrity**: import records the registry's integrity
  and marks "content not pinned by the source"; later fetches of the same version are checked against
  the recorded value **(designer's call)**.
- **Pinned skills use context**: bounded by limits and the token estimate.
- **Translated skills are written for coding agents** (git worktrees, merging branches) and make little
  sense in a sandbox without a repo. The review page shows them as they are; the org decides which
  agents get them.
- **Bootstrap pre-approves permission increases** on core upgrades: acceptable because core's release
  reviewed those versions, and audited; an admin who wants control upgrades by hand, which turns off
  auto-upgrade for that plugin.

## 15. Dependencies on other specs

- **The M7 release gate**: its first manual publish waits until phase 0 has merged **(decided, 2026-10-24)**
  and phase A is done **(decided, 2026-10-25)** (§12). The checklist is `docs/superpowers/plans/m7-live-acceptance-checklist.md` (not changed by
  this spec).
- **UI refresh** (`docs/superpowers/specs/2026-10-22-ui-refresh-design.md`, branch `docs/ui-refresh`):
  **not coupled** to the split or the rename **(decided, 2026-10-24)**. The UI refresh proceeds on its own
  schedule; its copy uses whatever names the code has at the time, and when phase 0 lands the copy
  follows. The shared seams stay:
  - **Terms, once phase 0 lands**: the sidebar entry "Extensions" (扩展) lists pages contributed by
    extensions (`ctx.ui` pages), which is correct under the new terms. Browsing and installing plugins
    for an org is a separate entry, "Plugins" (插件), over the catalog. The admin console has
    "Plugins" (catalog), "Marketplaces" and "Extensions" (deployment runtime status and permissions).
    One word, one meaning.
  - **Plugin UI slots** (inline cards, property sections, right panels) are extension registrations
    through `ctx.ui`; this spec doesn't change them. The plugin review page (§4.3) must show which slots
    an extension asks for, as the permission view does for `permissions.ui` today.
  - **Pinned skills** (§9.1) need a "pinned" control and a token estimate on the agent page, built
    from design components.
  - **Sub-agents**: the UI refresh's sub-agent view (§5.6 there) displays phase C's runtime (§11).
  - **The composer's `/` menu** is phase D's entry point for manual skill invocation.
  - **The default "Artifacts" plugin** is a `required: false` bootstrap entry (§7).
- **Contributor workflow** (`2026-10-23-contributor-workflow-design.md`): the plugins repo is its second
  consumer (§6.2). A breaking change to the shared workflows (`v2`) needs a PR in both repos.
- **Architecture and extension-model specs**: phase 0 rewrites their terms; the extension-model spec's
  "the name stays plugin, not extension" is reversed.

## 16. Left to the builder

- Git access implementation (client library vs archive API); exact size, file count and time limits.
- Where the fake extensions live in core and which fakes exist (one per extension point at least).
- Whether the bootstrap step is `capybara bootstrap` or part of `capybara migrate` (A2: its own
  command); how dev mode points at a local plugins clone (A2: dev runs keep config-declared
  extensions; `--bootstrap-dir` points `capybara start` at packed plugins; a plugins clone is A3).
- Table and column names beyond §13 (e.g. the component kind for dependency plugins in the ledger).
- The internal shape of the normalized manifest and the translation report.
- The rendering text of pinned skills and the tool-name map (English, model-visible, logged).
- Re-checking Appendix A against the Claude Code docs of the day, and the builtin tool names.
- Splitting each phase into plans and tasks.
- **Optional, not required** (later ideas, dropped as requirements on 2026-10-24): conformance suites
  per extension point exported from `@capybara-hq/testing` for the plugins repo to run against the
  real extensions, and a nightly run of the plugins repo's tests against core `main`. Worth doing if
  fake-vs-real drift turns out to bite.

## Open questions for the maintainer

None open. The six questions of the post-M7 update were answered on 2026-10-24 and are recorded as
**(decided, 2026-10-24)** where they apply:

1. Rename before the first public release, no compatibility aliases (header, §4.2, §12, §13, §15).
2. Core ships its own fake extensions (§6.3).
3. The renamed SDK ships as 0.1.0; 1.0.0 at the repo split (§6.4). **Replaced 2026-10-25**: the
   first release is after the split, 0.1.0 for every package, and the SDK stays 0.x until the plugins
   repo is stable (additive changes as patches, breaking changes as minors).
4. No new signing scheme in phase A (§5.5).
5. The official marketplace repo is `capybara-hq/plugins`, on by default once live (§0, §5.5).
6. A plugin bringing a skill whose name already exists in the org fails the install, naming the skill
   and its current source (§9.2).

## Appendix A: Claude Code format notes (checked 2026-10-22, re-checked 2026-10-26)

Source: the code.claude.com docs pages plugins manifest reference, marketplace reference, loading,
components, hooks and MCP. **Re-checked 2026-10-26** for phase B against the Claude Code CHANGELOG
(2.1.310), real marketplaces and the docs pages of the day: the notes below are the 2026-10-22 text
with the corrections marked "(2026-10-26)"; the full list of differences and what the reader does
with each is in "Phase B as built", "Appendix A re-check".

- **`plugin.json`**:
  - optional; only `name` is required (kebab-case);
  - component paths start with `./` and stay inside the plugin root; `skills` adds to the default
    `skills/`, `commands` / `agents` replace their default directories, `hooks` / `mcpServers` merge;
  - default layout: `skills/<name>/SKILL.md`, `commands/`, `agents/`, `hooks/hooks.json`, `.mcp.json`,
    `.lsp.json`, `output-styles/`, `bin/`, `settings.json`; a single root `SKILL.md` is one skill;
  - has `dependencies` for depending on other plugins.
    (2026-10-26) entries are `"name"`, `"name@marketplace"` or `{ name, marketplace?, version? }`
    (the part after `@` names a marketplace, not a range);
  - (2026-10-26) newer keys: `experimental` (`themes`, `monitors`, `evals`), `settings`,
    `defaultEnabled`, `metadata`, directory-listing URLs, `types` (mods), `workflows`, `userConfig`;
    `commands` may be an object map, `hooks` / `mcpServers` arrays of paths and inline objects;
- **`marketplace.json`**:
  - required `name`, `owner.name`, `plugins`; entries require `name`, `source`;
  - `source` forms: relative path, `github` (`repo` / `ref` / `sha`), `url` (git, `ref` / `sha`),
    `git-subdir` (`url` / `path` / `ref` / `sha`), `npm` (`package` / `version` / `registry`), `archive`
    (`url` / `sha256`), `command`; with both `sha` and `ref`, `sha` wins;
  - (2026-10-26) object sources carry a `source` discriminator (`{ "source": "github", "repo" }`);
    `archive` sources are zip files; `metadata.pluginRoot` prefixes bare-name sources only;
  - `strict` defaults to true: entry component fields are appended to `plugin.json`;
  - version order: the manifest's `version` → the entry's `version` → derived from the source (git:
    first 12 of the commit sha; archive: sha256).
- **Namespaces**: skills `<plugin>:<name>`, commands `<plugin>:<file>`, agents `<plugin>:<name>`.
- **Commands** are the older format, superseded by skills, with the same frontmatter. Skill frontmatter
  has `disable-model-invocation`, `user-invocable`, `allowed-tools`, `model`, `context`, ….
- **Agents** frontmatter: `name`, `description`, `model`, `tools`, `disallowedTools`, `skills`,
  `maxTurns`, `isolation`, ….
- **Hooks**: `{"hooks": {"<event>": [{"matcher", "hooks": [{"type": "command" | "http" | "mcp_tool" |
  "prompt" | "agent", …}]}]}}`, with thirty-some events including SessionStart, PreToolUse,
  PostToolUse, Stop.
- **`.mcp.json`**: transports `stdio`, `http` (`streamable-http`), `sse` (deprecated), `ws`; `url` /
  `headers` may contain `${VAR}` and `${VAR:-default}`.
  (2026-10-26) Two shapes: `{ "mcpServers": { … } }` and a flat map of servers; `mcpServers` also
  takes `.mcpb` / `.dxt` bundles.
- (2026-10-26) **`strict: false`**: the docs make any entry component a conflict when `plugin.json`
  exists; Capybara refuses only when both sides declare components (Phase B as built, re-check 7).
