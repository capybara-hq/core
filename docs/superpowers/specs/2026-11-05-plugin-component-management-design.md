# Plugins and components: one model for bringing in, scoping and managing capabilities

- Date: 2026-11-05, written against `main` at `40d81dc1` (v0.1.0-rc.4).
- Status: draft, for maintainer review.
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
install, so the enterprise admin has no single place to see or update them.

The maintainer's own description of the job (decided):

1. pick a source: the official marketplace, or add a Git marketplace source;
2. bring a plugin in from a marketplace, or upload a plugin package;
3. set it up and use it. With a Jina web tools plugin as the example: the enterprise admin can set
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
4. **Ownership** (decided): what an org creates or uploads belongs to that org; only the enterprise
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

- A capability that is on for an org without anyone having chosen that (the enterprise admin through
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
| 市场 Marketplace | A source of plugins (official, or an enterprise http / Git source) | yes |

"企业目录" / "catalog" disappears from the UI: the enterprise's installed plugins are simply the
插件 page (designer's call). The code may keep `catalog_*` names.

The four component kinds were checked against the code (`PluginManifest`, `ComponentKind`):
extension, skills, connector templates, agent templates; dependencies are references to other
plugins, not components. Tools, hooks, UI, channels and model providers are registered by an
extension and follow it; they are not components.

## 4. Bringing a plugin in

### 4.1 Enterprise admin

Entry points on the admin 插件 page (decided):

- the 市场 tab: browse the official marketplace and enterprise sources, 引入 an entry (or 更新 one
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
- **with an extension**: stored as pending; the enterprise admin reviews it in 待确认 (the same review
  as §4.1) and confirming installs it, owned by the org, scope "named: this org". Until then the org
  sees 等待企业管理员确认 and nothing of the plugin is usable, not even its skills (designer's
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

1. **Owner**: `enterprise` (brought in or uploaded by the enterprise admin, and bootstrap plugins) or
   an org (created or uploaded in that org). An org-owned item starts as `named: [owner]` and only
   the enterprise admin can add orgs to it or change its scope (decided).
2. **Plugin scope and component scope** (decided): a plugin has a scope; each component either
   follows its plugin (default) or has its own. Changing a plugin's scope applies to all its
   components, including those with their own; the confirmation lists the ones whose own setting will
   be replaced (designer's call on the listing).
3. **Built-in** plugins are `all` and their scope cannot be changed; their extension cannot be
   disabled (today's `extension.required`).
4. **Disabled** is not a scope: the enterprise admin can stop a plugin or component on the whole
   deployment (today's extension disable, item policy `disabled`), keeping its scope for later.
5. An org admin's switch acts on what the scope offers: on a plugin it switches all components that
   follow the plugin; on a component, only that component (designer's call).
6. **Replaced concepts**: catalog item policy (`allow` / `needs_approval` / `disabled`), org grants
   and catalog requests (`catalog_requests`, the 申请 flows and 部署申请 page) are replaced by scope
   and disable. `needs_approval` with grants maps to `named` with the granted orgs; members no longer
   request plugins (designer's call: the decided model has the enterprise admin choose who gets
   what; a request flow can come back later).
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

## 6. Components at deployment level

Today an org install copies the plugin's skills, agent templates and connectors into org rows
(`skills.org_id`, `agent_templates.org_id`, `connectors.org_id`); there is no enterprise-level row
for a component. That makes goals 2, 3 and 5 impossible: an enterprise skill exists N times, updating
it means N updates, and there is nothing to attach a scope to.

**Designer's call: enterprise components live once, at deployment level.**

- Enterprise-owned skills, connector templates and agent templates get deployment-level rows with
  versions (a skill version keeps today's object-storage layout), plus their plugin provenance.
- An org's usable set = what the org owns ∪ enterprise or other-org items whose scope makes them
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
  orgs become enterprise-owned and stay available (today's `ON DELETE CASCADE` and the
  `kernel/<orgId>/` storage prefix must not take them down); items used only by the deleted org go
  with it.
- Model-visible names must not change: skill keys and `<plugin>:<name>` stay as they are, so replays
  of existing conversations keep zero drift (`replay-evals`). Agents keep referencing skills and
  connectors by id; existing org copies of enterprise components are merged into the deployment-level
  rows by a migration that keeps every id agents reference working (the builder chooses how: kept
  ids, an alias table, or rewritten agent definitions with new versions).

This replaces per-org versions and rollback of declarative plugins (ecosystem spec §0 item 9):
an enterprise plugin has one installed version for the deployment.

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
- Pending catalog requests are closed with a note; the 申请 flows go away (§5 rule 6).

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
  enterprise-created) is the bare `<name>`, unique in each org's usable set (§5 rule 10), so
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
| 技能 / 连接器模板 / Agent 模板 | Every item of the deployment, enterprise and org-owned: from (plugin, upload, org), owner, scope, version; tabs 全部 / 企业 / 组织创建; the enterprise admin associates org items with other orgs here |

Workspace sidebar (decided via the mock): 新会话, 首页, Agents; 更多 holds **插件**, **扩展**,
**技能**, **连接器**, **Agent 模板**, 渠道, 评测与运行, 组织设置. Org settings lose 扩展 and
已安装的插件; `/catalog` becomes the org's 插件 page.

| Page | Content |
|---|---|
| 插件 | What the org can use: enterprise plugins in scope and the org's own; state 已启用 / 未启用 / 等待企业管理员确认; 启用 and 组织配置; 上传插件包 (admins) |
| 扩展 | Extensions in scope with the org switch and org config (today's `/settings/extensions` content); 已启用 · 企业统一 for `all` |
| 技能 | In-scope enterprise skills and the org's own, with switches; 新建技能, 上传 (.zip) |
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
- Every import route is `@EnterpriseAdmin`; `plugin_import_staging` has no org.
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
  independent updates; (3) org uploads with enterprise confirmation; (4) agent templates as agent
  starters.
- HTTP routes and their shapes; the review's exact layout; empty and loading states.
