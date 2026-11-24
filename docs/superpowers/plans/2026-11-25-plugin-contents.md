# Plugin contents view Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One `PluginContents` view renders a plugin package on the platform install and update, the org
upload, the org enable page and both plugin pages, cut by stage and audience, with plain copy.

**Architecture:** Adapters turn each data source (`PluginReview`, `OrgCatalogDetail` + org components,
`CatalogItemDetail` manifest) into one `PluginContentsModel`; one renderer draws it with a per-surface
trailing slot. The update wizard becomes one review page with change marks and an impact section.
Web only; two small design components first.

**Tech Stack:** Next app `apps/web`, `@capybara-hq/design`, TanStack Query, next-intl, vitest + Testing
Library, Playwright e2e.

**Spec:** `docs/superpowers/specs/2026-11-25-plugin-contents-design.md`; layout reference: the canvas
"插件审阅设计稿" (https://claude.ai/artifact/9txvQEckWEyLqk63JvbSUM). Read both before any task.

## Global Constraints

- apps/web writes no styles (no `className`, `style`, `.css`, color literals); only design components
  and tokens (`pnpm check:web-ui`). Missing looks go into `packages/design` first (writing-web-ui,
  "Adding a component or template").
- Copy: design spec §7.1 (sentences end with 。/ "."; titles, buttons, labels, captions have none;
  names in toasts in 「」 / "…"); zh and en together; `pnpm check:i18n` passes; zh says 智能体, 平台,
  never 企业 or the Latin "agent".
- Words: 地址 (never 端点 in UI copy), 平台 (never 部署 / 平台目录 in UI copy where the user's word
  exists), no "本副本", "schema", "slug" in review copy.
- No kernel change; every `apiFetch` stays parity-clean (`pnpm check:web-api-parity`).
- Comments in English (`pnpm check:english-comments --base origin/main`).
- Before pushing: `pnpm verify --fast`, `pnpm exec vitest run --project web`, the e2e specs of the
  touched flows (`apps/web/e2e/catalog-flow.spec.ts`, `admin-extensions.spec.ts`), english comments.
- One box is enough: inside a Dialog / Card no second box (`findNestedBoxes` in tests).

## Review Focus

1. An update whose package removes a component: the removed row still shows, marked 移除, and the
   impact lists agents that keep it.
2. An org enable for a plugin whose template the org already has a connector from: the row says
   已有连接器，保留 and no need badge.
3. A plugin with an extension that needs no config: no "启用后在「扩展」页配置" line.
4. A license over 64 KiB (`licenseTruncated`) and no license at all: the 许可证 fact says so, no 全文.
5. A direct switch undone from the toast: the plugin is off again, no skills confirmation dialog.

## Wave table

| Task | Depends on | Files / areas | Risk | Wave | Review |
|---|---|---|---|---|---|
| 1 Design: ExpandableProse, one-step WizardPage | — | packages/design, docs/design/spec.md | normal | 1 | batched |
| 2 Invalid package lines | — | apps/web/src/lib/api.ts, CatalogParts.tsx, messages (errors.*) | normal | 1 | batched |
| 3 Contents core + review | 1 | components/plugin-contents/*, PluginReviewBody.tsx, import/view.tsx (install), messages (catalog.admin.review, catalog.components) | normal | 2 | own |
| 4 Update as one review | 3 | import/view.tsx (update), PlatformUpdateDialog.tsx, messages (catalog.update) | normal | 3 | batched |
| 5 Org enable | 3 | CatalogInstallWizard.tsx, plugin-contents/from-org.ts, messages (catalog.org.install) | normal | 3 | batched |
| 6 Platform page 组件 tab | 3 | admin/plugins/[itemId]/view.tsx, plugin-contents/from-manifest.ts, messages (catalog.admin.detail) | normal | 3 | batched |
| 7 Switch-off and direct switch | 3 | PluginSwitch.tsx, messages (plugins.switchOff, plugins.toast) | normal | 3 | batched |
| 8 Org plugin page | 5 | plugins/[itemId]/view.tsx, messages (catalog.org.detail) | normal | 4 | batched |

Wave 3's tasks each run in their own worktree (they all touch the message files, in different
namespaces) and are merged back in task order.

---

### Task 1: Design components

**Files:** Create `packages/design/src/display/expandable-prose.tsx`, `packages/design/test/expandable-prose.test.tsx`; modify `packages/design/src/display/index.ts`, `packages/design/src/templates/wizard-page.tsx` (or where `WizardPage` lives), its test, `packages/design/src/styles/display.css`, `docs/design/spec.md` (§6.5, §5.9, "Plugin and component details").

**Interfaces:** Produces `ExpandableProse({ summary: string; text: string; moreLabel: string; lessLabel: string })` exported from `@capybara-hq/design`; `WizardPage` with `steps.length === 1` renders no step bar.

- [ ] Test `ExpandableProse`: collapsed shows `summary` and a button named `moreLabel` with `aria-expanded="false"`; click shows `text` (whole) and a button named `lessLabel`; when `summary === text` no button.
- [ ] Test `WizardPage` with one step: no `[data-part="wizard-steps"]` (use the part the template draws); two steps: the bar is drawn.
- [ ] Implement; the toggle is the `small` `muted` inline text button look of `DisclosureLinks` (§6.5), inline after the prose.
- [ ] Spec: §6.5 ExpandableProse entry; §5.9 one step = no bar; "Plugin and component details": 许可证 is a fact with 全文 › opening a Dialog.
- [ ] `pnpm exec vitest run packages/design` passes; commit `feat(design): ExpandableProse and one-step WizardPage`.

### Task 2: Invalid package problems are listed

**Files:** `apps/web/src/lib/api.ts` (`toDetails` / `issueLines`), tests `apps/web/test/catalog-pages.test.tsx` (market and import wizard cases), messages `errors.catalog.invalid_manifest` (+ a no-detail variant).

- [ ] Test (market page): `POST …/entries/x/import` answers 422 `{ error: { code: "catalog.invalid_manifest", message, details: ["no skill this platform can import", "bad field"] } }` → the banner shows both lines under the message.
- [ ] Test (import wizard, existing case at "an upload without a plugin manifest…"): with string details the lines show; without details the message ends with 。 (no dangling colon).
- [ ] Implement: string entries of `rawDetails` become issue lines for every error (not only this code); the message key without lines reads "插件包不合法。" / "The plugin package is invalid.".
- [ ] Commit `fix(web): list the problems of an invalid plugin package`.

### Task 3: Contents core and the install review

**Files:** Create `apps/web/src/components/plugin-contents/{model.ts,from-review.ts,PluginContents.tsx,rows.tsx}`; modify `PluginReviewBody.tsx` (becomes `fromReview` + `PluginContents`, same export and props), `import/view.tsx` install branch copy, messages `catalog.admin.review`, `catalog.components`; tests `plugin-review-provenance.test.tsx`, `catalog-pages.test.tsx` (import describes), `org-plugin-upload.test.tsx`.

**Interfaces:** Produces
```ts
type Stage = "install" | "update" | "enable" | "detail";
type Audience = "platform" | "org";
type RowMark = "added" | "removed" | "upgrade" | "downgrade";
interface ContentsRow { key: string; kind: "skill" | "connectorTemplate" | "agentTemplate" | "theme"; name: string; mark?: RowMark; trailing?: ReactNode; /* kind-specific fields */ }
interface PluginContentsModel { head: {...}; description: string; facts: {...}; extension?: {...}; skills: ContentsRow[]; templates: ContentsRow[]; agents: ContentsRow[]; themes: ContentsRow[]; dependencies: {...}[]; translation?: TranslationReport }
function fromReview(review: PluginReview, opts: { installedVersion?: string | null; locale: string }): PluginContentsModel;
function PluginContents(props: { model: PluginContentsModel; audience: Audience; stage: Stage; mismatch?: PermissionsMismatch }): JSX.Element;
```
- [ ] Tests: head shows first sentence + 完整说明 (ExpandableProse); opening shows the whole description; 许可证 fact with SPDX name and 全文 opening a Dialog with the license; `licenseTruncated` and no license cases (Review Focus 4); org audience hides 来源 / 构建 / 许可证; extension note only when the extension has config (Review Focus 3); rows keep #820's behaviour (host toggle, inline SKILL.md / 说明全文).
- [ ] Rewrite the keys of `catalog.admin.review` and `catalog.components` used here per spec "Copy" and §7.1 (e.g. `unverified` "未验证", `dependencyResolved` "{name} 将使用 {version}", drop `dependenciesHint`, `ackHint` "含敏感权限，确认前请看一下。", `ack` "我已看过敏感权限", `deployOn`, `noExtension`, `translation.summary`), en in step.
- [ ] Commit `feat(web): one plugin contents view; the install review uses it`.

### Task 4: The update is one review page

**Files:** `import/view.tsx` (update mode: steps 选择插件包 → 审阅并确认), create `plugin-contents/update-marks.ts`, `PlatformUpdateDialog.tsx` (extract `UpdateImpact` = the impact groups without the components table), messages `catalog.update`; tests `catalog-pages.test.tsx` ("install a new plugin, update an installed one"), `admin-components.test.tsx` (platform update), `apps/web/e2e/catalog-flow.spec.ts` (the git marketplace update test).

**Interfaces:** Consumes Task 3. Produces `withUpdateMarks(model, preview: PlatformUpdatePreview): PluginContentsModel` (match kind + name; `removed` rows appended with mark) and `UpdateImpact({ preview, orgName, themeName })`.
- [ ] Tests: the review step shows rows marked 升级 / 新增 and a removed component as a row marked 移除 (Review Focus 1); 更新后 lists orgs, created connectors with the pending count; one primary "更新到 v…" sends `{ reviewHash, diffHash }`; the ack shows only when the update adds sensitive permissions or warnings; stale preview re-reads (existing behaviour).
- [ ] The 版本 tab dialog and the org upload keep `PlatformUpdatePreviewBody` (with `UpdateImpact` inside) and the new copy.
- [ ] Commit `feat(web): the platform update is one review page`.

### Task 5: Org enable page

**Files:** `CatalogInstallWizard.tsx` (`Review`), create `plugin-contents/from-org.ts`, messages `catalog.org.install`; tests `catalog-pages.test.tsx` ("/plugins/[itemId]/enable (one review page)", "descriptions in the UI language", SSR describe).

**Interfaces:** Produces `fromOrgDetail(detail: OrgCatalogDetail, components: OrgComponent[], extension: OrgExtension | undefined, locale): PluginContentsModel` and `enableState(template: OrgCatalogTemplate): "ready" | "needs_client" | "needs_credential" | "kept" | "off"`.
- [ ] Tests: head name, version, 「{publisher} 发布」 caption, description with 完整说明; connector rows' trailing state for each `enableState` (Review Focus 2); skills and agent templates show their descriptions (from org components); extension shows provides and the config note only when `needsConfig`; 同时安装 lists dependencies; no step bar; descriptions in zh when `descriptionZh` exists.
- [ ] Rewrite `catalog.org.install` keys used (drop `summary` "启用后本组织会得到：", `summaryDependencies` → "同时安装", `summaryNeedsConfig` → one sentence under the list).
- [ ] Commit `feat(web): the org enable page shows the plugin contents`.

### Task 6: Platform plugin page 组件 tab

**Files:** `admin/plugins/[itemId]/view.tsx` (`ComponentsTab`, license fact), create `plugin-contents/from-manifest.ts`, messages `catalog.admin.detail`; tests `catalog-pages.test.tsx` ("/admin/plugins: installed, detail with scope, pending"), `admin-components.test.tsx`.

**Interfaces:** Produces `fromManifest(item: CatalogItemDetail, components: PlatformComponent[], locale): PluginContentsModel`.
- [ ] Tests: rows carry the component scope as trailing text linking to the component page; client code and UI components are lines under the extension; dependencies keep their catalog links; the license is a fact with 全文 (Dialog), no folded section at the end.
- [ ] Commit `feat(web): the platform plugin page lists its contents`.

### Task 7: Switch-off dialog and the direct switch

**Files:** `PluginSwitch.tsx` (`SwitchOffDialog`, `enable`), messages `plugins.switchOff`, `plugins.toast`; tests `catalog-pages.test.tsx` ("/plugins: states and actions follow the scope and the switch").

- [ ] Tests: dialog groups 将移除 / 随插件停用 (配置和凭据保留) / 受影响的智能体 / 保留 with reason; nothing to lose → one sentence; direct switch toast "已启用「{name}」，加入了 4 个技能。" with 撤销; 撤销 switches off without the skills dialog (Review Focus 5).
- [ ] Commit `feat(web): plainer switch-off dialog; direct switch toast with undo`.

### Task 8: Org plugin page

**Files:** `plugins/[itemId]/view.tsx`, messages `catalog.org.detail`; tests `workspace-components.test.tsx` ("/plugins/[itemId]: components and 补充配置"), `catalog-pages.test.tsx` (SSR describe for /plugins/[itemId]).

**Interfaces:** Consumes `fromOrgDetail` (Task 5) and the org connectors query (match `connector.platformTemplateId` to the template component id).
- [ ] Tests: 本组织的连接器 lists the org's connectors from this plugin with 可用 / 待配置 and, for org admins, 创建 for a default-off template without a connector; members see the rows without actions; the per-template Cards are gone, the contents view follows.
- [ ] Commit `feat(web): the org plugin page shows its connectors and contents`.

### Finish

- [ ] Changeset `@capybara-hq/capybara` patch; `pnpm verify --fast`; all web tests; e2e catalog-flow + admin-extensions; english comments; PR; `visual-update` workflow for baselines; reopen the PR to run CI.
