# Plugin pages redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. In this repository, layer `wave-planned-subagent-development` on top (wave plan below).

**Goal:** Make the plugin pages cards with a scalable source filter and a card-based sources page. Make install, update and enable review-only, with connectors that need input waiting as 待配置 on the connectors page.

**Architecture:** Phase 1 is web only: design-system support (scope select overflow, card slots), the four lists as cards, the sources page as cards plus a dialog, the review body subtractions and the two-step platform install. Phase 2 is the kernel plus web:
- a derived connector setup state;
- a connector create path that defers the tool list to an outbox job;
- install, scope sync and upgrade without input, and a one-off reconciliation;
- the org enable page as a single review.

**Tech Stack:** TypeScript, NestJS + Fastify kernel (Kysely, BullMQ, outbox), Next.js web on `@capybara-hq/design`, TanStack Query, vitest, Playwright visual tests.

**Spec:** `docs/superpowers/specs/2026-11-24-plugin-pages-redesign-design.md` (issue core#807). Read it first. Section references (§) below point to it.

## Global Constraints

- English for code, comments, test titles and commits. UI copy goes through i18n in zh and en (`apps/web/messages/{zh,en}.json`, `test/messages-parity.test.ts`). zh says 平台 / 超级管理员 / 智能体, never 企业 or the Latin `agent`.
- apps/web writes no styles. A page is a design template plus design components. A structure that differs by size class lives in the design package. No box inside a box. Every read is a `defineQuery`, and every write is a `useAppMutation`.
- No input field on any install, update or enable page (spec §3 anti-goal).
- Roles everywhere: a member never sees a button they cannot use. 待配置 shows a 配置 button for admins and the text 待管理员配置 for members.
- No outbound call inside a transaction. Work after commit goes in an outbox row written in the same transaction. BullMQ queue names and job ids contain no `:`. Periodic or startup work runs once across replicas.
- A `needs_config` connector is never called (fail closed).
- Pre-release: no compatibility shims. Applied migrations stay immutable (this plan adds none).
- A new unit or container test file joins `packages/kernel/test/unit-tests.json` or `container-tests.json` in the same commit. Integration is the default. There are no fixed sleeps and no per-test timeouts.
- Run tests from the repo root: `pnpm exec vitest run <path>`. The local gate is `pnpm verify --fast` plus the touched tests. CI is the full gate.
- Commits use Conventional Commits, body lines ≤ 100 characters, and end with `Co-Authored-By: Capybara <noreply@capybarahq.com>`. A published package change gets a changeset (`@capybara-hq/kernel` for phase 2; images-only changes get `@capybara-hq/capybara`).
- Visual baselines are rendered only by the `visual-update` workflow. Locally, run the visual spec only to see it fail or pass against the current baseline.

## Review Focus

1. **An org with 30 marketplace sources.** The market filter is one 来源 select with a filter input. No row of tabs overflows (Task 1 test: 30 options → one combobox, no tablist).
2. **A member opening the connectors page while a template connector is `needs_config`.** They see 待管理员配置 and no button. An admin sees 配置 (Task 13 test, both roles on one fixture).
3. **A tool call to a `needs_config` connector of each kind (missing OAuth client; missing org static credential).** It never reaches the server, and the model gets the 待配置 text (Task 8 tests, a fake server asserting zero requests).
4. **Upgrading a plugin that adds a template while 3 orgs have the plugin on.** Each org gets one connector, with no outbound call inside the transaction. The preview lists the 3 orgs (Task 11 test: counts, plus the fake MCP server sees requests only after commit).
5. **A kernel restart on 2 replicas with a plugin installed before phase 2 that lacks a template connector.** Exactly one connector is created (Task 12 dual-replica container test).

## Wave plan (for wave-planned-subagent-development)

| Task | Depends on | Files / areas | Risk | Wave | Review |
|---|---|---|---|---|---|
| 1 | — | design list-page, select, /dev/ui list | normal | 1 | batched |
| 2 | — | design card-grid | normal | 1 | batched |
| 5 | — | web review body, CatalogParts, PlatformUpdateDialog | normal | 1 | batched |
| 3 | 1, 2 | web admin plugins + market, PluginsHead | normal | 2 | batched |
| 4 | 1, 2 | web org plugins + market, PluginSwitch | normal | 2 | batched |
| 6 | 2 | web sources page | normal | 2 | batched |
| 7 | 5 | web import wizard, org upload dialog | normal | 3 | batched |
| 8 | — | kernel connector setup state, pipeline | high | 4 | alone, most capable |
| 9 | 8 | kernel connectors create, outbox job | high | 5 | alone, most capable |
| 10 | 8, 9 | kernel install, scope sync, org catalog | high | 6 | alone, most capable |
| 11 | 9, 10 | kernel upgrade + web preview body | high | 7 | alone, most capable |
| 12 | 10 | kernel reconciliation at startup | high | 7 | alone, most capable |
| 13 | 8, 10 | web enable page, connectors page, extensions, agent | normal | 8 | batched |
| 14 | 13 | spec amendments, AGENTS.md | normal | 8 | batched |

Tasks 3 and 4 both touch `catalog-pages.test.tsx`. Give each its own `describe` block and merge in task order. Wave 1 runs as soon as the plan is approved. Phase 2 starts only after phase 1 is merged (a separate PR per phase).

---

## Phase 1: web

### Task 1: ListPage scope overflow becomes a select

**Files:**
- Modify: `packages/design/src/templates/list-page.tsx` (`ListScope` :72, wide scope :290–319, `holdsViewChoice` / `assertScope` :86–103)
- Modify: `packages/design/test/list-page-compact.test.tsx` (case ">5 options is a secondary Tabs row" :347)
- Modify: `apps/web/src/dev/catalog/templates/list.tsx` (add a scope case)
- Modify: `apps/web/visual/catalog.spec.ts` (shot for the new case)

**Interfaces:**
- Produces: unchanged `ListScope` type. Behavior: options > `SEGMENTED_MAX` (5) without avatars render one `Select` labeled `scope.label`, its options in the given order. It is `data-part="list-scope"`, and its filter input comes from `Select` past 10 options.

- [ ] **Step 1: Write the failing tests** in `list-page-compact.test.tsx`. Replace the :347 case.

```tsx
it("more than 5 options without avatars render one select, not a tab row", () => {
  renderListPage({ scope: scopeWith(30) }); // fixture helper: options s1..s30, value "all"
  expect(screen.queryByRole("tablist")).toBeNull();
  const box = screen.getByRole("combobox", { name: "来源" });
  expect(box).toHaveTextContent("全部来源");
});
it("5 options stay a segmented control", () => {
  renderListPage({ scope: scopeWith(5) });
  expect(screen.getByRole("radiogroup")).toBeInTheDocument();
});
it("choosing in the select calls onChange with the option value", async () => {
  const onChange = vi.fn();
  renderListPage({ scope: { ...scopeWith(30), onChange } });
  await userEvent.click(screen.getByRole("combobox", { name: "来源" }));
  await userEvent.click(screen.getByRole("option", { name: "s7" }));
  expect(onChange).toHaveBeenCalledWith("s7");
});
```

The avatars case (:360) stays as is.

- [ ] **Step 2:** Run `pnpm exec vitest run packages/design/test/list-page-compact.test.tsx`. Expected: the 3 new cases FAIL.
- [ ] **Step 3:** Implement. Replace the `<Tabs>` fallback with `Select`. Remove the Tabs references in `holdsViewChoice` / `assertScope` that only existed for the fallback. Below 600px, chips stay as today.
- [ ] **Step 4:** Add a `/dev/ui` list case with a 12-option scope (`ListTemplate` gets a `scope` demo), and add a visual shot `templates-list-scope-select` to `catalog.spec.ts`. The baseline comes from the `visual-update` workflow.
- [ ] **Step 5:** Run the Step 2 command, then `pnpm exec vitest run packages/design apps/web/test/catalog-pages.test.tsx -t "scope"`. Expected: PASS.
- [ ] **Step 6: Commit** `feat(design): list scope above five options is one select`.

### Task 2: ObjectCard gains row facts (chips, busy, mono title)

**Files:**
- Modify: `packages/design/src/display/card-grid.tsx` (`ObjectCardLoaded` :42, `ObjectCard` :426)
- Test: `packages/design/test/card-grid.test.tsx`, `card-grid-compact.test.tsx`
- Modify: `apps/web/src/dev/catalog/templates/card-grid-blocks.tsx` (one card with chips and busy)

**Interfaces:**
- Produces: `ObjectCardLoaded` gains `chips?: readonly ReactNode[]` (badges after the title, the same contract as `ObjectRow.chips`), `mono?: boolean` (title in the mono face, as `ObjectRow.mono`), and `busy?: boolean` (the primary action shows loading and the card is `aria-busy`).

- [ ] **Step 1: Write the failing tests.**

```tsx
it("renders chips after the title", () => {
  render(<ObjectCard title="GitHub" chips={[<Badge key="b">内置</Badge>]} />);
  expect(within(screen.getByRole("article")).getByText("内置")).toBeInTheDocument();
});
it("busy marks the card and its primary action", () => {
  render(<ObjectCard title="x" primary={{ label: "启用", onSelect: () => {} }} busy />);
  expect(screen.getByRole("article")).toHaveAttribute("aria-busy", "true");
});
```

- [ ] **Step 2:** Run `pnpm exec vitest run packages/design/test/card-grid.test.tsx`. Expected: FAIL.
- [ ] **Step 3:** Implement in `card-grid.tsx`. Chips sit in the title line and wrap. Busy reuses the `loading` of `ObjectCardAction`.
- [ ] **Step 4:** Run the Step 2 command plus `card-grid-compact.test.tsx`. Expected: PASS. Add the `/dev/ui` block.
- [ ] **Step 5: Commit** `feat(design): object cards carry chips, a mono title and a busy state`.

### Task 3: Platform 已安装 and 市场 as cards; 市场源 next to the filter

**Files:**
- Modify: `apps/web/src/app/(app)/admin/plugins/view.tsx` (ListPage :69, :159; ObjectRow :192–226)
- Modify: `apps/web/src/app/(app)/admin/plugins/market/view.tsx` (ListPage :338, scope :349–361, ObjectRow :369)
- Modify: `apps/web/src/components/PluginsHead.tsx` (`usePluginsHead` :36, action :45–49)
- Modify: `apps/web/messages/{zh,en}.json` (`catalog.admin.actions.sources`: 市场源 / Sources; remove `addSource` if it becomes unused)
- Test: `apps/web/test/catalog-pages.test.tsx` (shared head :2572, /admin/plugins :2669, market scope :3359)

**Interfaces:**
- Consumes: Task 1 select overflow, Task 2 `chips` / `mono` / `busy`.
- Produces: none for other tasks.

- [ ] **Step 1: Write the failing tests.**

```tsx
it("installed plugins render as cards with the same facts", async () => {
  await renderRoute("/admin/plugins", fixtures.installed);
  const card = screen.getByRole("article", { name: /Anthropic/ });
  expect(within(card).getByText("v0.1.0-rc.10")).toBeInTheDocument();
  expect(within(card).getByText("运行中")).toBeInTheDocument();
});
it("the head has no 添加市场源; the market filter row links 市场源", async () => {
  await renderRoute("/admin/plugins/market", fixtures.market);
  expect(screen.queryByRole("link", { name: "添加市场源" })).toBeNull();
  expect(screen.getByRole("link", { name: "市场源" })).toHaveAttribute("href", "/admin/plugins/sources");
});
```

- [ ] **Step 2:** Run `pnpm exec vitest run apps/web/test/catalog-pages.test.tsx -t "admin plugins"`. Expected: FAIL.
- [ ] **Step 3:** Implement.
  - Switch both pages to `variant="cards"` and map each ObjectRow prop to its ObjectCard slot: `action` becomes `primary`, `menu` becomes `menu`, and `mark` becomes `avatar`.
  - Remove the head action. Put the 市场源 link in ListPage's filter-row action slot (the `actions` / `filters` area the template offers).
  - The 市场源 link shows on the market tab only, for super admins.
- [ ] **Step 4:** Run the Step 2 command, then the whole file. Expected: PASS. Update the assertions that looked for rows.
- [ ] **Step 5: Commit** `feat(web): platform plugins and market as cards, sources beside the filter`.

### Task 4: Org 插件 and 市场 as cards; market source filter; no configure action

**Files:**
- Modify: `apps/web/src/app/(app)/plugins/view.tsx` (ListPage :170, ObjectRow :181, `Market` :231, ListPage :331, ObjectRow :359)
- Modify: `apps/web/src/components/PluginSwitch.tsx` (`PluginAction` :96, `configureWhenNeeded` :326, on-state `configure` :393–402)
- Modify: `apps/web/src/lib/query/catalog.ts` (`orgMarketplaceEntriesQuery(orgId, q, sourceId)` :70, already takes `sourceId`)
- Test: `apps/web/test/catalog-pages.test.tsx` (/plugins :232–918; :304 配置 to Sheet), `catalog-scope.test.tsx`

**Interfaces:**
- Consumes: Tasks 1 and 2.
- Produces: `PluginAction["id"]` loses `"configure"`. `"connectors"` (完成设置) stays until Task 13.

- [ ] **Step 1: Write the failing tests.**

```tsx
it("an on plugin with overridable config shows only 禁用 and its menu, no 组织配置", async () => {
  await renderRoute("/plugins", fixtures.orgOnConfigurable);
  const card = screen.getByRole("article", { name: /Anthropic/ });
  expect(within(card).queryByRole("link", { name: "组织配置" })).toBeNull();
});
it("the org market filters by source derived from entries", async () => {
  await renderRoute("/plugins?tab=market", fixtures.orgMarketTwoSources);
  await userEvent.click(screen.getByRole("radio", { name: "Superpowers (obra)" }));
  expect(lastQuery("orgMarketplaceEntries")).toMatchObject({ sourceId: "src-obra" });
});
```

Delete the :304 case ("配置 opens the extension Sheet").

- [ ] **Step 2:** Run `pnpm exec vitest run apps/web/test/catalog-pages.test.tsx -t "/plugins"`. Expected: FAIL.
- [ ] **Step 3:** Implement.
  - Cards as in Task 3.
  - Source options: distinct `{sourceId, sourceName}` from the unfiltered entries, sorted by name, with `全部来源` first. Keep the unfiltered query as the option source, and use the filtered query for the grid.
  - Drop `configure` and `configureWhenNeeded`.
- [ ] **Step 4:** Run the Step 2 command, then `catalog-scope.test.tsx`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): org plugins and market as cards; plugins carry no configure action`.

### Task 5: Review body subtractions

**Files:**
- Modify: `apps/web/src/components/PluginReviewBody.tsx` (facts :63–130, `ExtensionReview` :266, sections :157–238)
- Modify: `apps/web/src/components/CatalogParts.tsx` (`ComponentSection` :53, `TranslationReportView` :88)
- Modify: `apps/web/src/components/PlatformUpdateDialog.tsx` (`PlatformUpdatePreviewBody` :180, same header and chip style)
- Modify: `apps/web/messages/{zh,en}.json` (`catalog.admin.review.*`: `sensitiveCount`, `fullDescription`, `build`, `unverified`, `noneOf`, `configAfterInstall`, `needsOAuthClient`, `needsOrgCredential`, `endpointUnchecked`, `translationSummary`)
- Test: `apps/web/test/plugin-review-provenance.test.tsx`, `catalog-pages.test.tsx` (import :1076, :1337), `org-plugin-upload.test.tsx`

**Interfaces:**
- Produces: `templateNeed(t: { auth: Record<string, unknown> }): "client" | "credential" | undefined` exported from `apps/web/src/lib/catalog.ts`. It replaces `needsClient` (`CatalogInstallWizard.tsx:88`) and the local `templateNeed` (:590). Task 13 consumes it.
  - `"client"`: `auth.type === "oauth_client"`, or `oauth_code` with `client === "manual"`.
  - `"credential"`: static auth with `ownership === "org"`.
  - Otherwise `undefined`.

- [ ] **Step 1: Write the failing tests** (§5.4 items 1–9) in `plugin-review-provenance.test.tsx`.

```tsx
it("header shows the version chip and one sensitive total", () => {
  render(<PluginReviewBody review={fixtures.deviceE2b} />);
  expect(screen.getByText("安装 v0.1.0-rc.28")).toBeInTheDocument();
  expect(screen.getByText("2 项敏感")).toBeInTheDocument();
});
it("config fields are chips without the deployment: prefix; secrets get a lock and no 密钥 section", () => {
  render(<PluginReviewBody review={fixtures.deviceE2b} />);
  expect(screen.getByText("apiKey")).toBeInTheDocument();
  expect(screen.queryByText(/deployment:/)).toBeNull();
  expect(screen.queryByRole("heading", { name: "密钥" })).toBeNull();
});
it("empty sections collapse into one line", () => {
  render(<PluginReviewBody review={fixtures.deviceE2b} />);
  expect(screen.queryByRole("heading", { name: "技能" })).toBeNull();
  expect(screen.getByText("没有技能、连接器模板、智能体模板和依赖。")).toBeInTheDocument();
});
it("connector templates show a requirement tag per template, no checkbox", () => {
  render(<PluginReviewBody review={fixtures.atlassian} />);
  expect(screen.getAllByText("需要 OAuth 客户端")).toHaveLength(3);
  expect(screen.queryByRole("checkbox")).toBeNull();
});
it("the translation report is a one-line summary with warnings shown", () => {
  render(<PluginReviewBody review={fixtures.claudeSessionDriver} />);
  expect(screen.getByText("导入 1 · 转换 0 · 需要填写 0 · 忽略 5 · 警告 1")).toBeInTheDocument();
  expect(screen.getByText(/SessionStart/)).toBeVisible();
});
```

Add a `templateNeed` table test in `apps/web/test/catalog-template-need.test.ts`, with one case per auth type.

- [ ] **Step 2:** Run `pnpm exec vitest run apps/web/test/plugin-review-provenance.test.tsx apps/web/test/catalog-template-need.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement with design components only (`Badge`, `KeyValue`, `ItemList`, `Disclosure`, `Callout`).
  - The description keeps its first sentence: split on the first `。` or `. `. The rest goes in a `Disclosure` labeled 完整说明.
  - The org enable caller passes `audience="org"`, which hides provenance and license (§5.4 last paragraph).
  - Restyle `PlatformUpdatePreviewBody` with the same header (`rc.2 → rc.4`) and per-component change chips.
