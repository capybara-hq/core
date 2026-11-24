# One plugin contents view for install, update, enable, disable and the plugin pages

Status: approved by the maintainer through the design canvas "插件审阅设计稿"
(https://claude.ai/artifact/9txvQEckWEyLqk63JvbSUM, 2026-11-25: "布局和内容规划上没有问题，请遵循
Capybara 的视觉规范进行实现"). Follows core#807 and #820.

## Why

Six places show what a plugin package holds: the platform install review, the platform update, the
org enable page, the org upload dialog, the platform plugin page and the org plugin page; the org
switch-off dialog shows what it takes away. Today they are four separate renderings:

- `PluginReviewBody` (platform install, org upload) follows the approved review mockup;
- the org enable page (`CatalogInstallWizard`) lists names only, connector descriptions truncated,
  no addresses, no plugin description;
- the org plugin page draws one Card per connector template with the raw endpoint;
- the platform plugin page's 组件 tab is a table of manifest rows.

The maintainer reads them as the same thing ("这些地方似乎会显示一样的内容？") and found the copy
AI-flavoured. One view, cut by stage and role, makes them read the same and keeps them in step.

## Goals

1. One contents view (`PluginContents`) renders a package's contents everywhere; each surface passes
   its stage and audience and fills the row's trailing slot.
2. The surfaces show what the canvas's matrix (artboard "总览") shows; the canvas is the layout
   reference for every artboard.
3. The platform update is one review page: the package with change marks on its rows, then
   "更新后" with the impact. Two steps: 选择插件包 → 审阅并确认.
4. The org enable page shows the plugin's description, what each component is and each connector's
   state after enabling.
5. A plugin without an extension or connector templates is switched on directly; the toast says
   what arrived and offers 撤销.
6. Copy follows design spec §7.1 and reads plain: no parenthesised asides, no colon explanations, no
   reassurance tails, no system words (部署, 副本, schema, 平台目录, 端点, slug) where the user's word
   exists.
7. An invalid package error lists its problems.

## Non-goals

- Kernel changes. Every field needed is already returned (see "Data" below); a surface that lacks
  one reads an existing route.
- The platform update dialog of the 版本 tab (moving to an already imported version) and the org
  upload's update: they have no staged package to review and keep `PlatformUpdatePreviewBody`, with
  the new copy.
- The Claude Code translation codes' wording (technical reasons per item).
- Mobile-specific forms beyond what the design components already do at compact.

## Anti-goals

- A page that loses information: everything shown today stays reachable (folded if not central).
- Styles in apps/web: the canvas is drawn in plain HTML; the implementation uses only
  `@capybara-hq/design` components and tokens (writing-web-ui). Where a look needs a component that
  does not exist, it is added to the design package first, with its spec entry and test.

## The contents view

`apps/web/src/components/plugin-contents/` holds:

- `model.ts`: `PluginContentsModel` (head, description, facts, extension, skills, connector templates,
  agent templates, dependencies, translation) and its row types; each row has an optional
  `trailing` (a mark or state text) and `mark` (`added` / `removed` / `upgrade` / `downgrade`).
- adapters, one per data source: `fromReview(PluginReview)`, `fromOrgDetail(OrgCatalogDetail,
  OrgComponent[], OrgExtension | undefined)`, `fromManifest(CatalogItemDetail, PlatformComponent[])`;
  `withUpdateMarks(model, PlatformUpdatePreview)` lays an update's changes onto a model (match by
  kind plus name: skill `name`, connector template `id`, agent template `name`; a component the
  preview lists as `removed` becomes a row marked 移除).
- `PluginContents.tsx`: the renderer, `audience: "platform" | "org"`. Platform shows 发布者, 来源,
  构建 and 许可证; org shows 发布者 only. Sections in this order, empty ones folded into one closing
  line: 扩展, 技能, 连接器模板, 智能体模板, 依赖, then the translation summary (platform only).

### Head (canvas: 平台安装)

- The name, the version chip (`安装 v…`, `v… → v…` on update, the plain version elsewhere), the
  sensitive total in warn.
- The description's first sentence, followed on the same line by 完整说明 ›; opening it shows the
  whole description in place (not the remainder under a guide), with 收起. New design component
  (below).
- Facts (`KeyValue`): 发布者; platform also 来源 (npm / git chip and package), 构建 (repository@commit,
  未验证 when unverified) and 许可证 (its SPDX name, else "LICENSE", then 全文 ›). 全文 opens a Dialog
  with the license `CodeBlock`; a long license never stretches the page.

### Rows

