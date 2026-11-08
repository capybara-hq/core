# UI slots: one versioned registry for where extensions put UI

- Date: 2026-11-08, written against `main` at `180e4bd4`; adjusted on 2026-11-09 against
  `feat/themes` at `eff38b42` (latest kernel migration 0103).
- Status: reviewed by the maintainer (2026-11-08); adjusted to the code on 2026-11-09.
- Plan: `docs/superpowers/plans/2026-11-09-ui-slots.md`.
- Related: themes (`2026-11-08-themes-design.md`, layer L0 of the same direction), the extension UI
  contract (`.agents/skills/writing-extension-ui/SKILL.md`, `packages/plugin-sdk/src/ui.ts`), the UI
  refresh spec (conversation places), the design spec (§5.4 conversation template, §6.16.17
  properties panel, §6.16.18 right panel), roles everywhere, the `Platform` tool
  (`check:platform-ops`), co-build.
- Markers: **(decided, 2026-11-08)** is the maintainer's answer in the 2026-11-08 discussion;
  **(decided by Claude under the 2026-11-09 grant)** is a ruling taken on 2026-11-09 under the
  maintainer's autonomy grant while fitting the spec to the code (R1-R12 of the plan's research
  pass); **(designer's call)** is decided here and may be overturned in review. Items without a
  marker restate current code or AGENTS.md rules.

## 1. Why

Plugins will be able to change the web in four layers **(decided, 2026-11-08)**: L0 themes, **L1
slots** (this spec), L2 client components and L3 decoration (a later direction doc). L1 is the
skeleton the later layers hang on: L2 puts React components into the same slots, and replacement
(the last step of the direction) is a property of a slot.

Today an extension says where its UI goes with `place`, a closed enum: `panel`, `section`,
`inline` on the conversation page, `page` (an org page under 扩展), `file-preview`, plus the old
`conversation`. That has four limits:

1. **Closed and conversation-centred**: no position on the agent page, the settings pages or the
   admin console; each new position is a change to the enum, the kernel and the web.
2. **No contract per position**: what a `section` receives (`conversationId`, `role`, dense
   rendering, its limits) lives in prose in a skill, not in a catalog a tool or an agent can read.
3. **No versions**: changing what a position passes or how it renders silently changes every
   plugin using it.
4. **No placement among built-ins**: an extension section always sits right after Context.

DSH's lesson points the same way: its slot tree is generated from the code into a catalog
(`slot-catalog.ts`, queryable at runtime with `cordis_inspect`), and its restyles broke where
there was no contract.

## 2. Goals, non-goals, anti-goals

Goals:

1. **A slot** is a named, versioned position in the web, rendered by exactly one web file, with
   a typed contract: where it is, what it passes to the extension, which kinds it accepts, who may
   see it, how it renders, its limits.
2. **One catalog** of slots in the SDK, read by the kernel (validation, access), the web (through a
   generated copy), the docs, `capybara-plugin check` and agents (through the `Platform` tool).
3. Extensions contribute to a slot by id; today's five places become slots with the same behavior.
4. New slots outside the conversation page, the ones listed in §6.
5. A contribution can be placed among the built-in parts of its slot, and org admins (and the
   super admin, for the platform default) can hide and reorder what extensions put in a slot.

Non-goals (later layers):

- Extension code in the browser (L2) and replacing built-in parts (replacement slots). The catalog
  reserves the fields for both (§3.3) so they arrive without a format change.
- Global styling hooks, overlays and client events (L3).

Anti-goals:

- A slot the web renders but the catalog does not list, or the reverse.
- A core upgrade that quietly moves or drops a plugin's UI.
- One extension's failure in a slot affecting the page or another contribution (today's
  per-block isolation must survive).

## 3. The slot catalog

### 3.1 Shape

The SDK exports `UI_SLOTS`, a literal catalog (designer's call: data in the SDK, so the kernel,
`plugin-tools` and the docs read one source; the web, which imports no SDK, reads a copy generated
by `pnpm gen:ui-slots` and drift-checked by `check:ui-slots`):

