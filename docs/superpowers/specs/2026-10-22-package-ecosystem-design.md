# Plugins, extensions and marketplaces (terminology refactor, repo as marketplace, Claude Code plugin compatibility)

- Date: 2026-10-22 (first draft); updated 2026-10-24 against `main` after M7 (`5bb285b`).
- Status: draft for maintainer review (PR #21). Decisions the maintainer made are marked
  **(decided)** (2026-10-22) or **(decided, 2026-10-24)** (answers to the open questions of the
  post-M7 update); decisions the designer made are marked **(designer's call)** and may be overturned
  in review.
- Timing: starts after M7 (working name M8). It does not change the M6 / M7 plans. The terminology
  refactor (phase 0) lands **before the first public release**, so 0.1.0 ships with the new names and
  no compatibility aliases, and the release gate's first manual publish waits for it **(decided, 2026-10-24)**
  (§12). Phases A–D follow the release.
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
  repos every SDK minor would force a republish of every plugin, so the renamed SDK ships as 0.1.0
  and goes to 1.0.0 at the repo split **(decided, 2026-10-24)** (§6.4).
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

The extension paths are the ones `tools/pack-plugin` already produces (`PLUGIN_PACKAGE_ENTRY =
"dist/index.mjs"`, `migrations/`, `ui/`), so today's extension tgz is already laid out as a plugin
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
  "connectorTemplates": [],                             // optional; omitted = scan connectors/*.json; each as C30
  "agents": [],                                         // reserved; rejected when non-empty until §11 lands
  "extension": {                                        // optional; written by the packer, never by hand
    "entry": "./dist/index.mjs",
    "manifest": {},                                     // StaticPluginManifest (renamed StaticExtensionManifest)
    "migrations": "./migrations",
    "ui": "./ui"
  }
}
```

(The comments are explanation; real files are strict JSON.)

- **The manifest is optional.** Without `plugin.json` the default layout is read; the name comes from
  the marketplace entry (the repo name for a single-plugin repo) and the version follows §5.3. Same as
  Claude Code. A skills-only plugin can contain nothing else.
- **Paths** are relative to the plugin root, start with `./` and never leave the root
  (`isSafePackagePath`).
- **Names** **(designer's call)**: a plugin name follows the catalog item rule
  (`DIRECTORY_ITEM_NAME_RE`). A plugin with an extension must have the same name as its extension, so
  its name must also match `PLUGIN_NAME_RE` (renamed `EXTENSION_NAME_RE`). The extension's identity
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
`capybara` section, `PACKAGE_KINDS`, `app.yaml` (and the SDK's `yaml` dependency) and
`parseCatalogIndex`, and regenerates the JSON Schemas. A tgz in an old format is rejected with a
message naming the new format **(designer's call: follows from no aliases)**.

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
- It replaces D16's `index.json` (never published, §4.2), so it starts at `schemaVersion: 1`. One
  entry is one version; a marketplace that wants several versions lists the plugin once per version
  **(designer's call)**.
- JSON Schema `packages/plugin-sdk/schemas/marketplace.v1.schema.json`, generated and drift-checked
  as `catalog-index.v1.schema.json` is today (which it replaces). Unknown fields are ignored (forward
  compatible), as in `index.json`.

### 5.3 Versions and "a new version is available"

- **Entry version**, in Claude Code's order for both formats **(designer's call)**: the plugin manifest
  (`plugin.json` / `package.json`) → the entry's `version` → `0.0.0-git.<sha12>` (archives:
  `0.0.0-sha256.<12>`).
- **Ordering**: semver, ignoring build metadata; two versions that differ only in build metadata
  (`1.0.0` vs `1.0.0+git.abc`) are ordered by import time. Range matching ignores build metadata too.
- **Content digest**: on import, sha256 over the normalized file tree (sorted by path, hashing path
  and content), stored with the source commit sha or integrity on the catalog version.
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
  imports show "provenance not checked";
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
    `check:deps`, `check:plugin-permissions` including `perm-hooks` / `perm-ui` / `perm-storage`,
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

**SDK versions** **(decided, 2026-10-24)**. Plugins declare `sdk: "^0.1.0"`; on 0.x a caret accepts only the
same minor, and `resolvePlugins` refuses a plugin whose range `SDK_VERSION` does not satisfy, so with
two repos every SDK minor would force a release of every plugin. Therefore:

- the renamed SDK (phase 0) **is** the first release, 0.1.0;
- the SDK goes to **1.0.0 when phase A splits the repos**, and the plugins repo's plugins declare
  `sdk: "^1.0.0"`;
- from 1.0.0 on, a breaking SDK change is a major with a deprecation window; additive changes are
  minors, which `^1` accepts.

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
install record with source `bootstrap` on the first bootstrap run, so 0.1.0 deployments upgrade
without losing `openai-compatible` / `object-store-s3`.

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
    again.` The same check runs in the upgrade preview (§10).
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

- **Default policies**: tool policies the org changed (`policy_source` not `template`) stay; only
  those still at the template default are updated.
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
| **A Repos and marketplaces** | Git marketplaces; single-plugin repos; importing from git; provenance display (§5.5); `@capybara-hq/plugin-tools` published; fake extensions in core (§6.3); SDK 1.0.0 (§6.4); the `capybara-hq/plugins` repo as a `.github` consumer, official plugins moved out of core, its release (§6.4); `bootstrap.json` and the bootstrap step; the official marketplace `capybara-hq/plugins` on by default (§5.5); skill provenance and name conflicts; org in-place upgrade | 0 |
| **B Claude compatibility** | The Claude reader (`marketplace.json`, `plugin.json`, skills, remote servers in `.mcp.json`); the translation report and review page; pinned skills; qualified names; the tool-name map | A |
| **C Sub-agents** | A design doc first; plugins' `agents`; Claude `agents/` translation | B; the UI refresh's sub-agent view |
| **D (optional)** | Manual skill invocation (a `/` menu in the composer); then importing `commands/` and `disable-model-invocation` skills | B; the UI refresh's composer |

**Ordering around the first release** **(decided, 2026-10-24)**:

1. Phase 0 is implemented and merged into `main`.
2. Only then does the M7 release gate run its **first manual publish** (the release gate checklist is
   `docs/superpowers/plans/m7-live-acceptance-checklist.md`; this spec doesn't change it, but its
   "install `@capybara-hq/plugin-slack` from npm" step now runs on the renamed code). Until phase 0
   merges, the 0.1.0 dispatch waits.
3. The first release is 0.1.0 with the new names. Phase 0's changesets are cleared before that run as
   M7's F3 did (or the Version Packages PR is not merged), so versions don't move past 0.1.0
   (`docs/deploy/release.md`, "If a changeset merges before the first manual run").
4. Phases A–D follow, as normal releases: from 0.1.0 on, released names are compatibility-bound again
   and migrations follow the zero-downtime rules (architecture spec §8.5).

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
- **Phase A**:
  - an enterprise admin adds a test marketplace repo; after refresh its plugins are listed;
  - importing a declarative plugin (skills + a connector template) and an extension-bearing npm plugin
    (refused when the integrity doesn't match);
  - after the repo moves on: "content changed at the same version";
  - org in-place upgrade: skills get a new version, agents' selection and pinning unchanged, connector
    credentials kept, a skill an agent selects but the new version dropped is kept;
  - a failure injected at the connector step rolls the whole install back to the old version;
  - installing fails when another plugin brought a same-name skill, and the message names the skill
    and its current source;
  - a fresh deployment without network runs init: bootstrap plugins installed, approved, usable, and
    shown as "installed" in the official marketplace; two replicas starting together run it once;
  - a 0.1.0 deployment (built-ins with source `builtin`) upgrades to bootstrap without losing them;
  - with a core that raises a bootstrap version, init upgrades the plugin; one an admin upgraded
    further by hand is untouched;
  - core has no official plugins left; they install from `capybara-hq/plugins` through npm; the
    plugins repo's `pnpm verify`, `ci-ok` and `issue-linked` are green on a PR;
  - dual-replica acceptance.
- **Phase B**:
  - adding `obra/superpowers` as a marketplace and importing superpowers; the report lists hooks,
    commands and the other ignored parts;
  - the admin ticks `using-superpowers` as pinned and the org installs it; an agent selects the skills
    and pins `using-superpowers`;
  - asked for a new feature, the model loads `brainstorming` first (`superpowers:brainstorming` also
    loads);
  - replaying that conversation reproduces its requests exactly.
- **Phase C**: superpowers' `subagent-driven-development` runs a small plan in Capybara.

Each phase gets a detailed plan (writing-plans), reviewed by the maintainer before execution.

## 13. Terminology refactor (phase 0, before the first release)

Principles:

- **No compatibility aliases** **(decided, 2026-10-24)**. Nothing is published, so every externally visible name
  (SDK exports, package formats, HTTP routes, error codes, config keys, CLI) changes directly in phase
  0 and the first release (0.1.0) ships only the new names. This is the C28 precedent (connectors were
  renamed without a compatibility layer while unreleased). The colliding names (`/admin/plugins`,
  `/orgs/:orgId/plugins`, `capybara plugins`, the `catalog.*` error codes) simply take their new
  meaning.
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
  SDK snapshot changes); they are cleared before the first manual publish (§12).

| Area | Change |
|---|---|
| SDK | `definePlugin` → `defineExtension`; `PluginManifest` → `ExtensionManifest`; `PluginContext` → `ExtensionContext`; `StaticPluginManifest` → `StaticExtensionManifest`; `CapabilityRef` / `CAPABILITIES` / `CAPABILITY_CARDINALITY` / `parseCapability` → `ExtensionPointRef` / `EXTENSION_POINTS` / … / `parseExtensionPoint`; `PLUGIN_NAME_RE` → `EXTENSION_NAME_RE`; `ctx.capabilities` → `ctx.extensionPoints`; `CatalogIndex` / `parseCatalogIndex` → `MarketplaceManifest` / `parseMarketplaceManifest`; `AppManifest`, `PACKAGE_KINDS` and the `capybara` package sections removed (§4.2). Manifest fields `provides` / `requires` / `optional` unchanged. The API snapshot (`plugin-sdk.api.md`) is regenerated; the SDK version stays 0.1.0 |
| SDK package | `@capybara-hq/plugin-sdk` keeps its name: it is the SDK for making plugins; plugin npm names (`@capybara-hq/plugin-slack`, …) keep theirs, since they now name bundles correctly |
| Package format | `.capybara-plugin/plugin.json` and `marketplace.json`; the `capybara` section of `package.json` is gone (§4.2) |
| Tables | `plugin_installs` / `plugin_packages` / `plugin_blobs` / `plugin_name_owners` / `plugin_replica_status` / `plugin_permission_snapshots` / `plugin_org_configs` / `plugin_deployment_configs` / `plugin_directory_sources` → `extension_*`; `directory_items` / `directory_item_versions` / `directory_requests` / `directory_org_grants` → `catalog_*`; `catalog_sources` / `catalog_entries` → `marketplaces` / `marketplace_entries`; `app_installs` / `app_install_components` / `app_import_staging` → `plugin_installs` / `plugin_install_components` / `plugin_import_staging`; `*.directory_item_id` columns → `catalog_item_id` |
| HTTP | `/api/v1/admin/plugins` (code) → `/api/v1/admin/extensions`; `/api/v1/admin/directory` → `/api/v1/admin/catalog`; `/api/v1/admin/catalogs` → `/api/v1/admin/marketplaces`; `/api/v1/orgs/:orgId/directory` → `/api/v1/orgs/:orgId/catalog`; `/api/v1/orgs/:orgId/app-installs` → `/api/v1/orgs/:orgId/plugin-installs`; the new `/api/v1/admin/plugins` and `/api/v1/orgs/:orgId/plugins` manage plugins; org extension config moves to `/api/v1/orgs/:orgId/extensions`; `/api/v1/orgs/:orgId/plugins/:plugin/directory` (directory sync) → `/api/v1/orgs/:orgId/extensions/:extension/directory`. Web switches in the same PR (it is the only client); `CAPYBARA_WEB_MAX_PACKAGE_BYTES`' route list in `docs/config.md` follows |
| Error codes | `plugin.*` (code) → `extension.*`; `directory.*` → `catalog.*`; `catalog.*` (marketplace) → `marketplace.*`; `app.*` (bundle install) → `plugin.*` |
| Config | `catalogs.*` → `marketplaces.*`; `directory.maxBundleBytes` → `catalog.maxBundleBytes`; `plugins` / `pluginConfig` → `extensions` / `extensionConfig`; `pluginHost.*` → `extensionHost.*`; `pluginPermissions.*` → `extensionPermissions.*`; env var names follow; regenerate `docs/config.md`; update `docker/compose.yaml` and `docker/.env.example` where they set these |
| CLI | `capybara plugins …` manages plugins; `capybara extensions review / approve / install / state` for extensions; compose's `init` and `compose-smoke.sh` use the new commands |
| UI | the admin console's "Plugins" page lists plugins, with the extension as part of a plugin's detail; "embedded app" → "embed"; Chinese 会话 meaning a conversation → 对话 (e.g. "allow for this conversation"). The UI refresh is not coupled to this (§15): whatever copy exists when phase 0 lands follows the rename |
| Docs | architecture spec, extension-model spec (rewriting "keep the name plugin, not extension"), AGENTS.md, skills, `docs/config.md`, `docs/deploy/*`, `docs/releases/0.1.0.md` |

## 14. Risks and trade-offs

- **A large refactor delays the first release**: the 0.1.0 publish waits for phase 0 **(decided, 2026-10-24)**.
  In exchange there is no compatibility layer to build or remove. Renames are their own phase, never
  mixed with features.
- **Two repos cost coordination**: contract changes need a PR in each; the SDK API snapshot and SDK
  semver from 1.0.0 make breaking changes visible, and `^1` keeps plugins valid across additive SDK
  releases.
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
  (§12). The checklist is `docs/superpowers/plans/m7-live-acceptance-checklist.md` (not changed by
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
- Whether the bootstrap step is `capybara bootstrap` or part of `capybara migrate`; how dev mode points
  at a local plugins clone.
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
3. The renamed SDK ships as 0.1.0; 1.0.0 at the repo split (§6.4).
4. No new signing scheme in phase A (§5.5).
5. The official marketplace repo is `capybara-hq/plugins`, on by default once live (§0, §5.5).
6. A plugin bringing a skill whose name already exists in the org fails the install, naming the skill
   and its current source (§9.2).

## Appendix A: Claude Code format notes (checked 2026-10-22)

Source: the code.claude.com docs pages plugins manifest reference, marketplace reference, loading,
components, hooks and MCP. Re-check before implementing.

- **`plugin.json`**:
  - optional; only `name` is required (kebab-case);
  - component paths start with `./` and stay inside the plugin root; `skills` adds to the default
    `skills/`, `commands` / `agents` replace their default directories, `hooks` / `mcpServers` merge;
  - default layout: `skills/<name>/SKILL.md`, `commands/`, `agents/`, `hooks/hooks.json`, `.mcp.json`,
    `.lsp.json`, `output-styles/`, `bin/`, `settings.json`; a single root `SKILL.md` is one skill;
  - has `dependencies` for depending on other plugins.
- **`marketplace.json`**:
  - required `name`, `owner.name`, `plugins`; entries require `name`, `source`;
  - `source` forms: relative path, `github` (`repo` / `ref` / `sha`), `url` (git, `ref` / `sha`),
    `git-subdir` (`url` / `path` / `ref` / `sha`), `npm` (`package` / `version` / `registry`), `archive`
    (`url` / `sha256`), `command`; with both `sha` and `ref`, `sha` wins;
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
