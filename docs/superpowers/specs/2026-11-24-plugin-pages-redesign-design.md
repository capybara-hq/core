# Plugin pages: cards, and install, update and enable collect no configuration

Issue: [core#807](https://github.com/capybara-hq/core/issues/807). Amends the connector parts of
[plugin component management](2026-11-05-plugin-component-management-design.md) (§6, phase 2 rulings
P2-6, P2-9, P2-10, §17), [setup guides v2](2026-11-09-setup-guides-v2-design.md) §9.3 and
[connector cards and member policies](2026-11-09-connector-cards-and-member-policies-design.md) §2.
Everything there that this document does not change stays.

Inventory: core at `6882a49c6` (origin/main, 2026-11-24).

## 1. Why

The maintainer's feedback on the plugin pages (2026-11-24, with screenshots), in one line: **a plugin
is a package.** The plugin pages install, update, switch on and switch off packages. They do not
configure what is inside them.

Today they do both:

- The org plugins page shows an 组织配置 (org config) button. It links to the extensions page, so the
  plugin page is only a detour to configuration that lives somewhere else.
- When an org enables a plugin with connector templates, the enable wizard has one step per template.
  Each step asks for endpoint fields, credentials or an OAuth client id and secret. The kernel refuses
  the install (400) while any template that is on lacks that input (`missingTemplateInput`,
  `packages/kernel/src/catalog/plugin-install.ts`). A plugin scoped to every org
  (`all` / `named`) that has such a template cannot be installed by scope sync at all: it waits as
  `needs_config` (`scope-sync.ts:457-494`).
- The review pages are long text. Every config field is a line (`deployment:apiKey`, …), secrets are
  listed a second time, and empty sections each take a heading ("没有技能。" …).
- Lists are rows, while the connectors page is already cards. The marketplace sources page is one
  long form. Adding a source is a header button, away from the source filter it feeds.

What the person needs when installing, updating or enabling is narrower: **what is in the package,
and what this operation changes** (versions from → to, components added, removed or changed,
connectors that will need setup). Configuration happens afterwards, on the page that owns the thing:
extensions on the extensions page, connectors on the connectors page, devices on the devices page.

## 2. Decisions (maintainer, 2026-11-24)

1. Install, update and enable collect no configuration. They show the package's contents and the
   operation's effect, and the person confirms.
2. Enabling a plugin creates every connector template that is on as a connector in the org, right
   away. A connector that needs input shows 待配置 (needs config). One that needs none (for example
   an OAuth connector with dynamic client registration, such as Jira) works immediately.
3. On a page that shows a 待配置 item, an admin sees a 配置 (configure) button and a member sees the
   state text with no button. This applies to the same page for both roles.
4. The org plugins page has only enable and disable. No 组织配置 button. The platform plugins page
   likewise configures nothing.
5. The review page keeps today's sections and order and removes text (§5.4, mockup approved).
   Connector templates are listed the way the enable wizard's first step lists them today (icon,
   name, a 需要 OAuth 客户端 tag, description), without checkboxes.
6. The platform 已安装 and 市场 tabs, and the org 插件 and 市场 tabs, become cards.
7. The 添加市场源 header button becomes a 市场源 (sources) entry next to the source filter. The
   filter must work with about 30 sources.
8. The sources page becomes a list of cards. Add and edit are dialogs, and refresh is on each card.
9. The org market can be filtered by source.

## 3. Goals, non-goals, anti-goals

Goals:

- An admin installs, updates or enables any plugin in one pass, with no form to fill.
- After enabling, every component of the plugin is where it belongs and says whether it works.
- The review page answers "what is this, and what will change" at a glance.
- The plugin pages look like the connectors page (cards) and scale to many sources.

Non-goals:

- Changing how extension config, connector config or device config forms work on their own pages.
  They move nothing and gain only the 待配置 state where it is missing.
- Changing plugin scope (`all` / `optional` / `named`), the share gate, approval or the review hash.
  The platform still picks a scope at import (§5.3).
- New marketplace kinds or source settings.
- A member-to-admin request when a member hits an unconfigured org connector in a conversation. The
  tool error text stays as today (§5.2.4). A follow-up may add a request.

Anti-goals (a failure even if it technically works):

- Any input field on an install, update or enable page, including "optional" ones.
- A connector that silently does nothing. A connector without its input must say 待配置 everywhere it
  appears: the connectors page, an agent's connector list and the tool error.
