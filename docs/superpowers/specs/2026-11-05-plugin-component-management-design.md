# Plugins and components: one model for bringing in, scoping and managing capabilities

- Date: 2026-11-05, written against `main` at `40d81dc1` (v0.1.0-rc.4).
- Status: phases 1, 2, 3 and 4 implemented. Phase 1: plugin scope, the org switch, requests, built-in
  plugins and permission confirmation, the scope sync worker, and the moved admin and workspace plugin
  and extension pages (migrations 0075-0077). Phase 2: components at deployment level with their own
  scope and org switches, agent templates at deployment level, platform plugin and component updates,
  the migration of org copies, the platform inbox, the member-readable 扩展 page and the marketplace
  changes of §13.5 (§6-§8; migrations 0081-0083; decisions in §13.6). Phase 3 implemented (§14: org
  uploads with super admin confirmation, 可共享 and sharing org items, ownership transfer, 新建技能;
  migration 0084; plan `docs/superpowers/plans/2026-11-06-plugin-scope-phase-3.md`; rulings made
  during implementation at the end of §14.2). Phase 4 implemented (§15: creating agents from
  templates with pending connectors and setup requests, org templates from 另存为模板, one agents page
  with cards; migration 0085; plan `docs/superpowers/plans/2026-11-07-plugin-scope-phase-4.md`).