- [ ] **Step 4:** Run the Step 2 command, then `catalog-pages.test.tsx -t "import"` and `org-plugin-upload.test.tsx`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): plugin review shows contents and effect with less text`.

### Task 6: Sources page as cards with a dialog

**Files:**
- Modify: `apps/web/src/app/(app)/admin/plugins/sources/view.tsx` (`Sources` :131, `SourceEditor` :265, `AddSource` :500)
- Create: `apps/web/src/components/MarketplaceSourceDialog.tsx`
- Modify: `apps/web/messages/{zh,en}.json` (`catalog.admin.marketplaces.*`: `add`, `edit`, `officialNote`)
- Test: `apps/web/test/catalog-pages.test.tsx` (sources :2423, :2473)

**Interfaces:**
- Consumes: Task 2 cards.
- Produces: `MarketplaceSourceDialog({ open, onClose, source?: MarketplaceSource })`. Add mode when `source` is undefined, edit mode otherwise. Token is blank-keeps.

- [ ] **Step 1: Write the failing tests.**

```tsx
it("sources render as cards with state and refresh", async () => {
  await renderRoute("/admin/plugins/sources", fixtures.twoSources);
  const card = screen.getByRole("article", { name: /Superpowers \(obra\)/ });
  expect(within(card).getByText(/正常（10 个条目/)).toBeInTheDocument();
  await userEvent.click(within(card).getByRole("button", { name: "立即刷新" }));
  expect(lastMutation("refreshMarketplace")).toMatchObject({ id: "src-obra" });
});
it("the official card has no edit or delete", async () => {
  await renderRoute("/admin/plugins/sources", fixtures.twoSources);
  const card = screen.getByRole("article", { name: /Capybara/ });
  await userEvent.click(within(card).getByRole("button", { name: "更多" }));
  expect(screen.queryByRole("menuitem", { name: "编辑" })).toBeNull();
});
it("编辑 opens the dialog prefilled; saving with an empty token keeps it", async () => {
  /* open menu → 编辑 → dialog shows name/url; save → PATCH body has no token */
});
it("添加市场源 opens an empty dialog and POSTs", async () => { /* … */ });
```

- [ ] **Step 2:** Run `pnpm exec vitest run apps/web/test/catalog-pages.test.tsx -t "sources"`. Expected: FAIL.
- [ ] **Step 3:** Implement.
  - Use `ListPage variant="cards"`, with the header action 添加市场源 opening the dialog.
  - Move the fields of `SourceEditor` / `AddSource` into the dialog. Delete stays a `DangerConfirm` from the card menu, and the on/off switch is on the card.
- [ ] **Step 4:** Run the Step 2 command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): marketplace sources as cards, add and edit in a dialog`.