- A member seeing a 配置 button they cannot use (roles everywhere: no refused actions shown).
- The review page losing information. Everything shown today stays reachable, folded if not central.

## 4. Current state the builder starts from

From an inventory of `origin/main` (2026-11-24):

- **Pages.** `admin/plugins`, `admin/plugins/market`, `plugins` (org) use `ListPage variant="objects"`
  with `ObjectRow`s. `admin/plugins/sources` is a `ListPage` whose body is two `FormSection`s of inline
  editors. `admin/plugins/import` is a `WizardPage` (source / review / confirm). The review body is
  `components/PluginReviewBody.tsx`. The org enable wizard is `components/CatalogInstallWizard.tsx`
  (`plugins/[itemId]/enable`). The org "complete setup" page is `plugins/[itemId]/connectors`.
- **Cards.** `ListPage variant="cards"` lays out `ObjectCard`s in a `CardGrid`
  (`packages/design/src/display/card-grid.tsx`). The connectors page uses it.
- **Source filter.** It is the `ListPage` `scope` prop. Up to `SEGMENTED_MAX = 5` options draw as a
  `Segmented`, and more draw as a secondary `Tabs` row (`templates/list-page.tsx:80, 291-319`). There
  is no searchable picker in that slot. `Select` (`controls/select.tsx`) adds a filter input past
  about ten options.
- **Connector rows.** `connectors.status` is `active | disabled` (`db/kernel-schema.ts:699-747`).
  There is no "needs config" state. Creating a connector lists its tools with a network call, for
  every auth type except `oauth_code` (`tools/connectors.service.ts`, `create`). So a connector cannot
  be created without its input today:
  - a static org connector fails with `CredentialMissing` during that listing (rethrown by
    `drift.ts`);
  - an `oauth_client` / manual `oauth_code` connector is refused up front (`checkCreateInput`).
- **Install input.** `planConnector` → `missingTemplateInput` refuses an install while an on template
  lacks input. `needs_config` is a plugin state derived from `missingConnectors` (templates on in the
  org with no live connector, ruling P2-10). `POST …/catalog/:itemId/connectors` fills them later
  (`configureConnectors`, `plugin-install.ts`).
- **Which templates need input.** The kernel rule (`missingTemplateInput`) and the web rule
  (`needsClient`, `CatalogInstallWizard.tsx`) agree:
  - `oauth_client`, and `oauth_code` with `client: "manual"`, need an OAuth client.
  - Static auth with `ownership: "org"` needs the org credential.
  - Static auth with personal ownership needs the installer's own credential today, because creating
    the connector lists its tools with it.
  - `none`, and `oauth_code` with `client: "dcr"` (MCP discovery), need nothing.
  - Endpoint fields never need input: presets must validate at import, and `editableEndpoint` is
    optional overrides only.
- **Upgrade.**
  - Changed templates fan out to the connectors made from them. Credentials are cleared when their
    shape changes (`credentialsReset`).
  - Added templates create no connector (P2-9). They are listed as `needsConfig`, and the plugin turns
    `needs_config`.
  - Removed templates leave their connectors as the org's own.
  - `credentialsOnly` on `TemplateStep` has no caller (left over from ruling F2).
- **Members.** A missing personal credential gives a `connection_required` connect card. A missing
  org credential gives the model an error text ("ask an organization admin to set it up"), with no
  request.

## 5. Design

### 5.1 Approaches considered

- **A. Every on template becomes a connector at enable; one that needs input waits as 待配置
  (picked by the maintainer).** Everything the plugin brings is visible in its place immediately.
  Connectors that need no input work right away. It costs a new connector state and kernel changes to
  install, upgrade and scope sync.
- **B. No connector until configured; templates show as "not set up" cards on the connectors page.**
  It needs no new connector state, but connectors that need nothing would still need an admin click.
  It also leaves the agent-template pending-entry path as the only way an agent refers to a missing
  connector. Rejected by the maintainer.
- **C. Keep the wizard and only make it optional (skip a template).** It keeps input on the enable
  page, which is decision 1's anti-goal.

How it is built: one design, delivered in two phases (§8). Phase 1 changes only the web: cards,
sources, the review page and the org buttons. Phase 2 makes the kernel change (the 待配置 connector
and no-input install / upgrade / scope sync) and removes the wizard steps. Phase 1 ships value
without waiting on the riskier kernel change. Phase 2 is reviewed on its own as a multi-org, data
change.