- 扩展: one block; 提供 (extension point chips, the plain-language risk in warn), 配置 (top-level
  field chips, a lock on secrets), one note line (install: 安装后在「扩展」页填写; org: 启用后在「扩展」页配置).
  On update, new permissions carry 新增 (as today).
- 技能: name, file count, description; SKILL.md › opens inline (`DisclosureLinks`).
- 连接器模板: icon, name, need badge, and the host line (· 组织可改) as the toggle that opens the
  description, full address and auth (as #820). Default-off templates say 默认关闭.
- 智能体模板: name, model tier, description, 需要 and 工具 rows, 说明全文 ›.
- 依赖: `name 将使用 v…` (platform), 同时安装 (org enable).
- Trailing slot per surface: update `升级` / `新增` / `移除` / `降级`; platform page the component's
  scope (跟随插件 or its own, linked); org enable the state after enabling (可用 / 待配置 · 需要 OAuth
  客户端 / 待配置 · 需要组织凭据 / 已有连接器，保留 / 默认关闭，不创建); org page the org's connector state.

## Surfaces

| Surface | Stage, audience | Extras |
|---|---|---|
| Platform install (`/admin/plugins/import`) | install, platform | 给哪些组织 (scope), the sensitive ack, deploy lines |
| Platform update (same wizard, installed plugin) | update, platform | change marks, 更新后 (impact), the ack only when the update adds sensitive permissions or warnings |
| Org upload dialog | install, org | unchanged extras |
| Org enable (`/plugins/[id]/enable`) | enable, org | no step bar (one step), 启用 |
| Platform plugin page 组件 tab | detail, platform | scope per row; client code and UI components as lines under the extension |
| Org plugin page | detail, org | 本组织的连接器 (the org's connectors from this plugin, their setup state; members see their own connection) above the contents |

- **更新后** reuses the impact groups of `PlatformUpdatePreviewBody` without its components table (the
  marks are on the rows): extension, orgs (connectors updated, created with pending count, deferred,
  credentials reset, turned off), scope installs, pinned and kept components, themes.
- **Switch-off dialog**: groups 将移除, 随插件停用 (with "配置和凭据保留"), 受影响的智能体, 保留 (with the
  reason); nothing to lose is one sentence and the two buttons.
- **Direct switch** (no extension, no connector templates): unchanged rule (`reviewsFirst`); the
  success toast names what arrived (技能 n, 智能体模板 n, 主题 n) and carries 撤销, which switches the
  plugin off again without the skills dialog (the person just switched it on). Spec §6.7: a success
  toast with an undo stays 8 s.
- **Invalid package**: `catalog.invalid_manifest` details are plain strings; the error lines show
  them (up to 50, as the kernel caps), on the market page, the import wizard, the org upload and the
  update dialog. The message keeps its colon only when lines follow.

## Design package additions

- `ExpandableProse({ summary, text, moreLabel, lessLabel })`: prose whose first sentence is followed
  inline by a small muted toggle; open shows the whole text with the toggle at its end. Spec §6.5.
- `WizardPage` with one step draws no step bar (a one-page review is not a wizard step). Spec §5.9.
- Spec "Plugin and component details": the license is a 许可证 fact with 全文 › opening a Dialog
  (replaces "a folded section at the end").

## Copy

Spec §7.1 governs (sentences keep 。, labels none, names in toasts in 「」). Rewrites follow the canvas;
the plan lists every key. Examples: "启用后本组织会得到：" → section titles only; "（声明，未验证）" →
未验证; "确认后把 {version} 加入平台并把插件更新到它，所有组织一起更新。确认前取消不会改动任何东西。" →
"确认后所有组织一起更新到 {version}。"; 端点 → 地址; the dependency hint sentence is gone.

## Data (no kernel change)

- Install / update: `PluginReview` (staged import), `PlatformUpdatePreview` (staged update preview).
- Org enable / org page: `OrgCatalogDetail`, plus `orgComponentsQuery(orgId, { itemId })` for skill,
  template and agent template descriptions, `orgExtensionsQuery` for the extension's points and
  whether it needs config, the org connectors list for the org page's connector states.
- Platform page: `CatalogItemDetail` manifest plus `adminComponentsQuery` (scope, links).

## Left to the builder

- Exact zh / en wording beyond the listed keys, within §7.1 and the canvas.
- Whether the org page's connector rows show a connection count (only if the connectors route
  already returns one).

## AGENTS.md rules touched

None. The work follows the existing Web UI rules (template + design components, query cache, no
styles in apps/web) and adds two design components through the design package's change flow.