```ts
interface UiSlotSpec {
  id: UiSlotId;                  // "conversation.properties.section"
  version: number;               // 1; bumped on an incompatible contract change
  owner: string;                 // the apps/web/src file that renders it (§7)
  scope: "conversation" | "agent" | "org" | "platform" | "file";
  accepts: readonly ("view" | "embed")[]; // L2 adds "component"
  cardinality: "list";           // L1 has only list slots; "single" is reserved (§3.3)
  minRole: "guest" | "member" | "admin" | "superAdmin";
  args: readonly string[];       // context ids passed to render: "conversationId", "agentId", …
  density: "dense" | "regular";
  icon: "required" | "optional" | "none"; // every L1 slot: "optional" (today's default `puzzle`)
  anchors?: readonly string[];   // built-in parts a contribution may be placed after (§5); the first is the default
  limits?: { maxShown?: number };
  description: { en: string; zh: string };
}
```

`owner` is the apps/web file, not a design template **(decided by Claude under the 2026-11-09
grant, R3)**: `packages/design` has no data layer, and every renderer of extension UI (the view
renderer, embed tabs, extension blocks) lives in apps/web; the design package keeps the
presentational parts (`PropertySection`, `EmbedFrame`, …).

`minRole` maps onto the kernel's roles **(decided by Claude under the 2026-11-09 grant, R9)**:
`guest` / `member` / `admin` are org roles (`admin` = org admin or owner, `roleAtLeast`), and
`superAdmin` is the separate `@SuperAdmin` check of the admin console. The org UI routes keep
`@OrgAction("ui.use")` (guest) as their base; the slot's `minRole` tightens it.

### 3.2 Versions

- A slot's `version` changes only for an incompatible change of its contract (args removed or
  renamed, a kind dropped, a role tightened, the rendering changed in a way a view must adapt to).
  Adding an optional arg or an anchor is compatible.
- A contribution names a slot as `"<id>"` (= version 1) or `"<id>@<n>"` (`parseSlotRef`). In L1
  every slot is at version 1 and the host accepts only the catalog's `version`; a supported-version
  list per slot arrives with the first `@2`. While a slot moves from `@1` to `@2`, the web renders
  both forms for one minor release after 0.1.0 (before 0.1.0 there are no compatibility layers,
  AGENTS.md).
- A contribution to an unknown slot or an unsupported version **does not fail the extension**
  **(decided, 2026-11-08)**: the contribution is dropped, the kernel logs one warning per extension
  version and replica, and the admin extension detail lists it under 未生效的界面 with the reason.
  The rest of the extension loads. `capybara-plugin check` reports it as an error
  (`ui-slot-unknown`) so it is caught before release.