### 5.2 Connectors: the 待配置 state (phase 2)

#### 5.2.1 State (derived, not stored)

A connector's setup state is **derived**, not stored as a column:

- `needs_config` when its auth requires org-level input that is absent:
  - `oauth_client`, or `oauth_code` with `client: "manual"`, and no OAuth client stored;
  - static auth with `ownership: "org"`, and no org credential stored.
- `ready` otherwise.

Builder's call (the maintainer did not decide this). A derived state stays true on every path that
removes input: an admin deletes the credential or the client, or a refused client-credentials refresh
deletes the credentials (`credentials.ts`). A write-once column would need each of those paths to
write it back. The state is independent of `status` (`active | disabled`), so "switched off" and
"lacks input" stay two facts. No migration for the state itself.

(As built, ruling R17.) `connectors.created_by` became nullable by an expand-only migration
(`DROP NOT NULL`, after 0076): a create with no acting admin (install by scope sync, upgrade, the
ensure job, the reconciler) stores null, the admin list shows a system creator, and paths that need
an account fall back to the org owner. (As built, ruling R16.) A DCR connector
(`oauth_code`, `client: "dcr"`) registers its client on the first connect, under `LockService`, not
at create; its tools come after the first member connection, as for every `oauth_code` connector.
The derived state applies to every connector, template or custom. The connectors page's own create
flow is unchanged and still requires input, so in practice only template connectors (§5.2.2) and
connectors whose input was later removed reach `needs_config`.

A `needs_config` connector:

- is never called. The existing `CredentialMissing` check in the tool pipeline is the enforcement
  point; it fails closed and is covered by a test for each of the two cases above. Its text says the
  connector is 待配置 and an org admin must configure it (`orgMissingText`, `pipeline.ts`).
- has no tool list until it turns `ready` (below).
- keeps its template link (`platform_template_id` / `plugin_install_components.template_id`), so
  upgrades keep fanning out to it.
- turns `ready` when an admin saves the missing input on the connectors page (the existing connector
  edit form, opened by 配置), through the same validation as creating a connector today.