### Task 7: Platform install in two steps

**Files:**
- Modify: `apps/web/src/app/(app)/admin/plugins/import/view.tsx` (steps :565, confirm step :703–817, update step :654)
- Modify: `apps/web/src/components/OrgPluginUploadDialog.tsx` (:250, :258)
- Test: `apps/web/test/catalog-pages.test.tsx` (import :1076, :1337), `org-plugin-upload.test.tsx`

**Interfaces:**
- Consumes: Task 5 review body.

- [ ] **Step 1: Write the failing test.**

```tsx
it("install has two steps; scope and the sensitive ack sit under the review", async () => {
  await renderImportAt("review", fixtures.deviceE2bReview);
  expect(screen.getAllByRole("listitem", { name: /步骤/ })).toHaveLength(2);
  expect(screen.getByRole("radiogroup", { name: "可见范围" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "安装" })).toBeDisabled(); // until the sensitive ack
});
```

- [ ] **Step 2:** Run `pnpm exec vitest run apps/web/test/catalog-pages.test.tsx -t "import"`. Expected: FAIL.
- [ ] **Step 3:** Implement. Move the scope fields and the ack into the review step's footer area. The update path keeps its preview as the second step. The confirm request is unchanged (`{reviewHash, diffHash}`).
- [ ] **Step 4:** Run the Step 2 command, then `org-plugin-upload.test.tsx`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): plugin install is choose, then review and confirm`.

**Phase 1 exit:** run `pnpm verify --fast` and the touched web and design tests, then open the phase 1 PR (`Refs #807`).