- **Split validation (decided by Claude under the 2026-11-09 grant, R1)**: today `defineExtension`
  throws on any ui problem and the kernel turns the throw into a load failure
  (`ExtensionManifestError`). The validation splits in two:
  - **Structural** problems still throw (and fail the load): not an object, a bad `id` / `title` /
    `kind` / `icon` / `path`, both `slot` and `place` or neither, an unknown `place` value, a
    duplicate id, the permission cross-check, an `aliasOf` that names no other contribution of the
    same kind, and, for a slot the catalog knows, a kind it does not accept or a missing required
    icon.
  - **Slot resolution** (`resolveUiSlots`) never throws: an unknown slot id or an unsupported
    version makes the contribution *dropped* with reason `unknown-slot` / `unsupported-version`
    (an alias whose target is dropped is dropped with the target's reason). An `after` that is not
    one of the slot's anchors keeps the contribution at the slot's default position, with a load
    warning (`capybara-plugin check`: error `ui-slot-anchor`), because anchors can be added
    compatibly.
  - `defineExtension` returns the manifest unchanged (its `ui` exactly as written): the static
    manifest recorded at import (`staticManifestOf`, compared at load) keeps matching. The kernel
    resolves slots when it loads the instance, keeps the resolved contributions and the dropped list
    on the instance, and exposes the dropped list on `GET /api/v1/admin/extensions/:name`
    (`uiDropped: { id, ref, reason }[]`).

### 3.3 Reserved for later layers

- `accepts: "component"` (L2: a React component from the plugin's browser bundle).
- `cardinality: "single"` with a built-in default, and `replaceable: boolean` (replacement: a
  higher-priority contribution takes the cell). Both stay out of the catalog values until their
  spec is decided.

## 4. Contributions

The manifest's `place` becomes `slot`, with no alias for `place` as the end state **(decided,
2026-11-08)**:

```ts
ui: [
  { id: "tasks-panel",   title, slot: "conversation.panel",              kind: "view", icon: "list-checks" },
  { id: "tasks-section", title, slot: "conversation.properties.section", kind: "view", after: "context" },
  { id: "tasks-card",    title, slot: "conversation.tool-result.card",   kind: "view" },
]
```

- `id`, `title`, `kind`, `icon`, `path` (embeds), `aliasOf` and the permission rules
  (`permissions.ui.views` / `embeds`, `ui.view:<id>` never blocks loading, `ui.embed:<id>` is
  sensitive, the `perm-ui` check) are unchanged.
- `after`: one of the slot's `anchors` (§5); omitted = the slot's first anchor.
- Kernel output and the web use `slot` only: the contributions list carries `slot` (the id, no
  version) and, for a slot with anchors, the resolved `after`; `place` and `legacyPlace` leave the
  API.
- **Moving off `place` takes three steps (decided by Claude under the 2026-11-09 grant, R2)**:
  the official `todo` plugin is a bootstrap plugin pinned at `0.1.0-rc.2`
  (`packages/kernel/bootstrap.json`), its published manifest says `place`, and plugins use the
  host's SDK (peer dependency); refusing `place` at once would make it fail to load wherever it is
  switched on.
  - **Step A (this spec's implementation)**: the SDK and the host accept `slot` (canonical) and still
    accept `place` as a deprecated input, mapped to its slot: `panel` and `conversation` →
    `conversation.panel`, `section` → `conversation.properties.section`, `inline` →
    `conversation.tool-result.card`, `page` → `org.page`, `file-preview` → `file.preview`.
    `capybara-plugin check` warns `ui-place-deprecated`.
  - **Step B** (a `capybara-hq/plugins` PR after an SDK / testing release): `todo` and
    `example-board` move to `slot` and are released; their old alias ids `tasks` / `board-conv` keep
    working through `aliasOf`.
  - **Step C** (a core PR): the bootstrap pin moves to the new `todo`, then `place` is removed from
    the SDK, the host and the check, making "no alias" true.

## 5. Placement and arrangement

- **Anchors**: a slot lists the built-in parts a contribution may follow; the first is the default.
  For `conversation.properties.section` the anchors are `context`, `files`, `background`, the
  panel's real order (`PropertiesSections.tsx`: Context → extension sections → Files, shown only
  with files → Background, shown only with background tasks or sub-agents); the default stays
  after `context`, today's position **(decided by Claude under the 2026-11-09 grant, R4)**.
  Contributions after an anchor whose built-in part is not shown render where it would be.
- **Base order** (designer's call): within a slot and anchor, contributions are ordered by
  extension name, then manifest order. It does not depend on load order, so every replica lists
  the same order.
- **Arrangement**: per slot, a list of hidden contributions and an order, keyed
  `<extension>/<contribution>`: `{ [slotId]: { hidden: string[]; order: string[] } }`. Listed keys
  come first in `order`'s order within their anchor, the rest follow in base order; unknown keys are
  kept and ignored (the extension may be off now). Reordering across anchors is not possible.
  Every slot except `file.preview` (ordered by the file previewer setting) can be arranged.
- **Who arranges (decided, 2026-11-08)**: org admins for their org, the super admin for the
  platform default; a person cannot rearrange (one layout per org keeps support simple).
- **Storage (decided by Claude under the 2026-11-09 grant, R10)**: the org's arrangement is
  `orgs.settings.uiArrangement` (in `OrgSettingsSchema`, parsed leniently like `theme`: an invalid
  stored value reads as absent), the platform's is the `deployment_settings` key `uiArrangement`
  (in `DEPLOYMENT_SETTINGS`). Writes go through the existing `PATCH /api/v1/orgs/:orgId/settings`
  and `PUT /api/v1/admin/settings` (Platform operations `org-settings.update` /
  `admin.update-settings` gain the field), merged per slot: an entry replaces that slot's
  arrangement, `null` removes it. No migration. The org's entry for a slot replaces the platform's
  entry for that slot; a slot the org has not arranged follows the platform. The org arrangement
  takes no `platform.page` entry (400 `validation_failed`); an unknown slot id is 400.
- **Where it is set (decided by Claude under the 2026-11-09 grant, R7)**: a section 界面位置 on
  the workspace 扩展 page (`/extensions`, next to the file previewer section), editable by org
  admins and read only for members; the platform default is a section 界面位置 in 平台设置
  (`/admin/settings`).
- **The sidebar follows `org.page` (decided by Claude under the 2026-11-09 grant, R5)**: org pages
  are already listed in the sidebar's 更多 group, so hiding or reordering `org.page` contributions
  hides or reorders them there; no separate sidebar slot.
- **Hidden means not listed, not "not served"** (designer's call): the kernel applies the
  arrangement to the contributions lists, so the web never renders a hidden contribution; the
  views, actions, embed-token and stream routes keep checking only enablement, the slot's role and
  its scope. A direct URL to a hidden `org.page` still renders for whoever the slot admits. Hiding
  is layout, not governance: to stop an extension serving UI, switch it off in the org.
- Hiding is not disabling: the extension, its tools and its other contributions stay on. The
  conversation page keeps its per-person state as today (which right panel is open, in the URL
  hash; the panel width). There is no per-person collapsed state of sections **(decided by Claude
  under the 2026-11-09 grant, R4)**.

## 6. The first catalog

Today's places as slots, with their behavior unchanged:

| Slot | Was | Scope / args | Accepts | Min role | Owner (apps/web/src) | Notes |
|---|---|---|---|---|---|---|
| `conversation.panel` | `panel` (`conversation`) | conversation / `conversationId`, `item` | view, embed | guest | `components/conversation/RightArea.tsx` | title-bar icon (`puzzle` by default, as today); one right panel at a time |
| `conversation.properties.section` | `section` | conversation / `conversationId` | view, embed | guest | `components/conversation/PropertiesSections.tsx` | dense; anchors `context`, `files`, `background` |
| `conversation.tool-result.card` | `inline` | conversation / `conversationId`, `card` | view, embed | guest | `components/conversation/RightArea.tsx` | only through `ToolResult.card`, as today |
| `org.page` | `page` | org / — | view, embed | member | `app/(app)/p/[plugin]/[id]/view.tsx` | `/p/<plugin>/<id>`; listed in the sidebar's 更多 group |
| `file.preview` | `file-preview` | file / `conversationId`, `fileId` | embed | guest | `components/conversation/FilePanel.tsx` | only through `file-preview@1`, as today |

New slots **(decided, 2026-11-08; the sidebar slot replaced per R5)**; each one an existing page
region, so no new layout:

| Slot | Where | Scope / args | Accepts | Min role | Owner (apps/web/src) |
|---|---|---|---|---|---|
| `agent.detail.section` | an extra nav item of the agent page after its built-in sections | agent / `agentId` | view, embed | guest (and the agent must be readable) | `components/agent/AgentPage.tsx` |
| `org.settings.section` | a section appended to 组织设置 › 通用 | org / — | view, embed | admin | `app/(app)/settings/organization/view.tsx` |
| `platform.page` | a page in the admin console, listed in its 扩展 group (`/admin/p/<plugin>/<id>`) | platform / — | view, embed | superAdmin | `app/(app)/admin/p/[plugin]/[id]/view.tsx` |

- **`agent.detail.section` (decided by Claude under the 2026-11-09 grant, R6)**: the agent page is a
  SettingsPage that shows one section at a time (`?s=`); each contribution becomes a nav item after
  the built-in ones (`?s=ext.<plugin>.<id>`) and renders as that section's body. It is shown to
  whoever can read the agent (`isAgentVisibleTo`, in the agent's org), read-only viewers included;
  the extension tightens on `role` if it must. Render args gain `agentId`.
- **`org.settings.section` (R7)**: sections appended to the 组织设置 › 通用 page (a SettingsPage of
  FormSections), after the built-in sections; only org admins see them.
- **`platform.page` (decided by Claude under the 2026-11-09 grant, R8)**: rendered for super admins
  with `role: "superAdmin"` and no `orgId`; it needs the org-less routes of §7.
- **`workspace.sidebar.item` is dropped (decided by Claude under the 2026-11-09 grant, R5)**: org
  pages are already auto-listed in the sidebar's 更多 group (`components/shell/nav.tsx`), so the
  slot would only duplicate `org.page`; the arrangement of `org.page` is the sidebar's (§5).

Candidates left for later specs: the composer's action row, the conversation title-bar menu, the
inbox, the overview of an org, connector and skill detail pages.

## 7. Where the catalog is enforced

- **SDK**: `UI_SLOTS`, `UiSlotSpec`, `UiSlotId`, `parseSlotRef("<id>@<n>")`, the deprecated
  `PLACE_SLOTS` map (step A only), structural validation in `validateUiContributions` (used by
  `defineExtension`) and `resolveUiSlots` (used by the kernel and `plugin-tools`). Render and action
  args gain `slot` and `scope` (the slot's), `agentId` (agent scope), and `orgId` becomes optional
  (absent only for the platform scope, where `role` is `"superAdmin"`). `EmbedClaims` gain `scope:
  "org" | "platform"` and `agentId?`, and `orgId` is absent exactly when `scope` is `"platform"`.
  `ctx.ui.invalidate` takes no `orgId` only for a `platform.page` contribution.
- **Web (decided by Claude under the 2026-11-09 grant, R3)**: `ExtensionSlot({ slot, args, select?,
  anchor? })` in `apps/web/src/components/extension-ui/` is the only way to render contributions:
  it reads its slot's (already arranged) contributions, renders each view or embed with today's
  isolation (10 s timeout on the conversation page, a failing block shows the load-failure line in
  that block only) and draws nothing when the slot is empty. `select` renders one contribution (a
  panel, a page, a card, an agent section, a file preview); `anchor` renders a list slot's
  contributions placed after that anchor. Nav entries that only list contributions (title-bar
  icons, the sidebar, the agent nav, the admin nav) read them through `useSlotContributions`.
  `check:web-ui` gains `web-ui-extension-slot`: the extension renderers (`ExtensionPanel`,
  `ExtensionSection`, `ExtensionCard`, `ExtensionViewTab`, `EmbedTab`) are used only inside
  `components/extension-ui/`.
- **`check:ui-slots`** (new, full on PRs: cheap, reads the SDK catalog and scans `apps/web/src`):
  every catalog slot is rendered by exactly one `<ExtensionSlot slot="…">` with a literal slot, in
  the file the catalog names as its `owner`; every `ExtensionSlot` names a catalog slot as a
  literal; the generated web copy and docs page are current. Rules `ui-slot-unrendered`,
  `ui-slot-undeclared` (renamed from `ui-slot-unknown`, which is `capybara-plugin check`'s),
  `ui-slot-owner`, `ui-slot-twice`, `ui-slot-literal`, `ui-slots-stale`; proven red first.
- **Kernel, org scope**: `GET /api/v1/orgs/:orgId/ui/contributions?slot=` lists the contributions
  of every org-reachable slot (all but `platform.page`) or of one slot, filtered by enablement
  (`enabled.ts`), the slot's `minRole`, then the arrangement (§5). The views, actions, embed-token
  and refresh-stream routes check the slot rule of the contribution they name: the slot's
  `minRole`, then its scope's access rule (conversation: whoever can read the conversation; agent:
  whoever can read the agent, and the agent is in this org; org: the role alone; file: the
  previewer's read grant, as today), so a view is never served outside the slot that admits it. A
  `platform.page` contribution through an org route is 404 `ui.not_found`, super admins included.
  The org refresh stream stays member and above (an `agent.detail.section` viewed by a guest
  refreshes on navigation only).
- **Kernel, platform scope (decided by Claude under the 2026-11-09 grant, R8)**: org-less routes
  under `/api/v1/admin/ui/` (`@SuperAdmin`, human only): `GET contributions` (`platform.page`
  only, the platform arrangement applied), `GET views/:plugin/:id`, `POST actions/:plugin/:id`,
  `POST embeds/:plugin/:id/token`, `GET stream` (topic `platform-ui`). A platform contribution
  needs its extension running (no org enablement applies) and gets the platform's deployment
  config. `ctx.ui.verifyEmbedToken` accepts a platform-scope token only when the contribution is a
  `platform.page` and the account is still an active super admin, and an org-scope token only when
  the contribution's slot is not `platform.page`, the org checks of today pass and the current role
  still meets the slot's `minRole`.
- **Arrangement routes**: `GET /api/v1/orgs/:orgId/ui/arrangement` (`ui.use`, member and above)
  and `GET /api/v1/admin/ui/arrangement` (`@SuperAdmin`) list, per arrangeable slot, every
  contribution with its hidden flag and effective order and whether the slot follows the platform,
  for the 界面位置 sections.
- **Catalog for tools and agents (decided by Claude under the 2026-11-09 grant, R11)**: `GET
  /api/v1/ui/slots` returns the catalog (any signed-in person); it is mirrored as the `Platform`
  operation `ui.slots`, so an agent helping someone build a plugin (co-build) can see where UI can
  go. The UI route DTOs move to `ui/ui.schemas.ts` so `ROUTE_SCHEMAS` can reference them; the new
  UI routes get Platform exclusions (transport or internal, human only) like the existing ones. The
  docs page `docs/guide/ui-slots.md` and the web copy `apps/web/src/lib/ui-slots.generated.ts` are
  generated from the SDK (`pnpm gen:ui-slots`, drift-checked by `check:ui-slots`).

## 8. What does not change

- The two kinds (schema views, sandboxed embeds), `UiView` blocks and `UI_LIMITS`, embed tokens
  (never valid for `/api`), the `/plugin-ui` proxy and its CSP sandbox, the message bridge.
- Inline cards stay display-only, recorded as `tool_result.card`, never model-visible; replays are
  unaffected. No `DriftReason`.
- Extensions stay in-process and full trust; approving `ui.embed:*` stays the sensitive step.
- No migration: both arrangements live in existing JSON settings.

## 9. Tests

- SDK: catalog shape (ids unique, anchors unique, versions positive, owner paths under apps/web/src,
  minRole and scope consistent: `platform` ⇔ `superAdmin`), slot refs, structural validation
  (both `slot` and `place`, kind not accepted, missing required icon), resolution (unknown slot,
  unsupported version, alias of a dropped target, unknown anchor at the default position), every
  `place` mapping.
- plugin-tools: `ui-slot-unknown`, `ui-slot-anchor` errors and the `ui-place-deprecated` warning on
  red fixtures.
- Kernel: an unknown-slot contribution is dropped, the extension still loads and the admin detail
  lists it; a fixture shaped like `todo@0.1.0-rc.2` (all `place`, an alias) loads with all its UI;
  the per-scope access rules on every route (a guest gets 404 `ui.not_found` for `org.page` and
  `org.settings.section`, a member for `org.settings.section` and through any org route for
  `platform.page`; a reader of another org's agent gets 404); `agentId` passed to
  `agent.detail.section`; platform routes refuse non-super-admins; embed tokens of one scope are
  null in the other; arrangement applied, limited to the org, platform default followed; a hidden
  `org.page` still renders by direct URL.
- `check:ui-slots` and `web-ui-extension-slot`: red fixtures.
- Testing package: `fake-tools-ui` and `fake-embed` move to `slot` and gain contributions for the
  new slots.
- Web: an e2e test per new slot (contribution shown in the right place, hidden after an org admin
  or the super admin hides it); the visual and fidelity suites cover `ExtensionSlot`'s empty /
  failed states where they are new.

## 10. Phases

All in one implementation plan (`2026-11-09-ui-slots.md`), in waves:

1. SDK catalog, `slot` in the manifest with `place` still accepted (step A), split validation;
   `capybara-plugin check` rules; the kernel resolving slots at load with the dropped list.
2. Kernel routes by slot (org scope, agent scope, platform scope), embed tokens by scope, the
   arrangement settings and routes, the catalog route and `Platform` operation.
3. The web: `ExtensionSlot`, today's places moved, the three new slots, the arrangement sections,
   the admin 未生效的界面; then `check:ui-slots` and `web-ui-extension-slot`; docs and skills.
4. Follow-ups outside this plan: step B (the plugins repository PR and releases) and step C (the
   bootstrap pin moves, `place` is removed).

## 11. Review decisions

Answered on 2026-11-08: the new slots of §6 are the first set, the composer action row goes to a
later spec; `slot` replaces `place` with no alias as the end state (§4); people cannot rearrange
slots, only org admins and the platform (§5); a contribution to an unknown slot is dropped with a
warning, the extension still loads (§3.2).

Adjusted on 2026-11-09 under the maintainer's autonomy grant (R1-R12): the split validation and the
dropped list (§3.2); `place` leaves in three steps because of the pinned `todo` (§4); `owner` is an
apps/web file and `ExtensionSlot` lives in apps/web (§3.1, §7); the real properties panel order and
no per-person collapsed state (§5); `workspace.sidebar.item` dropped, the `org.page` arrangement
is the sidebar's (§5, §6); `agent.detail.section` as extra nav items (§6); `org.settings.section`
on 组织设置 › 通用 and the arrangement on the workspace 扩展 page (§5, §6); org-less platform routes
and embed scopes (§7); `minRole` onto kernel roles (§3.1); arrangement storage in existing settings
(§5); the catalog route, Platform operation and `ui.schemas.ts` (§7); new web tests are named
`ui-slot-*.test.tsx` because `apps/web/test/extension-slots.test.tsx` is taken (R12).