- Markers: **(decided)** is the maintainer's answer during brainstorming (2026-11-05);
  **(designer's call)** is decided here on the maintainer's behalf and may be overturned in review.
  Items without a marker restate current code.
- Amends `2026-10-22-package-ecosystem-design.md` (§0 item 9 per-org plugin versions, §5 catalog
  policy, §7 bootstrap, §10 org install and upgrade) and `2026-10-26-subagents-design.md` §16 (agent
  templates). Where they disagree, this document wins once accepted.
- Written in English (AGENTS.md "Language"); UI copy is quoted in Chinese where the exact wording was
  agreed.

## 1. Why

During the rc.4 acceptance the maintainer tried to add a web search provider and could not form a
mental model of the screens. The same plugin, `openai-compatible`, appears as:

- an installable **插件** with an 安装 button in the org's `/catalog`, although it already runs in
  every org (it is a required bootstrap plugin);
- an **扩展** in `/admin/extensions` and in the org's `/settings/extensions`;
- a row in **企业目录** (`/admin/catalog`), fed by **市场** (`/admin/marketplaces`).

Getting one capability from a marketplace to an agent takes up to five steps on five pages, under four
names: import into the catalog, deploy the extension and approve its permissions (a checkbox at import
that defaults off, or a later step on the extension page), install the plugin in each org, then enable
and configure the extension in each org (`/settings/extensions` and `/catalog` are two ways to do the
same thing). Skills, connectors and agent templates a plugin brings are copied into each org on
install, so the super admin has no single place to see or update them.

The maintainer's own description of the job (decided):

1. pick a source: the official marketplace, or add a Git marketplace source;
2. bring a plugin in from a marketplace, or upload a plugin package;
3. set it up and use it. With a Jina web tools plugin as the example: the super admin can set
   the API key for the deployment, an org admin can set the org's own; some plugins support only
   deployment config, some only org config.

## 2. Goals, non-goals, anti-goals

Goals:

1. **Bringing a plugin in installs it** (decided): import (from a marketplace or an upload) ends with
   the permission confirmation, and confirming is installing. No separate deploy step, no separate
   per-org install step.
2. **Plugins are a delivery and management vehicle; components are managed on their own**
   (decided). Each component kind has its own list, detail, scope and updates; a plugin groups the
   components it brought and updates them together.
3. **One scope model** for who can use a plugin or component (decided, §5).
4. **Ownership** (decided): what an org creates or uploads belongs to that org; only the super
   admin can associate it with other orgs.
5. **The admin console sees everything** (decided): every plugin and component of the deployment,
   whoever owns it. The org workspace shows the same structure limited to what the org can use; org
   admins manage, members view (decided).
6. Required bootstrap plugins stop looking installable (the bug that started this).

Non-goals:

- Renaming code identifiers, tables, npm packages, `plugin.json`, the `capybara-plugin` CLI or the
  extension-point contracts. The terms keep their AGENTS.md meanings; this is about the model behind
  the screens and the screens.
- Changing what an extension can do (`ctx`, extension points, hooks, UI) or the trust model
  (in-process, full trust; approval is governance).
- Cross-deployment sharing, paid plugins, ratings.

Anti-goals (what would make this a failure even if it works):

- A capability that is on for an org without anyone having chosen that (the super admin through
  scope, or the org admin through the switch).
- An independent component update that silently breaks or blocks the next plugin update (today an
  uploaded same-name skill turns into the org's own and the next plugin upgrade fails with
  `plugin.skill_conflict`).
- Two pages that do the same thing under different names.

## 3. Terms (UI)

| Term | Meaning | Unchanged from AGENTS.md? |
|---|---|---|
| 插件 Plugin | The delivery bundle: at most one extension plus skills, connector templates and agent templates; marketplaces list plugins; an upload is a plugin package (`.tgz`) | yes |
| 扩展 Extension | The code inside a plugin, running in the kernel on every replica | yes |
| 技能 Skill | A `SKILL.md` with its files; from a plugin, or uploaded alone as a `.zip` | yes |
| 连接器模板 Connector template | A preset for a remote connector (`connectors/<id>.json`) | yes |
| 连接器 Connector | An org's connector instance with its endpoint and credentials, possibly made from a template | yes |
| Agent 模板 Agent template | A ready-made agent definition users create their own agents from; also usable as a sub-agent type (§8) | changed |
| 市场 Marketplace | A source of plugins (official, or a custom http / Git source) | yes |

"企业目录" / "catalog" disappears from the UI: the platform's installed plugins are simply the
插件 page (designer's call). The code may keep `catalog_*` names.

The four component kinds were checked against the code (`PluginManifest`, `ComponentKind`):
extension, skills, connector templates, agent templates; dependencies are references to other
plugins, not components. Tools, hooks, UI, channels and model providers are registered by an
extension and follow it; they are not components.

## 4. Bringing a plugin in

### 4.1 Super admin

Entry points on the admin 插件 page (decided):

- the 市场 tab: browse the official marketplace and custom marketplaces, 引入 an entry (or 更新 one
  already installed at a lower version); 添加市场源 manages sources;
- 上传插件包: a `.tgz` upload, npm or Git (the current import wizard's sources).

All of them lead to the existing single review (`PluginImport.prepare` → review → confirm with
`reviewHash`). Changes to the review:

1. **Confirm installs** (decided): confirming approves the extension's permissions (the snapshot is
   already written at confirm for `action = install`, `plugin-import.ts:1024`) and installs and
   enables the extension on the deployment. The `deployExtension` checkbox (default off today) is
   removed; `POST admin/catalog/items/:id/install-deployment` and the separate
   `/admin/extensions/install` wizard are retired (an extension-only package is uploaded as a plugin
   on the 插件 page).
2. **The review asks for the scope** (§5), default 组织自选 (designer's call), and shows which
   components it will create.
3. A deployment-config form for the extension may be filled in the review or later (designer's call:
   later, from the extension's detail, so the review stays one screen).

Only built-in (bootstrap) plugins may be installed first and have their permissions confirmed later
(decided). They appear in the 待确认 tab until confirmed; they keep running meanwhile, as today
(bootstrap writes a `bootstrap` snapshot).

### 4.2 Org admin

An org admin can upload a plugin package, or a single skill `.zip`, from the workspace (decided):

- **without an extension**: installed at once, owned by the org, scope "named: this org";
- **with an extension**: stored as pending; the super admin reviews it in 待确认 (the same review
  as §4.1) and confirming installs it, owned by the org, scope "named: this org". Until then the org
  sees 等待超级管理员确认 and nothing of the plugin is usable, not even its skills (designer's
  call: one plugin, one state).

Extension names stay deployment-global (`extension_installs` PK `name`, `extension_name_owners`): an
org upload whose extension name is taken is refused at upload, naming the owner. The confirmation
text says plainly that the code runs in the kernel process for the whole deployment, whatever its
scope.

## 5. Scope

Every plugin and every component has an owner and a scope (decided).

| Scope | UI | Meaning |
|---|---|---|
| `all` | 全部组织启用 | On in every org, existing and future; org admins cannot turn it off, but can set org config |
| `optional` | 组织自选 | Off by default; each org admin turns it on or off |
| `named` | 指定组织 (+ org list) | On by default in the listed orgs (designer's call: an org admin there may turn it off); invisible to other orgs |

Rules:

1. **Owner**: `platform` (brought in or uploaded by the super admin, and bootstrap plugins) or
   an org (created or uploaded in that org). An org-owned item starts as `named: [owner]` and only
   the super admin can add orgs to it or change its scope (decided), and only when the owner
   org marked it 可共享 (§5.1).
2. **Plugin scope and component scope** (decided): a plugin has a scope; each component either
   follows its plugin (default) or has its own. Changing a plugin's scope applies to all its
   components, including those with their own; the confirmation lists the ones whose own setting will
   be replaced (designer's call on the listing).
3. **Built-in** plugins are `all` and their scope cannot be changed; their extension cannot be
   disabled (today's `extension.required`).
4. **Disabled** is not a scope: the super admin can stop a plugin or component on the whole
   deployment (today's extension disable, item policy `disabled`), keeping its scope for later.
5. An org admin's switch acts on what the scope offers: on a plugin it switches all components that
   follow the plugin; on a component, only that component (designer's call).
6. **Replaced concepts**: catalog item policy (`allow` / `needs_approval` / `disabled`) and org
   grants are replaced by scope and disable; `needs_approval` with grants maps to `named` with the
   granted orgs. Requests stay, with a new meaning (§5.1).
7. Extension enablement per org becomes a function of scope plus the org's switch. `enabled.ts`
   stays the one enabled-set query and is rewritten on that basis; `required` folds into `all` +
   built-in.
8. **Losing access while in use** (decided): when a scope change, a deployment-level disable or an
   uninstall takes something away from orgs whose agents use it (a selected skill, a connector made
   from a template, an extension tool, an agent template in a roster, or an orgScoped extension point
   another enabled extension `requires`), the confirmation lists the affected orgs and agents, and
   confirming cuts access. Affected agents show the item as unavailable in the agent editor; at run
   time the item is simply absent (a skill drops out of the catalog, a tool out of the tool list),
   which the replay rules already record (`tools_changed`, `pinned_changed`). Uninstalling a plugin
   at deployment level follows the same preview and removes its components except connectors, which
   stay as the orgs' own (they hold the orgs' credentials) (designer's call on connectors).
9. **Dependencies** (designer's call): a plugin's dependencies are available wherever the plugin is.
   Turning A on in an org turns on the dependencies it needs there, whatever their own scope says;
   the dependency's row shows "A 依赖" as the reason. At import a newly imported dependency takes
   the dependent's scope.
10. **Names** (designer's call): an org's usable set has unique skill names and unique agent
    template type names, as today within an org. The action that would create a collision (a scope
    change, an association, an upload, an org switch) is refused with the conflicting items listed;
    nothing is shadowed or renamed. Model-visible keys keep today's rules (bare name, `<plugin>:<name>`).
11. **What "on" means for content components** (designer's call): an enabled skill, connector
    template or agent template is offered in the org (pickers, `Skill` resolution, the roster), as an
    org-owned one is today; it is not forced onto every agent. Turning one off in an org follows rule
    8 for that org.

### 5.1 Requests (decided, 2026-11-05)

An org cannot ask for what it cannot see, so requests come with visibility. A request always asks
the person who can decide for something the requester cannot use yet, and approving it takes effect
at once (no "approved, now install it again" step).

1. **Visibility to other orgs**: each plugin and component has a "对其他组织显示" flag. An
   platform-owned `named` item defaults to shown: orgs outside its list see it as 未开放，可申请.
   An org-owned item defaults to hidden; only the super admin can turn it on (the owner org
   cannot). The flag never makes anything usable; it only makes it requestable.
   **Shareable** (decided, 2026-11-05): when an org contributes something (creates or uploads it),
   its admin chooses whether it is 可共享 (default off; the owner org can change it later). Unless
   it is shareable, the super admin can neither show it to other orgs nor associate it with
   them; turning shareable off later keeps existing associations and hides it from new requesters
   (designer's call: removing existing users is rule 8's job, done explicitly by the super
   admin).
2. **Org admin → super admin, for an item shown to them**: approving adds the org to the item's
   `named` list; the owner org (for an org-owned item) gets an inbox notice saying which org now uses
   it.
3. **Org admin → super admin, for a marketplace entry not brought in yet**: org admins can
   browse the marketplaces read-only (the workspace 插件 page's 市场 tab) and 申请引入. Approving
   runs the normal import review (§4.1) with scope defaulting to `named` = the requesting org; the
   super admin may widen it. A deployment setting "组织可以浏览市场" (default on) hides the tab
   and these requests.
4. **Member → org admin, for an `optional` item that is off in the org**: approving turns it on in
   the org (today's first request stage).
5. Requests to the super admin appear in the admin 插件 page's 待确认 tab and in the
   super admin's inbox; requests to an org admin in that org's inbox. A rejection carries an
   optional reason the requester sees. One pending request per (org, item or entry, kind).

## 6. Components at deployment level

Today an org install copies the plugin's skills, agent templates and connectors into org rows
(`skills.org_id`, `agent_templates.org_id`, `connectors.org_id`); there is no platform-level row
for a component. That makes goals 2, 3 and 5 impossible: a platform skill exists N times, updating
it means N updates, and there is nothing to attach a scope to.

**Designer's call: platform components live once, at deployment level.**

- Platform-owned skills, connector templates and agent templates get deployment-level rows with
  versions (a skill version keeps today's object-storage layout), plus their plugin provenance.
- An org's usable set = what the org owns ∪ platform or other-org items whose scope makes them
  available to it and that are switched on. Runtime readers (skill catalog and `Skill` resolution,
  the sub-agent roster, the agent editor's pickers) read that union instead of org rows only.
- Connector templates are deployment-level; **connectors stay per org** (they hold endpoints and
  credentials). The admin console lists templates; the org lists its connectors (decided via the
  mock: 连接器模板 in the admin console, 连接器 in the workspace). Decided:
  - when an org admin turns on a plugin that carries connector templates, they fill the endpoint
    and credentials for each, as in today's install wizard, and the connectors are created then;
    with `all` or `named` scope nothing is created until an org admin does this (the plugin shows
    "需要配置" in the org), because credentials are per org;
  - connectors made from a template stay linked to it: when the template is updated (with its
    plugin or on its own), the endpoint, tool and default policy changes are applied to every
    connector made from it, and the update preview lists the affected orgs (today's
    `applyTemplateIn` per org, now driven from the deployment);
  - a template that is removed leaves its connectors as the orgs' own.
- Org-owned items keep living in their org (today's rows), gaining an owner and a scope.
- **Org-owned items shared with other orgs** (decided): there is still one item. The owner org's
  updates reach every org it is associated with at once; the owner org deleting it shows the affected
  orgs and agents first (rule 8 of §5). When the owner org is deleted, items associated with other
  orgs become platform-owned and stay available (today's `ON DELETE CASCADE` and the
  `kernel/<orgId>/` storage prefix must not take them down); items used only by the deleted org go
  with it.
- Model-visible names must not change: skill keys and `<plugin>:<name>` stay as they are, so replays
  of existing conversations keep zero drift (`replay-evals`). Agents keep referencing skills and
  connectors by id; existing org copies of platform components are merged into the deployment-level
  rows by a migration that keeps every id agents reference working (the builder chooses how: kept
  ids, an alias table, or rewritten agent definitions with new versions).

This replaces per-org versions and rollback of declarative plugins (ecosystem spec §0 item 9):
a platform plugin has one installed version for the deployment.

Migration of what exists (designer's calls; the mechanics stay the builder's, §12):

- **Orgs on different versions of one plugin**: the plugin's version becomes the highest installed
  one, and each component of an org that was on another version keeps that version as an
  individually updated component (§7), so nothing is upgraded silently; the next plugin update
  previews them.
- **Imported but never deployed** (an extension not installed, or its permissions never approved):
  the plugin goes to 待确认, not installed; a declarative plugin (no extension) imported and
  installed in some orgs becomes installed with scope `named` = those orgs; one installed in no org
  becomes installed with scope `optional` and every org's switch off.
- Catalog policies: `allow` → `optional`, `needs_approval` → `named` (granted orgs plus orgs that
  installed it), `disabled` → disabled. Orgs that had installed a plugin get its switch on.
- Pending catalog requests are closed with a note (they asked under the old policy); requesters can
  ask again under §5.1.

## 7. Updates

1. **Plugin update** (decided): the preview lists every component as 升级 / 降级 / 不变 / 新增 /
   移除, and marks components that were updated on their own (their version differs from what the
   plugin last installed) and components with their own scope. The admin confirms; a component
   updated on its own is moved to the plugin's version only as part of that confirmation. The current
   `diffHash` preview and the journaled, undoable upgrade (`plugin-upgrade.ts`) are the basis.
2. **Component update** (decided): a skill, connector template or agent template can be updated on
   its own (a new version, e.g. a `.zip` for a skill), and an extension can be upgraded on its own
   (today's extension upgrade). It keeps its plugin provenance; it never becomes "the org's own" and
   never blocks the next plugin update (today's `plugin.skill_conflict` path for same-name uploads
   goes away for components of the same plugin).
3. Removal: a component the new plugin version no longer contains is removed unless agents use it
   (today's `dropped`), and the preview says so.
4. Extension code has one version per deployment, so an update of an extension-bearing plugin
   applies to all orgs at once; the preview says which orgs use it.

## 8. Agent templates

Today an agent template is only a sub-agent type (`<plugin>:<name>` in an agent's roster), created
only by a plugin install, with no create or edit API.

Decided:

- An agent template is a **ready-made agent definition users create their own agents from**: 用它创建
  Agent copies the template into a new agent owned by the user's org; afterwards the agent and the
  template are independent (a template update affects only agents created later).
- It can also describe its sub-agents (their prompts and skills) and the skills and connectors it uses.
- It stays usable as a sub-agent type.

Designer's calls:

- Template fields grow from today's (`instructions`, `tools`, `disallowedTools`, `toolPolicies`,
  `model` tier, `effort`, `maxSteps`, `skills` ≤ 3 preloaded) to what an agent needs: skills it
  uses (not only preloaded), connector templates it uses (by template id; creating the agent asks the
  user to pick or create a connector for each), and sub-agents (other templates of the same plugin,
  or inline).
- Orgs can create and edit their own templates (owner org), from scratch or by saving an agent as a
  template.
- The SDK file format (`agents/<name>.md`) gains the new fields additively; existing templates stay
  valid.
- Sub-agent type names: plugin templates keep `<plugin>:<name>`; a template without a plugin (org- or
  platform-created) is the bare `<name>`, unique in each org's usable set (§5 rule 10), so
  `agent_templates.plugin_name` becomes nullable. Existing type names in logged `subagent_started`
  events never change.

## 9. Pages

The preview at `/dev/mock` in the worktree (not committed) was accepted by the maintainer
(decided); it uses the real design components.

Admin console sidebar (decided via the mock): 概览, 账号, 组织, **插件** (badge: 待确认 count),
**扩展**, **技能**, **连接器模板**, **Agent 模板**, 模型, 部署设置. 企业目录 and 市场 leave the
sidebar.

| Page | Content |
|---|---|
| 插件 | Tabs 已安装 / 市场 / 待确认; actions 添加市场源, 上传插件包. A row: name, chips (内置, Claude Code, owner org), components count, source, scope and how many orgs use it, state (运行中, 可更新 x, 权限待确认) |
| 插件 detail | Components table (kind, version and the pending update per component, scope: 跟随插件 or its own), tabs 组件 / 组织 / 版本, inspector (package, source, publisher, scope, orgs, permissions); actions 设置范围, 更新到 x |
| 扩展 | Every extension: provider kinds, plugin, scope and enabled org count, replicas, state; detail keeps today's overview / permissions / deployment config |
| 技能 / 连接器模板 / Agent 模板 | Every item of the deployment, platform- and org-owned: from (plugin, upload, org), owner, scope, version; tabs 全部 / 平台 / 组织创建; the super admin associates org items with other orgs here |

Workspace sidebar (decided via the mock): 新会话, 首页, Agents; 更多 holds **插件**, **扩展**,
**技能**, **连接器**, **Agent 模板**, 渠道, 评测与运行, 组织设置. Org settings lose 扩展 and
已安装的插件; `/catalog` becomes the org's 插件 page.

| Page | Content |
|---|---|
| 插件 | What the org can use: platform plugins in scope and the org's own; state 已启用 / 未启用 / 等待超级管理员确认; 启用 and 组织配置; 上传插件包 (admins) |
| 扩展 | Extensions in scope with the org switch and org config (today's `/settings/extensions` content); 已启用 · 平台统一 for `all` |
| 技能 | In-scope platform skills and the org's own, with switches; 新建技能, 上传 (.zip) |
| 连接器 | The org's connectors; 从模板新建 lists the templates in scope |
| Agent 模板 | In-scope templates and the org's own; 用它创建 Agent; 新建模板 |

Members see the workspace pages read-only (decided: "组织管理员可管，普通成员可看"); actions are for
org admins, as `can()` says today.

## 10. Current state the builder starts from

A full map is in the brainstorming record; the facts that shape the work:

- Import and deployment are separate (`catalog_items` / `catalog_item_versions` vs
  `extension_installs`); `PluginImport.confirm` deploys only with `deployExtension`.
- Org enablement of an extension: `extension_org_configs.enabled` ∪ `extension_installs.required`
  (`extensions/enabled.ts`); every loaded extension is listed in every org (`org-config.ts:183`).
- Org install (`OrgCatalogService.install` → `PluginInstaller`) records components in
  `plugin_install_components` (kinds extension / connector / skill / plugin / agent_template).
- Skill provenance is `skills.catalog_item_id` / `catalog_version`; a same-name zip upload resets it
  to null (`skills.service.ts:541-562`).
- Agent templates: `agent_templates.plugin_name` is NOT NULL; only `GET orgs/:orgId/agent-templates`
  exists.
- Every import route is `@SuperAdmin`; `plugin_import_staging` has no org.
- `deployment_settings.customSkills` / `customConnectors = deny` blocks org-made skills and
  connectors; it should also block org plugin uploads (designer's call).

## 11. Constraints

- Multi-replica rules (AGENTS.md): scope changes and installs converge through PG desired state and
  the existing per-replica reconcile; no in-process state.
- Migrations are expand-only for released data (`writing-migrations`); the merge of org copies into
  deployment-level components (§6) keeps every id agents and conversations reference.
- Replay: no model-visible name or text changes for existing conversations; new model-visible input
  goes into the log with a `DriftReason` (`replay-evals`).
- Web: pages are design templates and components, reads through the query cache, keys from
  `lib/query/keys.ts`, i18n zh and en (`writing-web-ui`, `check:web-ui`, `check:i18n`).
- `check:terms` stays green: no old names come back.

## 12. Left to the builder

- Table design for deployment-level components and scopes, and the migration of existing catalog
  items, grants, org installs and org copies.
- Whether the work ships in phases. Suggested order (designer's call): (1) import = install, scope
  for plugins and extensions, the new admin 插件 / 扩展 pages and workspace pages, bootstrap plugins
  as built-in; (2) deployment-level skills, connector templates and agent templates with scope and
  independent updates; (3) org uploads with super admin confirmation; (4) agent templates as agent
  starters.
- HTTP routes and their shapes; the review's exact layout; empty and loading states.

## 13. Follow-ups decided during the phase 1 acceptance (2026-11-06)

All **(decided)** by the maintainer on 2026-11-06 unless marked.

### 13.1 Bootstrap plugins

- Required (unchanged): `openai-compatible`, `object-store-s3`, pinned at their latest published versions.
- Optional preinstalls, at their latest published versions: `connector-mcp`, `connector-openapi`,
  `anthropic`, `openai`, `jina`, `sandbox-docker`, `todo`. Without a sandbox provider most builtin
  tools are unusable; without a connector extension no connector can be created.
- A newer pin upgrades a bootstrap-source install on the next start; an install a super admin
  upgraded or installed is never touched or downgraded (today's bootstrap rule, kept).
- Preinstalled optional plugins get the default scope `optional` (designer's call: a scope per
  bootstrap entry is a later manifest change).

### 13.2 Marketplace: one entry per plugin

Replaces the "one npm entry per public plugin version, append-only" rule of the package ecosystem
spec, following Claude Code's marketplace (one marketplace serves one version of each plugin):

- `marketplace.json` lists one entry per plugin: its current published version.
  `capybara-plugin marketplace --write` replaces a plugin's entry when its version moves.
- Each entry keeps its `integrity` (sha512 of the reproducible pack) **(designer's call:** Claude Code
  has no checksum for npm sources; keeping it costs nothing and downloads stay verified).
- `--base` rules: an entry's version may only increase (`marketplace-version-decrease`); the same
  version must keep the same integrity (`marketplace-integrity`); `marketplace-append-only` goes.
- Old versions stay installable by direct npm import, and versions already imported stay in the
  catalog. The bootstrap pins and the compose sandbox contexts stay pinned by `marketplace.commit`;
  since that commit lists one version per plugin, all pins of one manifest are the versions current
  at that commit.
- Readers keep accepting several entries per plugin (custom marketplaces written in the old
  form); the web groups them per plugin (phase 1 follow-up, built).

### 13.3 Marketplace display names and Chinese summaries

- An entry may carry `displayName: { zh, en }`; `capybara-plugin marketplace --write` copies it from
  the plugin's `plugin.json`. The marketplace lists show it, else the name.
- `capybara-plugin check` warns when a public plugin's marketplace `summary` lacks `zh`
  **(designer's call:** a warning, not an error, so third-party marketplaces are not blocked); the
  official plugins get Chinese summaries.

### 13.4 The word "agent" in Chinese UI

The zh UI says 智能体 (sub-agent 子智能体, agent template 智能体模板, the nav item 智能体); English
stays "agent". `check:i18n` gains a rule rejecting the Latin word "agent" in zh messages (names in
`{placeholders}` are not text). Code identifiers, routes and model-visible text do not change.

### 13.4b Role names (decided, 2026-11-06)

The UI names five roles: 超级管理员 / Super admin (the deployment-level flag, formerly 企业管理员 /
enterprise admin), 组织所有者 / Org owner (`owner`), 组织管理员 / Org admin (`admin`), 组织成员 / Org
member (`member`), 访客 / Guest (`guest`). Prose saying 组织管理员 means admin and above, owners
included **(designer's call)**; only owner-only actions (transfer, delete the org) say 组织所有者.
`check:i18n` rejects 企业管理员 in zh messages. Code identifiers and API fields do not change.

### 13.4c No "enterprise" layer in the UI (2026-11-06)

The deployment layer is called 平台 / Platform (designer's call, maintainer may rename): one deployment
is one platform run by the 超级管理员, hosting organizations (subsidiaries, departments). 企业 leaves the
UI: 平台提供的插件, 平台技能, 归属：平台, 已启用 · 平台统一, 向超级管理员申请. 部署 stays for technical
settings (部署设置, 部署级配置). Phase 2 code uses `platform` for the owner value; existing identifiers
(`enterpriseAdmin`, routes) do not change. `check:i18n` rejects 企业 in zh messages. In this spec,
"enterprise" in prose reads as "platform".

Follow-up (2026-11-06, rename tasks R1-R3): the identifiers were renamed after all (no aliases):
`isSuperAdmin`, `superAdmin`, `@SuperAdmin`, column `accounts.is_super_admin` (migration 0080), setting
value `orgCreation: "super_admin"`, error `account.last_super_admin`; routes (`/admin`) keep their
names. A non-official marketplace is a custom marketplace (自定义市场源). The prose of this spec now
says super admin and platform; `check:terms` rejects the old identifiers.

### 13.5 Phase 2 decisions (2026-11-06)

- An org admin can switch off a single component of a plugin that is on in the org (on the 技能 /
  智能体模板 pages), except components whose scope is `all` (§5 rule 5, now decided).
- Migration of org copies: a copy an org changed (a same-name upload turned it into the org's own) stays
  the org's own; on a name clash it is renamed with a suffix and the org admins get an inbox notice;
  agents referencing it keep working; the platform version starts switched off in that org.
- Phase 2 also takes: a super-admin inbox (requests to the platform and pending
  confirmations), a member-readable 扩展 page without config or secrets, prerelease versions folded
  into 其他版本 once a stable version exists, and a `deprecated` marker for marketplace versions (SDK
  format, plugin-tools, the plugins repository).

### 13.6 Phase 2 decisions made during implementation (2026-11-06)

Rulings taken while planning and building phase 2; where they refine or change the sections above,
they win. Cited in code and docs as "ruling <id>".

- **A2** New `platform_*` tables (`platform_skills`, `platform_agent_templates`,
  `platform_connector_templates` and their version tables, migration 0081) instead of a nullable
  `org_id` on the org tables. Platform files live under `deployment/platform/{skills,agent-templates}/
  <id>/<version>/`, never under `kernel/<orgId>/`.
- **B2** (§6 migration rule) An org copy links to its platform component (`platform_skill_id` /
  `platform_template_id`) and keeps its id: without a pin it serves the platform's current version under
  that id (one "Updated skills" notice, no definition rewrite); with `pinned_version` it serves its own
  stored version until an update clears the pin.
- **C2** Component scope lives on the platform rows (`scope_mode` `follow` | `own` plus the phase 1
  scope fields); org lists and switches are generic tables keyed by `(kind, component_id)`.
- **D2** The snapshot `source` of a platform skill is `platform:<object prefix>`, read from
  `deployment/`; model-visible names do not change.
- **E2** Connectors stay per org; a connector made from a platform template stores
  `platform_template_id`, and template updates fan out by it.
- **F2** (§7) The per-org plugin upgrade routes are retired: one version per deployment, moved by the
  super admin's platform update; the org upgrade dialog is gone.
- **P2-2** The migration job `platform-components-migrate` runs at every worker start and daily; it
  also heals a failed post-import component sync.
- **P2-3** (rule 10) An org skill upload or creation named like a platform skill offered to the org is
  refused (409 `plugin.skill_conflict`); the same check covers platform-vs-platform clashes on switch-on
  and scope changes.
- **P2-4** An org upload to the name of a linked copy pins the copy at the new version; the next update
  preview shows it as changed in the org.
- **P2-5** (§13.5) Clashing org skills are renamed `<name>-org` only during the first migration run;
  later clashes are only logged (P2-3 prevents new ones).
- **P2-6** Connector templates honour component state: installs and scope syncs create connectors only
  from templates on in the org; a template switched off later leaves existing connectors as the org's.
- **P2-7** (§7.3) An update that drops a component soft-deletes it unless agents in any org use it; a
  used one stays and is listed as kept.
- **P2-8** An update clears the pins of linked copies only in orgs where the component is on.
- **P2-9** An update creates no connector for an added template; the org needs its input.
- **P2-10** An installed plugin with an on template lacking a connector is `needs_config` in the org,
  and `POST /orgs/:orgId/catalog/:itemId/connectors` creates the missing connectors (补充配置).
- **P2-11** (§9, goal 5) `GET admin/components` also lists org-owned skills and agent templates
  (owner = the org, read-only in the admin console), with the tabs 全部 / 平台 / 组织创建.
- **P2-12** Scope sync failures are kept in `plugin_scope_sync_failures` (migration 0083), one row per
  plugin and org, cleared by the next sync of the pair that does not fail; the platform inbox reads it.
- **P2-13** `GET /orgs/:orgId/extensions` is the action `org.extensions.read` (member and up); members
  get no config, secrets, org config schema or permissions; guests and service tokens are refused.
- **P2-14** `deprecated` is set by hand on a marketplace entry, never in `plugin.json`; `--write` keeps
  it, a new version's entry does not inherit it and `--base` ignores it.
- **P2-15** A deprecated version is refused (409 `marketplace.entry_deprecated`) at import prepare and
  at an org import request; confirm does not re-read the marketplace.
- **P2-16** Prereleases fold into 其他版本 unless no stable version can be imported; a deprecated
  version is never newer, the latest or the default pick.
- **P2-17** (F2) An org install or switch takes no version: it installs the platform version. A
  dependency resolves to its platform version, which must satisfy the range; only while it has none
  yet, to the highest imported, non-deprecated version satisfying it (stable before prerelease).
  Platform updates move installs still installing, and an install records the platform version
  current when it is marked installed.
- **P2-18** A version-pinned linked copy follows its platform component's availability (deployment
  disable, org switch-off, scope removal, uninstall); the pin fixes the version only. A component a
  platform update removed leaves its pinned copies to the org (P2-7). The previews count pinned copies;
  the migration leaves a copy whose component is off in its org unlinked until it is on.

## 14. Phase 3: org uploads, sharing, 新建技能 (2026-11-06)

Phase 3 builds §4.2, §5 rule 1, §5.1 rules 1-2, the org-owned rows of §6 and the workspace and admin
pages of §9 that depend on them. Plan: `docs/superpowers/plans/2026-11-06-plugin-scope-phase-3.md`.
The rulings of §13.5 and §13.6 stay binding. Cited in code and docs as "ruling P3-<n>".

### 14.1 Decided by the maintainer (2026-11-06)

1. **Org uploads.** An org admin uploads a plugin package (`.tgz`) or a single skill `.zip` from the
   workspace. A package without an extension installs at once, owned by the org, scope
   `named: [owner]`. A package with an extension stays pending until the super admin confirms it in
   待确认; until then nothing of the plugin is usable. **Every** new version of an org plugin that
   carries an extension needs confirmation again; a new version without an extension applies at once.
2. **Names.** Extension names and plugin names stay deployment-global. A taken name is refused at
   upload, and the refusal names the owner (平台 or the org's name). `customSkills` /
   `customConnectors` = `deny` also blocks org plugin uploads.
3. **可共享.** The owner org marks an org-owned item shareable; off by default, and the owner can
   change it. Only a shareable item can be shown to other orgs (`shown_to_others`) or associated with
   them by the super admin (added to the `named` list, an access request approved). Turning
   shareable off later keeps the existing associations and blocks new requesters. When an access
   request for an org-owned item is approved, the owner org gets an inbox notice.
4. **Updates of shared items.** Shared items follow the owner's updates automatically, one version for
   the whole deployment, and the orgs using them get an inbox notice.
5. **Owner gone.** When the owner deletes a shared item, or the owner org is deleted, while other
   orgs use it, the item becomes platform-owned and the super admin gets an inbox notice. An item
   no other org uses is removed as usual.
6. **新建技能.** A kernel route creates an org skill from text (name, description, `SKILL.md` body;
   files later). It is org-owned and can be marked shareable. The workspace 技能 page offers 新建
   next to 上传.

### 14.2 Designer's calls

Owner model

- **P3-1** `owner_org_id text NULL` (null = platform) and `shareable boolean NOT NULL DEFAULT false`
  on `catalog_items` and on `platform_skills`, `platform_agent_templates` and
  `platform_connector_templates` (migration 0084). Existing rows are platform-owned. The **share
  gate** of an item is `owner_org_id IS NULL OR shareable`.
- **P3-2** The components of an org plugin are `platform_*` rows (written by `syncFromVersion`, as for
  platform plugins) with the plugin's owner. There is one 可共享 flag, the plugin's; it is copied to
  its component rows in the same transaction, so every gate reads the row it acts on.
- **P3-3 Promote on share** (chosen over writing platform rows at upload). An org's own skill or agent
  template stays an org row (`skills` / `agent_templates`, with a new `shareable` column) until the
  super admin first shows it to other orgs or associates it with one. Promotion, in that action's
  transaction, creates the platform row (`owner_org_id` = `origin_org_id` = the org, `scope_mode own`,
  `named: [owner]`, `shown_to_others false`), copies the current version's files to
  `deployment/platform/{skills,agent-templates}/<id>/<version>/` **keeping its version number**, and
  links the org row to it (`platform_skill_id` / `platform_template_id`, no pin; ruling B2). The
  owner's agents keep referencing the org row's id and resolve to the same version and content (no
  "Updated skills" notice); other orgs' agents reference the platform id. Why: it is the only path
  that also covers skills orgs already have, it leaves the upload and `SkillWrite` paths alone until
  something is shared, and it keeps files of unshared items under `kernel/<orgId>/`, purged with the
  org.
- **P3-4** After promotion the owner's new versions (zip upload to the same name, `SkillWrite`
  change approval) are written to the platform row, never pinned on the copy: ruling P2-4 applies to
  copies of items the org does not own.
- **P3-5** The live-name unique indexes of `platform_skills` and `platform_agent_templates` include
  a new immutable `origin_org_id` (the org an item was created in; null for platform items): two orgs
  may each share a skill named `report`. Rule 10 (one name per org usable set) still refuses the
  association that would put both in one org.
- **P3-6** Shareable exists only on items the org owns: its own org-scope skills (not agent-scope ones,
  not copies linked to a platform skill it does not own), its own agent templates, and the plugins it
  uploaded.

Uploads

- **P3-7** Org sources are a `.tgz` file only: no npm, git, marketplace or Claude Code import from an
  org. The 插件 page's upload also takes a skill `.zip`, sent to the existing skill upload.
- **P3-8** Staging gains `org_id` (`plugin_import_staging`, null = the super admin's). Staging lives
  only between the org's prepare and its confirm, so the 24 h TTL stays; the pending state is written
  at the org's confirm as a committed catalog item and version, so nothing later reads staging.
  Org routes only see their org's staging rows, admin routes only the platform's.
- **P3-9** Pending state: `catalog_items.awaiting_confirmation boolean` (a first version not
  confirmed yet) and `pending_version text NULL` with `pending_by` / `pending_at` (a version waiting
  for the super admin; equals `latest_version` while `awaiting_confirmation`). While awaiting, the
  item has no platform components, is never installed by the scope sync or an org switch, is in no
  org's catalog except the owner's (as 等待超级管理员确认), is no dependency target, not requestable,
  refused by scope edits (409 `catalog.item_pending`) and skipped by the `platform-components-migrate`
  job. A pending new version leaves the item serving its platform version, and the generic platform
  update route refuses that version (409 `catalog.item_pending`: confirm it in 待确认).
- **P3-10** An org confirm with an extension stores the package (content-addressed, nothing runs),
  claims the extension name in `extension_name_owners` under the install lock, and writes no
  permission snapshot and no install. The super admin's existing confirmation (`POST
  admin/catalog/items/:id/confirm` with the permissions digest) is extended: it approves, installs or
  upgrades the extension, writes the platform components (first version) or runs the platform update
  to the pending version, clears the pending state, enqueues the scope sync and notifies the owner
  (`upload_confirmed`). New: `POST admin/catalog/items/:id/reject { reason? }` (a first version: the
  item is soft-deleted and the name claim released; a new version: the pending state is cleared),
  owner notice `upload_rejected`. The owner org may withdraw a pending upload
  (`DELETE orgs/:orgId/owned-plugins/:id/pending`), with no notice.
- **P3-11** A second upload while a version is pending replaces the pending one; the super admin's
  confirmation carries the digest they reviewed, so a confirmation of the replaced one is stale
  (409 `extension.approval_stale`).
- **P3-12** A new version without an extension (including one that drops the previous version's
  extension: removing code runs none) applies at once through the platform updater acting for the
  owner org; the org's review shows the update preview, and one hash covers both. A failure undoes the
  update (as today) and leaves the version imported; uploading it again retries.
- **P3-13** Dependencies of an org upload must each resolve to a confirmed, non-disabled item the
  owner org can use (scope `all` or `optional`, `named` listing the org, or another org's item shared
  with it); otherwise prepare and commit refuse (409 `plugin.dependency_unavailable`, naming them). An
  org upload never imports or confirms anything else, so it cannot bring in code the super admin did
  not confirm.
- **P3-14** Names: prepare and, under the item-name lock, commit refuse a plugin name live for
  another owner: 409 `plugin.name_taken` with `owner: { kind: "platform" } | { kind: "org", orgId,
  name }`; the same `owner` is added to `extension.name_conflict` (package → item → owner). A super
  admin import of a name an org owns is refused too (the super admin acts on it in 待确认). The same
  org uploading its own name is a new version.
- **P3-15** `customSkills` **or** `customConnectors` = `deny` refuses every org plugin upload
  (403 `catalog.custom_disabled`), whatever the package carries.

Sharing

- **P3-16** The share gate guards `requestable()`, `PUT …/shown` (true), `addScopeOrg` (the super
  admin's association and an approved access request), and scope widening to `optional` / `all`
  (409 `catalog.not_shareable`). Narrowing, removing orgs and disabling are always allowed. Org-owned
  items start with `shown_to_others = false`; turning shareable off keeps the stored flag but makes it
  ineffective until shareable is on again.
- **P3-17** The owner org can toggle 可共享, switch the item off in its own org and delete it; it
  cannot change the scope or the list (rule 1). The owner org cannot be removed from its own item's
  list (409 `catalog.owner_required`).
- **P3-18** "Used by another org" = on in another live org (listed and not switched off for
  `named`, switched on for `optional`, any other live org for `all`).
- **P3-19** Owner deletes (plugin: new `POST orgs/:orgId/owned-plugins/:id/delete` after its
  preview; skill: the existing delete): if another org uses it, it is transferred (`owner_org_id` null, the owner
  removed from its list, platform notice `ownership_transferred`); otherwise removed as usual. The
  preview lists the other orgs (their names are already disclosed by `item_shared` notices) and the
  owner's agents that lose it.
- **P3-20** Org deletion runs the same rule for every item the org owns, inside
  `OrgsService.softDeleteIn`'s transaction (PG writes only); pending uploads are removed (first
  version) or cleared (new version). Removing an org-owned plugin also uninstalls its extension when
  no live item references it: after the commit, a job `owned-plugin-cleanup-<itemId>` on
  `cap-kernel-maintenance`, with a daily `@LockedCron` sweep (worker-only) repairing lost enqueues.
- **P3-21** A super admin confirmation racing a removal re-reads the pending state under the item row
  lock at each step; when the item was removed meanwhile, the cleanup job takes the just-installed
  extension out and the confirmation answers 409 `catalog.item_removed`.

Notices

- **P3-22** `org_notices.kind` gains `item_shared` (an org added to the list, or the scope widened;
  the detail names the org, or 全部组织), `shared_item_updated` (to the orgs where a shared org-owned
  item is on, except the owner), `upload_confirmed` and `upload_rejected`. A new `platform_notices`
  table (kind `ownership_transferred`, dismissed by any super admin) feeds the platform inbox, which
  also gains `org_upload_pending` (an org-owned item waiting in 待确认; such items leave
  `permission_confirmation`).

Admin component routes and 新建技能

- **P3-23** `admin/components/:kind/:id/*` accept the org row id of an unpromoted org-owned item
  (as `GET admin/components` lists it, ruling P2-11); an action that shows or associates promotes it
  first and answers with the platform id.
- **P3-24** 新建技能 is the existing `POST orgs/:orgId/skills` with a second body form `{ name,
  description, body, shareable? }`: the kernel writes `SKILL.md` (frontmatter name and description,
  then the body) and creates the skill with the checks of an upload (`customSkills`, name format and
  size limits of `readSkillPackage`, ruling P2-3, one live name per org). `shareable` is also
  accepted on upload.

Rulings made during implementation (2026-11-06)

- **P3-12'** (controller) A version without an extension that drops the previous version's extension
  applies at once (removing code never widens trust); the orgs using it get `shared_item_updated`.
- **P3-15'** (controller, replaces P3-15) `customSkills` = deny refuses org uploads carrying skills or
  agent templates, `customConnectors` = deny those carrying connector templates; a package with
  neither is allowed.
- **P3-25** Turning 可共享 off on an org-owned item (plugin or component) whose scope is `optional` /
  `all` narrows it in the same transaction to `named` = owner + every org where it is on.
- **P3-26** Import confirm hitting a non-shareable org-owned item fails closed (409
  `catalog.not_shareable`) before any request is marked.
- **P3-27** `catalog.owner_required` also guards a component's own `named` scope; ownership transfer
  writes the list directly.
- **P3-28** Org uploads refuse a plugin or extension name in the bundled bootstrap manifest or in any
  marketplace entry the deployment has read (409 `plugin.name_reserved`); bootstrap takes no name over.
- **P3-29** The org upload route checks membership and `catalog.upload` before reading the body.
- **P3-30** An owner may move its plugin to a lower version; the review shows the downgrade and the
  using orgs get `shared_item_updated`.
- **P3-31** The super admin's confirmation of an org upload carries `pendingDigest(sha256,
  reviewHash)`, tied to the exact package.
- **P3-32** An awaiting item that gets a version without an extension takes it as its first version
  (installed, pending cleared, name claim released; the old digest answers 409
  `extension.not_pending`).
- **P3-33** An upload claims its extension name before the plugin-name check.
- **P3-34** A pending or rejected version never becomes `latest_version`; every reader of an
  org-owned item (resolution, scope sync, migration job, org catalog views) reads applied versions only.
- **P3-35** `confirmOrgUpload` runs every step under the item's lock; the take-out runs only when the
  confirmation did not win.
- **P3-36** A confirmation whose extension name has a leftover install of another package is refused
  (409 `extension.name_conflict`): org code never inherits another package's config or secrets.
- **P3-37** Approve before applying (pending restored on failure); a super admin delete of an awaiting
  item and the take-out release its name claim; the generic update refuses a never-applied org version.
- **P3-38** A scope sync job whose extension is enabled but not loaded on its replica waits for a
  bounded reconcile, then re-enqueues itself (`scope-item-<id>-<v>-r<n>`, bounded attempts); the HTTP
  confirmation's reconcile wait is capped.
- **P3-39** Transfer narrows a component's own `all` scope to `named` = the orgs using it.
- **P3-40** An `optional` item stays `optional` after transfer; the former owner is then an ordinary
  org.
- **P3-41** An owner delete with no other users uninstalls the item in the owner org through the normal
  uninstall path (connectors kept as the org's own).
- **P3-42** Promotion and owner versions split into prepare (files, outside the transaction) and a
  `mandatory`-transaction write.
- **P3-43** The owner's promoted copy serves its own stored version while it equals the platform's (no
  "Updated skills" line), else the platform's under the copy id.
- **P3-44** Promoted skills get `plugin_name` null; templates keep it (the roster type is
  model-visible); plugin sync and template linking skip promoted rows.
- **P3-45** Every prepare (owner version, admin upload, promotion) writes to a unique object prefix;
  a loser's objects are deleted best effort after the failed transaction.
- **P3-46** Only content the org created can be shared or promoted (409 `catalog.not_owned`): org
  skills without a catalog item or platform link; no agent template until phase 4.
- **P3-47** Promoted rows are never plugin-installed, and uninstall never touches them.
- **P3-48** The super admin cannot upload a version to an org-owned promoted skill (409
  `catalog.not_owned`).
- **P3-49** The super admin's platform disable applies to the owner too, without a notice.
- **P3-50** One global lock order: org rows (sorted) -> the item -> its components;
  `PlatformPluginUpdater.commit` locks the connector orgs and the owner org first. Files of deleted
  promoted skills under `deployment/` are not collected in phase 3.
- **P3-51** An npm package name is an identity only within one owner: an org upload whose package
  another owner holds (another org, the platform, a removed item whose extension is still installed
  or claimed) is refused with 409 `plugin.name_taken` naming the owner; the cleanup's `referenced` and
  the confirm's existing-install check compare the catalog item and its owner, never the package name
  alone.
- **P3-52** Version rows record `applied_at` / `rejected_at` (migration 0084); the generic update, org
  version lists, dependency resolution and the admin item views of platform items use only applied,
  not rejected versions, whoever owns the item, so a transfer never makes an unapplied or rejected
  upload a usable platform version.

### 14.3 Not in phase 3

Editing a skill's text after creation, files for 新建技能, org-created agent templates and
用它创建智能体 (phase 4), an org changing who it shares with, and per-org versions of shared items.

## 15. Phase 4: agent templates (2026-11-07)

Phase 4 builds §8 (creating agents from templates, templates that describe what an agent needs, org
templates) and the template rows of §9, with the decisions below. The rulings of §13.5, §13.6 and §14
stay binding. Cited in code and docs as "ruling P4-<n>". Where this section and §8 or §9 disagree,
this section wins.

### 15.1 Decided by the maintainer (2026-11-07)

1. **用它创建智能体.** Any member creates an agent from a template; the agent is **private** by
   default. An org admin may create it org-shared (可见范围 全组织 / 指定成员).
2. **A connector the template needs is missing.** The agent is still created; the missing connector
   is marked **待配置** on the agent. A person allowed to configure connectors configures it;
   otherwise a request goes to the org admins automatically.
3. **No link after creation.** The agent is a copy, independent of the template from then on. The
   agent page shows only its provenance ("由模板 X v3 创建"); there is no update prompt and no apply.
   (This replaces the earlier "来源模板有新版本" idea, withdrawn the same day.)
4. **另存为模板** is for org admins only. The template is owned by the org and can be shared under the
   phase 3 rules (可共享, promotion on share). P3-46 opens for org-created agent templates.
5. **Sub-agents** a template describes are **not** created as separate agents: they go into the new
   agent's sub-agent roster.
6. **Org templates come only from 另存为模板.** There is no "new template from scratch" in phase 4;
   a template is edited afterwards with the same editor as an agent.
7. **A hand-configured connector** (an org's own MCP / OpenAPI connector, not made from a connector
   template) is recorded in a template as **"needs a connector"**: protocol, endpoint and the tools it
   offers, never credentials. Creating an agent from the template shows it 待配置.
8. **One page, cards.** The workspace 智能体 and 智能体模板 pages merge into one page with the tabs
   智能体 / 模板; both lists are **cards**, not tables. The admin 智能体模板 list becomes the same
   cards.
9. **No agents in the admin console.** The super admin does not see or manage orgs' agents; the
   platform layer keeps templates and the per-org sub-agent limits only.

### 15.2 Designer's calls

The template definition

- **P4-1** The template definition grows additively (SDK `AgentTemplate`, `agents/<name>.md`
  frontmatter; unknown keys stay ignored, existing files stay valid):
  - `skills` keeps its meaning: at most 3 **preloaded** skill names (they become the agent's pinned
    skills). New `selectedSkills`: further skill names the agent uses (not preloaded).
  - New `connectors`: a list of entries, each `{ template: "<connector template id>" }` (a
    connector template of the same plugin by its id, or a qualified `<plugin>:<id>`) or
    `{ needs: { protocol: "mcp" | "openapi", endpoint, tools: [names], label } }` (P4-11). An entry
    may name the tools to enable (`tools: [names]`; absent = all its tools).
  - New `subagents`: `{ general?: boolean, types?: [<type names>], inline?: [{ name, description,
    instructions, tools, skills (names), model (tier) }] }`; `types` are template types as the roster
    writes them (`<plugin>:<name>` or a bare `<name>`).
  - New optional `modelRef` (`provider/model`): the concrete model an org template was saved with
    (P4-4). New optional `quickActions` (the agent profile's 常用任务) and `instructionFiles` (the
    agent's instruction files, P4-12); `description` already exists.
  - Limits: `selectedSkills` ≤ 32, `connectors` ≤ 16, `subagents.types` + `inline` ≤ 16 (the agent
    limits), inline instructions ≤ 100 000 characters each. The JSON Schema and the SDK API report
    are regenerated; a changeset bumps the SDK.
- **P4-2** The template keeps working as a sub-agent type (roster unchanged): its new fields are
  ignored there except `selectedSkills`, which are read like `skills` for name resolution in a
  dispatch (`definition.ts` resolves names against the parent's selected skills).

Creating an agent from a template

- **P4-3** Route `POST /api/v1/orgs/:orgId/agents/from-template` (`agents.create`, member+) with
  `{ templateId, name, visibility?, members?, model? }`. Visibility other than `private` needs
  `agents.manage` (403 `agent.visibility_forbidden` otherwise). The template must be usable in the
  org (`usableTemplates`: org row, platform template on in the org, or another org's shared template
  on in the org). A preview route `POST …/agents/from-template/preview` with `{ templateId }` returns
  what will carry over (P4-5) and a `previewHash`; the create takes the hash and answers 409
  `agent.template_preview_stale` when the template's version or the org's state changed.
- **P4-4** Model: `modelRef` when the org can use that model; otherwise the model the org maps for the
  tier's purpose (`subagent_fast` / `subagent_standard` / `subagent_capable`; `inherit` = the org's
  default chat model); otherwise the org's default chat model. The dialog preselects it and the person
  may change it. `effort` becomes the model parameter `effort` when the model declares it; `maxSteps`
  has no agent field and is dropped (listed in the preview).
- **P4-5** What carries over, resolved at preview and again at create:
  - Instructions (and `instructionFiles` when present), description, quick actions.
  - Tools: builtin and plugin tool keys usable in the org become `AgentToolRef`s; keys of plugins not
    usable in the org are dropped and listed (不可用). `toolPolicies` and `disallowedTools` carry over
    for kept tools.
  - Skills: `skills` and `selectedSkills` resolve by name against the skills usable in the org (the
    org's own, linked copies, platform skills on in the org); found ones become `orgSkills` (and
    `pinned` for `skills`, ≤ 3); missing ones are listed and left out (no request: a skill comes with
    its plugin, which has its own request flow).
  - Connectors: a `template` entry binds the org's connector made from that platform connector
    template (`connectors.platform_template_id`) when exactly one exists; several → the first by
    creation, listed so the person can switch later; none → a **pending connector** (P4-6). A `needs`
    entry is always pending.
  - Sub-agents: `types` resolve with `findType` against the org's usable templates into
    `subagents.templates`; unresolved types are listed and left out; `inline` entries become inline
    definitions, their skill names resolved like the agent's and added to `orgSkills` when missing
    (`skill_not_selected` never fires).
  - The preview lists each item as 带入 / 待配置 / 不可用 with the reason.
- **P4-6** Pending connectors live in the agent definition: `pendingConnectors: [{ key, label,
  source: { template: <platform connector template id> } | { needs: {…} }, tools?: [names] }]`
  (`key` stable per entry). They are model-invisible (no tools until configured); the run never
  fails because of them. Resolving one (binding a connector) writes a new agent version that adds the
  connector's tools and removes the entry.
- **P4-7** Who resolves a pending connector, from the agent page's 待配置 notice (Tools section):
  - A person with `connectors.manage` (org admin+): for a `template` entry, create the connector from
    that template (the existing 补充配置 flow extended to "one more connector from this template",
    `POST /orgs/:orgId/connector-templates/:templateId/connectors`) or pick an existing connector;
    for a `needs` entry, open the custom connector form prefilled (protocol, endpoint), refused as
    today under `customConnectors = deny` (then the notice says a super admin must allow custom
    connectors). Binding is `POST /orgs/:orgId/agents/:agentId/pending-connectors/:key/bind
    { connectorId }` (agent editors: the owner or an admin+).
  - Anyone else (the agent's owner who is a member): the create writes **one org inbox request per
    agent** listing its pending connectors (new request kind `connector_setup` in `catalog_requests`,
    with `agent_id` and the keys; item and marketplace columns null), visible to org admins; deciding
    it means configuring (binding resolves the keys; the request closes when none are left) or
    rejecting with a reason (the owner gets the decision in the inbox, as for other requests).
    Requests are created automatically only at create; the notice offers 重新申请 after a rejection.
- **P4-8** Provenance: new columns on `agents`: `created_from_template_id text`,
  `created_from_template_version int`, `created_from_template_name text` (a snapshot for display after
  the template is gone); set once at create, never changed, not versioned. The agent page shows "由模板
  <name> v<version> 创建" in its basics; the template name links to the template while it exists and
  is usable.

Org templates

- **P4-9** 另存为模板 (`agents.manage`, from the agent page's ⋯ menu): `POST
  /orgs/:orgId/agents/:agentId/save-as-template { name, description }` writes an **org row**
  (`agent_templates`, `plugin_name` null, a bare `<name>`, version 1) like an org skill (P3-3: it stays
  an org row until promoted on share). The bare name must not clash with a type in the org's usable
  set (rule 10; 409 `agent_template.name_taken`, naming the owner). `putTemplateVersionIn` takes an
  optional `catalogItemId` (null for org templates).
- **P4-10** What 另存为模板 writes: instructions and `instructionFiles`, description, quick actions,
  `modelRef` (and `model: standard`), `effort` from the model params, builtin / plugin tool keys,
  `toolPolicies`, `skills` (the pinned ones' names) and `selectedSkills` (the other selected skills'
  names), connector tools → `connectors` entries (P4-11), `subagents` (template ids → their types,
  inline definitions with skill ids → names, `general`); allowlisted **org agents** in the roster are
  not templates and are left out (listed in the dialog). Pending connectors of the agent are carried
  as they are.
- **P4-11** Connector entries on save: a connector made from a platform connector template →
  `{ template: <id> }`; any other connector → `{ needs: { protocol, endpoint, tools, label } }` where
  `endpoint` is the connector's URL with userinfo, query and fragment removed, `tools` the enabled
  tool names, `label` the connector's name; no credentials, headers or OAuth data ever enter a
  template. Binding an entry whose `tools` name every enabled tool of the chosen connector writes
  `tools: "all"` (ruling P4-T6-12, found by the e2e run): an agent's 全部工具 survives the round trip
  through a template, and the agent's Tools section, which shows only whole connectors, shows it.
- **P4-12** Editing an org template uses the agent editor's sections (basics, prompt, model, tools,
  skills, connectors, sub-agents) on the template page; each save writes a new template version.
  The model section offers the tier and, optionally, a concrete model (`modelRef`). Only org admins of
  the owner org edit, delete, or set 可共享 (P3 rules); deleting follows P3 (a shared, used template
  becomes platform-owned). Agents created earlier are never touched.
- **P4-13** Sharing: P3-46 is lifted for org templates: `PUT /orgs/:orgId/agent-templates/:id/shareable`
  accepts org templates (owner org admins); promotion on share (P3-3) already handles
  `agent_template`. A promoted template keeps the bare name; P3-5 and rule 10 apply in other orgs.
  `customSkills = deny` does not gate org templates (a template carries no code).

Pages

- **P4-14** The workspace 智能体 page (`/agents`, nav 智能体) has the tabs **智能体** and **模板**
  (`?tab=templates`). The agent filters 全部 / 我的 / 共享 become a filter in the toolbar of the 智能体
  tab. 智能体模板 leaves 更多; `/agent-templates` redirects to `/agents?tab=templates` (and its
  detail to the new template page). Template detail: `/agents/templates/<id>` (read view for
  members, the editor for owner-org admins, 用它创建 as the primary).
- **P4-15** Cards: a new design component `CardGrid` (+ `ObjectCard`): a responsive grid
  (`auto-fill`, min card width from a token), each card: avatar or icon, name, a two-line description,
  one meta line (agents: owner · 可见范围; templates: source (平台 / 本组织 / 组织名 / 插件) · v),
  one primary action and a ⋯ menu; the whole card opens the detail. Loading and empty states, keyboard
  (roving focus by row), and the spec / reference block / accepted.ts entries as for any design
  component. It is a single box per card on the page ground (no box around the grid: the one-box
  rule of `docs/design/spec.md`, acceptance item AB).
- **P4-16** Card actions: an agent card's primary is 开始会话; ⋯ holds 设置, 运行记录 and
  另存为模板 (org admins). 更改所有者 stays on the agent page's ⋯ only: the maintainer removed the owner
  change from the agents list during the phase 3 acceptance (item P, 2026-11-07), and a designer's call
  does not overturn it. A template card's primary is 用它创建; ⋯
  holds 查看, 编辑 / 可共享 / 删除 (owner-org admins), and the component switch for platform
  templates (org admins; the existing switch).
- **P4-17** The admin 智能体模板 list (`/admin/agent-templates`) uses the same cards with its tabs 全部 /
  平台 / 组织创建; card meta: source · owner · scope · v; primary 查看; ⋯ the existing scope, disable
  and 对其他组织显示 actions. 技能 and 连接器模板 keep their tables.
- **P4-18** 用它创建 opens a dialog: name (default: the template name), avatar, 可见范围 (shown to org
  admins; members always 仅自己), model (P4-4), then the preview groups (P4-5) with 带入 / 待配置 /
  不可用 counts and details; 创建 lands on the new agent's page, its 待配置 notice in view.

### 15.3 Not in phase 4

Creating a template from scratch, linking agents to templates after creation, the super admin seeing
orgs' agents, a member-visible restriction on ordinary agent creation (today any member may create an
org-visible agent; only the template flow gates it), per-org versions of shared templates, and
template files beyond instructions (attachments).

## 16. Marketplace entry icons (2026-11-08)

Maintainer decision 2026-11-08: the admin 插件 → 市场 rows show icons, not only initials.

- **Imported plugins** show the catalog item's own icon, the image 已安装 shows (the item's current
  version, `PluginIcons`), also on an entry of a newer version that is not imported yet.
- **Plugins not imported** show the icon the marketplace gives: an optional `icon` on a
  `marketplace.json` entry (SDK `MarketplaceEntry.icon`, display only). It is either
  - an absolute `https://` URL whose path ends in `.svg` / `.png` (a query is allowed, no fragment;
    http only on loopback in tests), or
  - `./<path>.svg|png` inside the marketplace's repository, read at the commit the marketplace was
    refreshed at, from the pack that refresh fetched anyway. Git marketplaces only: an http
    marketplace has no repository, so such an icon is ignored there. A single-plugin repository's
    entry takes its `plugin.json` `icon` this way.
- **Toolchain:** `capybara-plugin marketplace --write` fills each entry's `icon` with the repository
  path of the plugin's `plugin.json` `icon` (`./plugins/<dir>/<icon>`) and refreshes it like
  `summary` / `displayName` (`marketplace-display-stale`). A repository path moves with the
  marketplace commit, so it stays right after every release without naming a tag (a tag does not
  exist yet when the Version Packages PR writes the file; a commit is not known before it is made).
  The official marketplace is a git marketplace, so it uses this form.
- **Kernel:** each refresh that reads a manifest, or finds it unchanged, brings the marketplace's
  icons in line with its stored entries (`catalog/marketplace-icons.ts`, migration 0099
  `marketplace_icons`: one row per marketplace and icon as written, svg / png bytes, sha256,
  content type). A URL is downloaded through `packages/kernel/src/net` under the marketplace
  network rules (https, public addresses or `allowPrivateHosts`, `net.httpsProxy`, no redirects,
  10 s, at most 64 KiB) and `marketplaces.allowedHosts`, never with the marketplace token, and only
  when it is not stored yet: a URL's content counts as fixed, a new icon needs a new URL. At most
  100 downloads per refresh, 4 at a time. A repository path is read again at every new commit. The
  content must really be an svg / png of at most 64 KiB (the plugin icon check). A missing, refused,
  oversized or invalid icon is logged and skipped; it never fails the refresh, and the row falls
  back to the initial. Icons no entry names any more are deleted; deleting the marketplace deletes
  its icons.
- **API:** `GET /api/v1/admin/marketplaces/entries` gives each entry `icon` (the imported item's
  icon URL, else `/api/v1/admin/marketplaces/:id/icons/:sha256`, else null). The icon route serves
  the stored bytes from PG with the plugin icon headers (`sendCatalogIcon`: content type, nosniff,
  CSP sandbox). Both are super admin routes.
- **Org browse** (follow-up decision 2026-11-08: the icon is the same everywhere):
  `GET /api/v1/orgs/:orgId/marketplaces/entries` gives `icon` too: the item's org icon route
  (`/api/v1/orgs/:orgId/catalog/:itemId/icon`) when the org's catalog shows the item (the share
  gate; a hidden item reads as not imported and shows the marketplace icon), else
  `GET /api/v1/orgs/:orgId/marketplaces/:id/icons/:sha256`, gated like the org browse
  (`catalog.decide`, `orgMarketplaceBrowse` on, the marketplace enabled; else 404) and served
  the same way. Both icon routes are Platform exclusions (transport: image bytes).
- **Web:** the admin and the workspace market rows' mark is `ObjectMark` with `image: icon` (the
  initial when null or when the image fails).