---

## Phase 2: kernel and web

### Task 8: Derived connector setup state; the pipeline fails closed

**Files:**
- Create: `packages/kernel/src/tools/connector-setup.ts`
- Modify: `packages/kernel/src/tools/connectors.service.ts` (`ConnectorSummary` :130, `ConnectorDetail` :170, `summary()` :1227, `detail()` :1249)
- Modify: `packages/kernel/src/tools/credentials.ts` (presence helper next to `status` :452)
- Modify: `packages/kernel/src/tools/pipeline.ts` (`orgMissingText` :326, check :3309–3323)
- Modify: `apps/web/src/lib/connectors.ts` (`ConnectorSummary` :99 gains `setup`)
- Test: `packages/kernel/test/tools/connector-setup.test.ts` (unit, add it to `unit-tests.json`), `test/tools/pipeline.test.ts` (:1388), `test/tools/connectors.http.test.ts`

**Interfaces:**
- Produces:
  - `type SetupNeed = "client" | "credential"`. `setupNeed(auth: ConnectorAuth): SetupNeed | undefined` applies the same rule as the web `templateNeed` (Task 5).
  - `type ConnectorSetup = "ready" | "needs_config"`.
  - `Credentials.hasOrgInput(orgId, connectorId, need: SetupNeed): Promise<boolean>`. It reads the key presence without decrypting.
  - `ConnectorsService.setupOf(orgId, row): Promise<ConnectorSetup>`.
  - `ConnectorSummary.setup` and `ConnectorDetail.setup`.
  - The `missingTemplateInput` (`plugin-install.ts:544`) body is replaced by a call to `setupNeed`. Its signature stays until Task 10.