**Tool lists without a network call in a transaction** (builder's call). Install, scope sync and
upgrade create connector rows **without** listing tools: no outbound call inside the transaction
(AGENTS.md multi-replica rule). Listing moves to a follow-up:

- In the same transaction, an outbox row (`OutboxService.add`) is written per created `ready`
  connector. Its job lists the tools and stores them, with retries owned by the outbox.
- A `needs_config` connector gets that job when it turns `ready` (on save).
- Until the list arrives, the connector shows the existing "tools not loaded" state, and agents get
  no tools from it.
- An endpoint that keeps failing leaves the connector `ready` with the existing drift / error display
  on its card. It does not fail the install or the upgrade, and it is not `needs_config`.
- This needs a create path in `ConnectorsService` that skips the listing. It does not exist today.

**Personal static connectors** (builder's call). The installer's own credential is no longer asked
for. The connector is created `ready` with an empty tool list, and members see 未连接 (not connected)
with 连接 (connect), as for any personal connector. The first member connection triggers the same
tool-list job with that member's credential. Until then agents get no tools from it, and the agent
page shows it as not yet connected.

#### 5.2.2 Install and enable

- `planConnector` no longer refuses a missing input. A template that needs input becomes a
  `needs_config` connector, and one that needs none becomes `ready`.
- `missingTemplateInput` turns into the rule that derives the setup state, kept in one shared function so that
  the web (§4 `needsClient`) and the kernel cannot drift.
- The `connectors` record in the install / switch request schema (`org-catalog.schemas.ts`) is
  removed. Pre-release: no compatibility.
- Scope sync (`all` / `named`) installs plugins with templates like any other plugin. `systemNeedsInput`
  and the `needs_config` outcome of `ScopeSync.needsInput` go.
- Templates switched off as components (P2-6) and templates shipped default-off create no connector,
  as today. They stay template cards on the connectors page with 启用 (enable), which creates the
  connector under the same rule.
- An existing connector made from the template is reused, as today (`keptTemplates`).

#### 5.2.3 Upgrade

- Changed templates: fan out as today. When the credential shape changes, the connectors go
  `needs_config` instead of only having credentials cleared. The update preview lists them per org
  ("3 个组织需重新配置"), as `credentialsReset` does today.
- Added templates (P2-9 changes): each becomes a connector in every org where the plugin is on, under
  the §5.2.2 rule. (As built, rulings R27, R30, R31.) The upgrade diff splits each org's creates into
  created and deferred (both part of `diffHash`): a template whose connector plugin is off in that org
  is deferred. One routine, `ensureTemplateConnectorsIn`, creates a missing template connector for a
  template with no live or deleted connector from it (never-had rule), each in its own transaction
  under the org lock. It runs from scope sync, from an outbox job (queue `cap-template-connectors`,
  id `ensure-<orgId>-<seq>`, retried while the kind is not loaded) after install and when the
  connector plugin's org config is enabled, and from a `@LockedInterval` sweep that is the backstop
  once the job gives up. A plugin reinstalled while its connector kind is off does not recreate a
  soft-deleted template connector.
- Templates newly shipped on: the same, in orgs with no connector from them.
- Removed templates and templates newly shipped off: unchanged (their connectors stay as the org's own;
  `turnedOff` lists them).
- The platform update preview (`PlatformUpdatePreview`) gains, per org, the connectors the upgrade
  will create (and how many of them start `needs_config`), plus the orgs where scope sync will now
  install the plugin. This is new output in `plugin-upgrade.ts` and its response schema, and it is
  part of `diffHash` (builder's call: the maintainer asked that an update show its effect).
- The plugin state `needs_config` (P2-10, from `missingConnectors`) is no longer derived from missing
  connectors, since none are missing. It remains only for an invalid effective extension config
  (spec #720 `needsConfig`). The plugin page then shows plain 已启用 (on), and the setup state lives on
  the connector and extension cards.

#### 5.2.4 Where 待配置 shows

| Place | Admin | Member |
|---|---|---|
| Connectors page card | 待配置 + 配置 (opens the connector's edit form) | 待管理员配置, no button |
| Extensions page row (the page is a table; extension whose effective config is invalid) | 待配置 + 配置 (the existing config sheet) | 待管理员配置, no button |
| Agent page connector list | 待配置 | 待配置 |
| Tool call in a conversation | error text to the model naming that an org admin must configure the connector (existing text, `pipeline.ts`, reworded to say 待配置 in the UI string it maps to) | same |

The existing agent pending entries (P4-6/P4-7) stay for connectors an agent template needs that the
org does not have at all, for example from a plugin that is not enabled. A template connector that
exists as `needs_config` is not missing, so the agent refers to it and shows 待配置.

### 5.3 Install, update and enable flows

| Flow | Steps | Last step |
|---|---|---|
| Platform install (upload, market, direct git) | 选择插件包 → 审阅并确认 | review body + scope fields + sensitive ack + 安装 |
| Platform update | review of the from → to change (today's `PlatformUpdatePreviewBody`, restyled per §5.4) | 更新 |
| Org enable (catalog item) | one page: review body (contents only, no scope) | 启用 |
| Org upload (org-owned plugin) | 选择插件包 → 审阅并确认 | 安装 |

- The confirm step merges into the review page. Its only remaining content (scope and the sensitive
  ack) moves under the review body.
- The org enable wizard's per-template steps, `TemplateStep` in it, `credentialsOnly` and the
  `plugins/[itemId]/connectors` complete-setup page are removed. `TemplateStep` stays wherever it is
  reused outside install (`PendingConnectorDialog`).
- Setup guides (§9.3 of setup guides v2) move with the input. A template's guide shows on the
  connector's 配置 form, not on the enable page. `guide_ack` is recorded when the admin saves that
  form.
- Enable with no connector templates and no extension stays a direct switch (no page), as today.

### 5.4 The review page (phase 1, approved mockup)

Same sections and order as today: header, metadata, 扩展, 技能, 连接器模板, 智能体模板, 依赖. The
changes are all subtractions:

1. **Header**: name, a version chip (`安装 v0.1.0-rc.28`, or `rc.2 → rc.4` on update), and one total of
   sensitive items (`2 项敏感`). The description keeps its first sentence. The full text is behind
   完整说明 ›.
2. **Metadata**: 发布者 (publisher), 来源 (an `npm` / `git` chip and the package name), and 构建 (the
   provenance's repository@commit, with "（声明，未验证）" when it is unverified). The license stays
   behind 许可证全文 ›.
3. **扩展**: one card per extension. It has a 提供 (provides) row with the extension point chips and
   the plain-language risk, and a 配置 row with each top-level config field as a chip. Secret fields
   get a lock, there is no `deployment:` prefix, and no separate 密钥 section. A note under it reads
   "安装后在「扩展」页填写". On update, permissions added since the installed version are marked
   新增 (new).
4. **Sensitive** appears in two places only: the header total and the affected row in warning tone.
5. **Empty sections** are not rendered. One closing line lists them ("没有技能、连接器模板和依赖。").
6. **连接器模板**: one row per template, in the enable wizard's first-step style: icon, display name,
   a requirement tag (需要 OAuth 客户端, 需要组织凭据, or none), and the description truncated to one
   line. The endpoint host and "组织可改" are on the row. The full endpoint and transport are in a
   disclosure. 地址未检查 (`!endpointChecked`) is a warning tag. There are no checkboxes.
7. **技能**: a row each, with name, file count and description. SKILL.md is in a disclosure, and the
   hidden-characters warning is a tag.
8. **智能体模板**: a row each, with name and model tier, a 工具 (tools) row (inherit / removed chips), and
   a 需要 row naming the connectors it uses. The instructions are in a disclosure.
9. **Claude Code translation report**: a one-line summary (导入 n · 转换 n · 需要填写 n · 忽略 n ·
   警告 n). Warnings are shown expanded, and the rest is in a disclosure.

On an org enable the same body renders without the scope and provenance details the org cannot act
on. **Left to the builder:** the exact subset. Rule: an org admin sees contents and effect, not
deployment-level import facts.

### 5.5 Cards and sources (phase 1)

#### 5.5.1 Cards

`admin/plugins` (已安装), `admin/plugins/market`, `plugins` (org 插件 and 市场) switch to
`ListPage variant="cards"` with `ObjectCard`. Each card carries the same facts as today's row: icon,
name, description, meta line, state and actions. Row actions that today sit at the row end move into
the card's action slot and its overflow menu, with the same set and the same role rules. **Left to the
builder:** the per-card field placement, within `ObjectCard`'s slots.

#### 5.5.2 Source filter and the 市场源 entry

- The 添加市场源 header button goes. A 市场源 link button sits at the end of the filter row on the
  platform market tab and opens `admin/plugins/sources`.
- The design template's `scope` overflow changes. Up to `SEGMENTED_MAX` (5) options keep the
  `Segmented`. Above that, the scope renders as one `Select` labeled 来源, with 全部来源 first, and
  `Select`'s filter input appears past its threshold. The secondary `Tabs` row fallback is removed
  from `ListPage`.
- This is a design-system change (`packages/design/src/templates/list-page.tsx`), with its `/dev/ui`
  case and screenshot test, per the writing-web-ui change flow. Every `ListPage` with more than 5
  scope options gets the select. **Left to the builder:** confirm the other `scope` callers and update
  their tests.
- Avatar options (chips) keep their current rule.

#### 5.5.3 Sources page

`admin/plugins/sources` becomes `ListPage variant="cards"`:

- One card per source. It shows the name, the URL (host + path), the kind (git / marketplace.json),
  the last commit or fetch, the state (正常 · n 个条目 · time, or the error), and an on/off switch.
  Actions are 刷新 (refresh), and in the overflow 编辑 (edit) and 删除 (delete, `DangerConfirm`).
- The official source card is read-only: no edit, no delete. It carries a note that its address is set
  in the deployment config (`marketplaces.official.*`). Refresh and the switch stay.
- A 添加市场源 header action opens a dialog with today's add form (kind radio, name, URL, ref,
  username, token). 编辑 opens the same dialog prefilled. Token is "留空不改" (blank keeps the token),
  as today.
- The header search stays.

#### 5.5.4 Org market filter

The org 市场 tab gets the same `scope` filter. The kernel has no org endpoint listing sources. The
options are derived from the entries' `sourceId` / `sourceName`, which the org entries endpoint already
returns, and passed back as `sourceId` to `orgMarketplaceEntriesQuery`. No kernel change.

### 5.6 Org plugins page actions

- Only 启用 / 禁用 (enable / disable), plus the existing overflow items that are not configuration
  (details, uninstall for org-owned plugins, and the like). The `configure` and `configureWhenNeeded`
  actions in `PluginSwitch.tsx` are removed.
- 启用 opens the one-page review (§5.3) when the plugin has an extension or connector templates, and
  switches directly otherwise.
- The plugin state text drops 待配置 for plugins (§5.2.3). An invalid effective extension config shows
  on the extensions page card.

## 6. Spec text this amends

- `2026-11-05-plugin-component-management-design.md`:
  - §6, the bullet "they fill the endpoint and credentials for each …": they fill nothing, and
    templates become connectors (§5.2.2).
  - P2-9: added templates create connectors (§5.2.3).
  - P2-10: plugin `needs_config` comes only from the extension config (§5.2.3).
  - §17 "Install and update: one wizard each": §5.3.
- `2026-11-09-setup-guides-v2-design.md` §9.3: guides show on the connector's 配置 form (§5.3).
- `2026-11-09-connector-cards-and-member-policies-design.md` §2: template cards keep 启用 for
  default-off templates. 需要配置 / 配置 now belongs to connectors in `needs_config` (§5.2.4).

The builder adds a one-line pointer to this document at each amended section.

## 7. Risks

- **Multi-org, data.** Upgrade fan-out now creates connector rows in every org where the plugin is on.
  The rows are written in the existing upgrade transaction, with the same locks as today's fan-out.
  Tool listing follows through the outbox, never inside the transaction. It is a `high` review item.
- **Tool pipeline.** A `needs_config` connector must never be called. It is a fail-closed check at the
  same place as the missing-credential check, with a test.
- **Plugins waiting today** (builder's call). Plugins that scope sync left as `needs_config`
  install on the next scope-sync tick after phase 2 deploys, because the input check is gone.
  Installed plugins with `missingConnectors` get their connectors from a one-off reconciliation job,
  enqueued at startup with a deterministic id so that it runs once across replicas. It creates the
  missing template connectors under the §5.2.2 rule. Nothing is left waiting for an upgrade.
  (As built, rulings R22, R23, R26, R30.) The reconciler runs after extensions load, under
  `lock:bootstrap` taken by itself outside a transaction (replicas that lose it skip the pass), and
  writes the `templateConnectorsReconciled` mark in `deployment_settings` so it runs once; a template
  that cannot be planned is logged and skipped. The `@LockedInterval` sweep of §5.2.3 is the
  backstop for templates whose connector kind was not loaded at that start.
- **Silent change for scope-synced orgs.** Plugins with templates now install by scope sync. The orgs
  get 待配置 connectors they did not ask for. This is the intended behavior (decision 2). The
  platform update preview names the orgs affected.

## AGENTS.md rules touched

- **Plugins and the catalog** (changes): add after the scope sentence: "Install, upgrade and enable
  collect no input: every connector template that is on becomes a connector in the org, one that
  needs an org credential or OAuth client waits as `needs_config` (待配置) until an admin configures
  it on the connectors page; a `needs_config` connector is never called." The agent-template sentence
  ("a missing connector becomes a pending entry …") stays.
- **Web UI** (applies): pages built from design templates. The scope overflow change is made in the
  `ListPage` template, not in pages.
- **Mobile and shells** (applies): the sources add and edit dialog uses the `Dialog` primitive, which
  turns into a bottom sheet at compact width.

## 8. Phases

1. **Web only.**
   - Cards on the four lists, with the sources entry and the `scope` select overflow (design).
   - The sources page as cards plus a dialog, and the org market source filter.
   - The review page subtractions (§5.4), the merged confirm step for platform installs, and the
     removal of the org 组织配置 button.
2. **Kernel + web.**
   - The derived setup state, install / scope sync / upgrade without input (tool lists via the outbox), the pipeline
     check, and the 待配置 states (§5.2.4).
   - The org enable page as one review page, and removal of the template steps and the complete-setup
     page.

Phase 1 leaves the org enable wizard's template steps, and the 完成设置 (complete setup) entry for
plugins in `needs_config`, in place until phase 2 removes them (builder's call). Without that entry, a
plugin waiting for connector input would have no way forward between the phases. It is not a
configuration button for the plugin: phase 2 removes it together with the page it opens.

## 9. Left to the builder

- Card field placement within `ObjectCard` (§5.5.1).
- The org subset of the review body (§5.4).
- Exact zh / en copy for new strings, following the i18n rules (平台 / 智能体; no 企业).