- [ ] **Step 1: Write the failing tests.**

```ts
// connector-setup.test.ts (unit)
it.each([
  [{ type: "oauth_client" }, "client"],
  [{ type: "oauth_code", client: "manual" }, "client"],
  [{ type: "oauth_code", client: "dcr", discovery: "mcp" }, undefined],
  [{ type: "bearer", ownership: "org" }, "credential"],
  [{ type: "bearer", ownership: "personal" }, undefined],
  [{ type: "none" }, undefined],
])("setupNeed(%j) = %s", (auth, need) => expect(setupNeed(auth as ConnectorAuth)).toBe(need));
```

```ts
// pipeline.test.ts
it("a needs_config connector (no OAuth client) is never called; the model gets the 待配置 text", async () => {
  const server = await startFakeMcpServer();
  const c = await seedConnector(app, { auth: { type: "oauth_client" }, client: null, url: server.url });
  const r = await callTool(app, c, "search");
  expect(server.requests).toHaveLength(0);
  expect(r.text).toMatch(/needs to be configured by an organization admin/);
});
it("a needs_config static org connector (no credential) is never called", async () => { /* same, bearer org */ });
it("removing the org credential turns setup back to needs_config", async () => {
  /* create with credential → summary.setup "ready"; DELETE credential → "needs_config" */
});
```

- [ ] **Step 2:** Run `pnpm exec vitest run packages/kernel/test/tools/connector-setup.test.ts packages/kernel/test/tools/pipeline.test.ts -t "needs_config"`. Expected: FAIL.
- [ ] **Step 3:** Implement.
  - `setupOf` returns `needs_config` iff `setupNeed(auth)` is defined and `hasOrgInput` is false.
  - The pipeline check (`missing()`) consults it before `getAuth` and fails closed.
  - Reword `orgMissingText` to name the configure step: "This connector needs to be configured by an organization admin before it can be used."
- [ ] **Step 4:** Run the Step 2 command, then `connectors.http.test.ts` and `credentials.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(kernel): connectors report a derived setup state; unconfigured ones are never called`.

### Task 9: Create without listing; tool list through the outbox

**Files:**
- Modify: `packages/kernel/src/tools/connectors.service.ts` (`CreateConnectorInput` :176, `create` :714, `createIn` :773, `setCredential` :2036, `storeOAuthClient` :2171, `refresh` :1872)
- Modify: `packages/kernel/src/infra/outbox/registry.ts` (`OUTBOX_JOBS` :45)
- Create: `packages/kernel/src/tools/connector-tools.processor.ts` (a `WorkerHost` + `runJob`, provided only under `WorkerModule`)
- Test: `packages/kernel/test/tools/connector-tools-deferred.test.ts`

**Interfaces:**
- Consumes: Task 8 `setupOf`.
- Produces:
  - `ConnectorsService.createDeferredIn(orgId, actor | null, input: CreateConnectorInput): Promise<string>` (connector id). It is `@Transactional`, makes no network call, and writes the row with an empty tool list. When `setupOf` is `ready` and ownership is not personal, it adds outbox job `connector-tools-list`.
  - The job is queue `cap-connector-tools`, name `connector-tools-list`, `jobId = connector-tools-<connectorId>-<trigger>-<seq>`, with `trigger ∈ created | configured | connected`.
  - The job data is `{ orgId, connectorId, accountId? }`. The consumer calls the existing `refresh` path. It is idempotent: listing twice stores the same tools.
  - `setCredential` (org) and `storeOAuthClient` enqueue the job with trigger `configured` when the connector turns `ready`. A personal connector's first member credential enqueues `connected` with that `accountId`.

- [ ] **Step 1: Write the failing tests.**

```ts
it("createDeferredIn writes the row with no outbound call inside the transaction", async () => {
  const server = await startFakeMcpServer();
  const id = await app.get(ConnectorsService).createDeferredIn(org, null, staticOrgInput(server.url, "tok"));
  expect(server.requests).toHaveLength(0);           // nothing before commit
  await waitForOutboxDrain(app);
  expect(await toolsOf(app, id)).toEqual(["search"]); // listed by the job
});
it("a needs_config connector gets its tools after the admin saves the client", async () => { /* … */ });
it("an endpoint that keeps failing leaves the connector ready with an error, not needs_config", async () => { /* … */ });
```

- [ ] **Step 2:** Run `pnpm exec vitest run packages/kernel/test/tools/connector-tools-deferred.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement. Register the job (`queue`, `idempotent: true`, `processedIn`, `opts`) so that `tools/checks/src/outbox-registry.ts` passes. `create` (the connectors page path) is unchanged.
- [ ] **Step 4:** Run the Step 2 command, then `pnpm check` (outbox registry check) and `connectors.http.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(kernel): connectors can be created without listing tools; the list follows through the outbox`.

### Task 10: Install, enable and scope sync without input

**Files:**
- Modify: `packages/kernel/src/catalog/plugin-install.ts` (`ConnectorInstallInput` :100, `PluginInstallInput` :114, `NeedsOrgInput` :219, `systemNeedsInput` :227, `missingTemplateInput` :544, `plan` :768–846, `planConnector` :982–1027, `execute` :1218–1260, `missingConnectors` :2226, `configureConnectors` :2334, `addTemplateConnector` :2424)
- Modify: `packages/kernel/src/catalog/org-catalog.schemas.ts` (`OrgPluginInstallBody.connectors` :90, `OrgPluginConnectorsSchema` :99, `OrgTemplateConnectorSchema` :109, route :186)
- Modify: `packages/kernel/src/catalog/org-catalog.service.ts` (needs_config :245–263, `detail` :342–345)
- Modify: `packages/kernel/src/catalog/scope-sync.ts` (`ScopeSyncResult` :92, `needsInput` :384, :465, `manifestNeedsInput` :490)
- Modify: the Platform operations and exclusions for the removed `POST …/catalog/:itemId/connectors` route (`pnpm check:platform-ops`, `platform-parity.test.ts`)
- Test: `test/catalog/plugin-install.test.ts`, `scope-sync.test.ts` (:221), `component-scope.test.ts` (:918), `org.test.ts`, `agents/pending-connectors.test.ts`

**Interfaces:**
- Consumes: Task 8 `setupNeed` / `setupOf`, Task 9 `createDeferredIn`.
- Produces:
  - `PluginInstallInput` without `connectors`.
  - `planConnector(actor, plugin, ct, at, approvedBy): CreateConnectorInput`, never refusing for missing input.
  - `execute` creates template connectors through `createDeferredIn` and reuses live ones (`liveTemplateConnector`).
  - The org plugin state `needs_config` only for an invalid effective extension config.
  - `ScopeSyncResult` without `"needs_config"`.
  - `systemNeedsInput`, `NeedsOrgInput`, `configureConnectors` and `missingTemplateInput` are deleted.

- [ ] **Step 1: Write the failing tests.**

```ts
it("enabling Google creates all 7 template connectors; OAuth-client ones are needs_config", async () => {
  await enable(app, org, "google"); // body has no connectors field
  const cs = await listConnectors(app, org);
  expect(cs).toHaveLength(7);
  expect(cs.every((c) => c.setup === "needs_config")).toBe(true);
});
it("a dcr template connector is ready and gets its tools after commit", async () => { /* jira-like */ });
it("a default-off template creates no connector", async () => { /* … */ });
it("scope sync installs an all-scoped plugin with templates into every org", async () => {
  // replaces scope-sync.test.ts:221 needs_config expectation
});
it("the install body rejects a connectors field", async () => {
  expect((await post(app, enableUrl, { connectors: {} })).statusCode).toBe(400);
});
```

- [ ] **Step 2:** Run `pnpm exec vitest run packages/kernel/test/catalog/plugin-install.test.ts packages/kernel/test/catalog/scope-sync.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement. Remove the route and its Platform operation together. Keep the agent pending-entry path (P4-6/P4-7) for connectors that do not exist at all.
- [ ] **Step 4:** Run the Step 2 command, then `component-scope.test.ts`, `org.test.ts`, `pending-connectors.test.ts`, `scope-sync.dual.test.ts` and `pnpm check:platform-ops`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(kernel): install, enable and scope sync create template connectors without input`, with a changeset (`@capybara-hq/kernel`: patch).

### Task 11: Upgrade creates connectors and previews its effect

**Files:**
- Modify: `packages/kernel/src/catalog/plugin-upgrade.ts` (`PlatformUpdateConnectorOrg` :112, `PlatformUpdatePreview` :139, fan-out :914–917, `prepare` :1000–1028, `diff` :1039, per-org :1506–1561, `diffHash` :1566–1590)
- Modify: `apps/web/src/lib/catalog.ts` (mirror :1110–1160), `apps/web/src/components/PlatformUpdateDialog.tsx` (notes :313–332)
- Modify: `apps/web/messages/{zh,en}.json` (`catalog.update.createdNote`, `catalog.update.scopeInstallNote`)
- Test: `test/catalog/platform-update.test.ts` (:362, :486), `apps/web/test/appearance.test.tsx`

**Interfaces:**
- Consumes: Task 9 `createDeferredIn`, Task 10 template rule.
- Produces:
  - `PlatformUpdateConnectorOrg` gains `created: { templateId: string; setup: ConnectorSetup }[]`.
  - `PlatformUpdatePreview` gains `scopeInstalls: { orgId: string; orgName: string }[]`.
  - Both are included in `diffHash`.

- [ ] **Step 1: Write the failing tests.**

```ts
it("an upgrade that adds a template creates one connector per org with the plugin on", async () => {
  const orgs = await seedOrgsWithPluginOn(app, 3);
  const server = await startFakeMcpServer();
  const p = await preview(app, "demo", "rc.2");
  expect(p.connectorOrgs.map((o) => o.created.length)).toEqual([1, 1, 1]);
  await confirmUpdate(app, p);
  for (const o of orgs) expect(await templateConnectors(app, o, "new-tpl")).toHaveLength(1);
  expect(server.requestsBeforeCommit).toBe(0);
});
it("a credential-shape change leaves the connectors needs_config", async () => { /* … */ });
it("the preview names orgs where scope sync will now install", async () => { /* … */ });
```

- [ ] **Step 2:** Run `pnpm exec vitest run packages/kernel/test/catalog/platform-update.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement. Create the connectors inside the existing upgrade transaction and locks, through `createDeferredIn`. The web notes render `created` and `scopeInstalls`.
- [ ] **Step 4:** Run the Step 2 command, then `apps/web/test/appearance.test.tsx`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(kernel): upgrades create added template connectors and preview them per org`.

### Task 12: One-off reconciliation for plugins waiting before phase 2

**Files:**
- Create: `packages/kernel/src/catalog/template-connector-reconcile.ts`
- Modify: `packages/kernel/src/lifecycle/kernel-lifecycle.ts` (bootstrap under `lock:bootstrap`, :203 / :291)
- Test: `packages/kernel/test/catalog/template-connector-reconcile.dual.test.ts` (container, add it to `container-tests.json`)

**Interfaces:**
- Consumes: Task 10 `execute` template rule, Task 9 `createDeferredIn`.
- Produces: `TemplateConnectorReconciler.run(): Promise<{ created: number }>`. For every installed org plugin, it creates each template connector that is on and has no live connector (the old `missingConnectors` set), under the §5.2.2 rule.
  - It is called once at startup inside the existing bootstrap lock, so only one replica runs it.
  - It is idempotent: a second run creates nothing.

- [ ] **Step 1: Write the failing test.**

```ts
it("two replicas starting with a plugin missing a template connector create exactly one", async () => {
  await seedInstalledWithoutTemplateConnector(db, org, "google", "gmail");
  const [a, b] = await startDualKernels();
  expect(await templateConnectors(a, org, "gmail")).toHaveLength(1);
  await restart(b);
  expect(await templateConnectors(a, org, "gmail")).toHaveLength(1);
});
```

- [ ] **Step 2:** Run `pnpm exec vitest run --project container packages/kernel/test/catalog/template-connector-reconcile.dual.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement. Wire it into the bootstrap step with a log line giving the created count.
- [ ] **Step 4:** Run the Step 2 command, then `test/extensions/bootstrap.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(kernel): reconcile template connectors once at startup`.

### Task 13: Web: enable is one review page; 待配置 on the owning pages

**Files:**
- Modify: `apps/web/src/components/CatalogInstallWizard.tsx` (remove `ChooseTemplates` :605, `TemplateStep`'s `credentialsOnly` :650, the template steps in `Wizard` :314, `missingInput` :171, `connectorInput` :189). The enable flow becomes `WizardPage` with one review step, or a `FormPage` review with 启用.
- Delete: `apps/web/src/app/(app)/plugins/[itemId]/connectors/` (page and view)
- Modify: `apps/web/src/components/PluginSwitch.tsx` (drop the `connectors` action and the needs_config 完成设置 branch :356–377)
- Modify: `apps/web/src/lib/catalog.ts` (`installTemplates` :927, `keptTemplates` :932, `ConnectorInstallInput` :969, `createPluginConnectors` :1562: remove)
- Modify: `apps/web/src/app/(app)/connectors/view.tsx` (`connectorCard` :177: `setup === "needs_config"` → admin 待配置 + 配置 (edit form with the template's setup guide), member 待管理员配置; `templateCard` :204 keeps 启用 for off templates only)
- Modify: `apps/web/src/app/(app)/extensions/view.tsx`, `admin/extensions/view.tsx`, `components/useOrgExtensionActions.tsx` (:140–177): a needs-config row shows 待配置 + 配置 for admins and 待管理员配置 for members.
- Modify: the agent page connector list (the component rendering agent connectors) to show 待配置 for `setup === "needs_config"`.
- Modify: `apps/web/messages/{zh,en}.json` (`connectors.setup.needsConfig` 待配置, `connectors.setup.needsAdmin` 待管理员配置; remove `catalog.org.connectors.*`)
- Test: `catalog-pages.test.tsx` (enable wizard :1776–2274, template rules :3507, :3533), `connectors.test.tsx` (:142), `connector-setup-guide.test.tsx`, `agent-pending-connectors.test.tsx`

**Interfaces:**
- Consumes: Task 5 `templateNeed` and review body; Task 8 `ConnectorSummary.setup`; Task 10's request body without `connectors`.

- [ ] **Step 1: Write the failing tests.**

```tsx
it("enabling Google is one review page with 启用 and no input", async () => {
  await renderRoute("/plugins/google/enable", fixtures.googleItem);
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(screen.queryByRole("checkbox")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "启用" }));
  expect(lastMutationBody("installOrgPlugin")).not.toHaveProperty("connectors");
});
it.each([["admin", "配置"], ["member", null]])("a needs_config connector card for %s", async (role, button) => {
  await renderRoute("/connectors", fixtures.googleNeedsConfig, { role });
  const card = screen.getByRole("article", { name: /Google 云端硬盘/ });
  if (button) expect(within(card).getByRole("button", { name: button })).toBeInTheDocument();
  else {
    expect(within(card).queryByRole("button")).toBeNull();
    expect(within(card).getByText("待管理员配置")).toBeInTheDocument();
  }
});
it("配置 opens the connector form with the template's setup guide", async () => { /* … */ });
```

- [ ] **Step 2:** Run `pnpm exec vitest run apps/web/test/catalog-pages.test.tsx apps/web/test/connectors.test.tsx -t "needs_config|enable"`. Expected: FAIL.
- [ ] **Step 3:** Implement. `TemplateStep` stays for `PendingConnectorDialog`. `guide_ack` is sent when the 配置 form saves.
- [ ] **Step 4:** Run the Step 2 command, then `connector-setup-guide.test.tsx`, `agent-pending-connectors.test.tsx` and `pnpm check:web-ui`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): enable reviews only; connectors and extensions show 待配置 by role`.

### Task 14: Amend the specs and AGENTS.md

**Files:**
- Modify: `docs/superpowers/specs/2026-11-05-plugin-component-management-design.md` (§6 bullet :253, P2-9 :529, P2-10 :530, §17 :1015)
- Modify: `docs/superpowers/specs/2026-11-09-setup-guides-v2-design.md` (§9.3 :800)
- Modify: `docs/superpowers/specs/2026-11-09-connector-cards-and-member-policies-design.md` (§2 :24–26)
- Modify: `AGENTS.md` (Plugins and the catalog line, the sentence from the spec's "AGENTS.md rules touched")

- [ ] **Step 1:** At each amended section, add one line: `Amended by 2026-11-24-plugin-pages-redesign-design.md §<n>: <one-sentence new rule>.`
- [ ] **Step 2:** Add the AGENTS.md sentence verbatim from the spec, then run `pnpm check:agent-docs`. Expected: PASS.
- [ ] **Step 3: Commit** `docs: point the amended specs and AGENTS.md at the plugin pages redesign`.

**Phase 2 exit:** run `pnpm verify --fast` and the touched tests, then open the phase 2 PR with `Closes #807`. Tasks 8–12 are reviewed alone on the most capable model before the PR.
