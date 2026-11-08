# UI slots: one versioned registry for where extensions put UI

- Date: 2026-11-08, written against `main` at `180e4bd4`.
- Status: draft for review.
- Related: themes (`2026-11-08-themes-design.md`, layer L0 of the same direction), the extension UI
  contract (`.agents/skills/writing-extension-ui/SKILL.md`, `packages/plugin-sdk/src/ui.ts`), the UI
  refresh spec (conversation places), the design spec (§5.4 conversation template, §6.16.17
  properties panel, §6.16.18 right panel), roles everywhere, the `Platform` tool
  (`check:platform-ops`), co-build.
- Markers: **(decided, 2026-11-08)** is the maintainer's answer in the 2026-11-08 discussion;
  **(designer's call)** is decided here and may be overturned in review. Items without a marker
  restate current code or AGENTS.md rules.

## 1. Why

Plugins will be able to change the web in four layers **(decided, 2026-11-08)**: L0 themes, **L1
slots** (this spec), L2 client components and L3 decoration (a later direction doc). L1 is the
skeleton the later layers hang on: L2 puts React components into the same slots, and replacement
(the last step of the direction) is a property of a slot.

Today an extension says where its UI goes with `place`, a closed enum: `panel`, `section`,
`inline` on the conversation page, `page` (an org page under 扩展), `file-preview`, plus the old
`conversation`. That has four limits:

1. **Closed and conversation-centred**: no position on the agent page, the settings pages, the
   admin console or the sidebar; each new position is a change to the enum, the kernel and the web.
2. **No contract per position**: what a `section` receives (`conversationId`, `role`, dense
   rendering, its limits) lives in prose in a skill, not in a catalog a tool or an agent can read.
3. **No versions**: changing what a position passes or how it renders silently changes every
   plugin using it.
4. **No placement among built-ins**: an extension section always sits between Context and Files.

DSH's lesson points the same way: its slot tree is generated from the code into a catalog
(`slot-catalog.ts`, queryable at runtime with `cordis_inspect`), and its restyles broke where
there was no contract.

## 2. Goals, non-goals, anti-goals

Goals:

1. **A slot** is a named, versioned position in the web, owned by exactly one page template, with
   a typed contract: where it is, what it passes to the extension, which kinds it accepts, who may
   see it, how it renders, its limits.
2. **One catalog** of slots in the SDK, read by the kernel (validation), the web (rendering), the
   docs, `capybara-plugin check` and agents (through the `Platform` tool).
3. Extensions contribute to a slot by id; today's five places become slots with the same behavior.
4. New slots outside the conversation page, starting with the ones listed in §6.
5. A contribution can be placed among the built-in parts of its slot, and org admins can hide
   and reorder what extensions put in a slot of their org.

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
the web through its own copy of the types, `plugin-tools` and the docs read one source):

```ts
interface UiSlotSpec {
  id: string;                    // "conversation.properties.section"
  version: number;               // 1; bumped on an incompatible contract change
  owner: string;                 // the page template that renders it ("ConversationPage")
  scope: "conversation" | "agent" | "org" | "platform" | "file";
  accepts: ("view" | "embed")[]; // L2 adds "component"
  cardinality: "list";           // L1 has only list slots; "single" is reserved (§3.3)
  minRole: "guest" | "member" | "admin" | "superAdmin";
  args: string[];                // context ids passed to render: "conversationId", "agentId", …
  density: "dense" | "regular";
  icon: "required" | "optional" | "none";
  anchors?: string[];            // built-in parts a contribution may be placed after (§5)
  limits?: { maxShown?: number };
  description: { en: string; zh: string };
}
```

### 3.2 Versions

- A slot's `version` changes only for an incompatible change of its contract (args removed or
  renamed, a kind dropped, a role tightened, the rendering changed in a way a view must adapt to).
  Adding an optional arg is compatible.
- A contribution names a slot as `"<id>"` (= version 1) or `"<id>@<n>"`. The host supports a set of
  versions per slot; while a slot moves from `@1` to `@2`, the web renders both forms for one
  minor release after 0.1.0 (before 0.1.0 there are no compatibility layers, AGENTS.md).
- A contribution to an unknown slot or an unsupported version **does not fail the extension**
  (designer's call): the contribution is dropped, the kernel logs one warning per extension
  version, and the admin extension detail lists it under 未生效的界面 with the reason. The rest of
  the extension loads. `capybara-plugin check` reports it as an error (`ui-slot-unknown`) so it
  is caught before release.

### 3.3 Reserved for later layers

- `accepts: "component"` (L2: a React component from the plugin's browser bundle).
- `cardinality: "single"` with a built-in default, and `replaceable: boolean` (replacement: a
  higher-priority contribution takes the cell). Both stay out of the catalog values until their
  spec is decided.

## 4. Contributions

The manifest's `place` becomes `slot` (designer's call; before 0.1.0, so no alias for `place`):

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
- `after`: one of the slot's `anchors` (§5); omitted = the slot's default position for extensions.
- Validation (`validateUiContributions`, kernel load, `capybara-plugin check`): the slot exists,
  accepts the kind, the icon rule holds, `after` is one of its anchors.
- The old `place: "conversation"` alias and `legacyPlace` in API output are removed with `place`
  (the official `todo` and `example-board` plugins move to `slot` in a `capybara-hq/plugins` PR
  merged together with core's; their old alias ids `tasks` / `board-conv` keep working through
  `aliasOf`).

## 5. Placement and per-org arrangement

- **Anchors**: a slot lists the built-in parts a contribution may follow. For
  `conversation.properties.section`: `context`, `files`, `background` (the order of the
  properties panel, §6.16.17; with the properties panel regions planned on 2026-11-03,
  环境 / 上下文 / 输出内容 / 后台任务, the anchors follow those regions). Contributions after the same
  anchor keep their contribution order, then the extension's name.
- **Org arrangement (designer's call)**: an org admin can, per slot, hide an extension's
  contribution and reorder contributions within an anchor (组织设置 › 扩展 › 界面位置), stored as an
  org setting `ui.arrangement: { [slotId]: { hidden: string[]; order: string[] } }` keyed by
  `<extension>/<contribution>`. A platform arrangement (super admin) sets the default the org
  starts from, following the platform / org layering precedent. The person cannot rearrange
  (designer's call: one layout per org keeps support simple); the conversation page keeps its own
  per-person state (which panel is open, sections collapsed) as today.
- Hiding is not disabling: the extension, its tools and its other contributions stay on.

## 6. The first catalog

Today's places as slots, with their behavior unchanged:

| Slot | Was | Scope / args | Accepts | Notes |
|---|---|---|---|---|
| `conversation.panel` | `panel` (`conversation`) | conversation / `conversationId`, `item` | view, embed | title-bar icon required; one right panel at a time |
| `conversation.properties.section` | `section` | conversation / `conversationId` | view, embed | dense; anchors `context`, `files`, `background` |
| `conversation.tool-result.card` | `inline` | conversation / `conversationId`, `card` | view, embed | only through `ToolResult.card`, as today |
| `org.page` | `page` | org / — | view, embed | member and above; `/p/<plugin>/<id>`; under 扩展 |
| `file.preview` | `file-preview` | file / read grant | embed | only through `file-preview@1`, as today |

New slots in this spec (designer's call; each one an existing template region, so no new layout):

| Slot | Where | Scope / args | Accepts | Min role |
|---|---|---|---|---|
| `agent.detail.section` | a section on the agent's page, after its built-in sections | agent / `agentId` | view, embed | whoever can read the agent |
| `org.settings.section` | a section on 组织设置 (an extension's org-level screen beyond its config form) | org / — | view, embed | admin |
| `platform.page` | a page in the admin console under 扩展 (`/admin/p/<plugin>/<id>`) | platform / — | view, embed | super admin |
| `workspace.sidebar.item` | an entry in the sidebar's 更多 group that opens one of the extension's `org.page` contributions | org / — | link to an `org.page` | member |

`workspace.sidebar.item` carries no view of its own: it names one of the same extension's
`org.page` contributions (`opens: "<id>"`), so the sidebar stays links only.

Candidates left for later specs: the composer's action row, the conversation title-bar menu, the
inbox, the overview of an org, connector and skill detail pages.

## 7. Where the catalog is enforced

- **SDK**: `UI_SLOTS`, `UiSlotSpec`, `parseSlotRef("<id>@<n>")`, validation used by
  `defineExtension`, the kernel and `plugin-tools`.
- **Web**: a design component `ExtensionSlot({ slot, args })` is the only way to render
  contributions; it reads the contributions for its slot, applies the org arrangement, renders
  each view or embed with today's isolation (10 s timeout on the conversation page, a failing
  block shows the load-failure line in that block only), and draws nothing when the slot is
  empty. Templates place it; pages do not render extension UI otherwise (`check:web-ui` gains
  `web-ui-extension-slot`).
- **`check:ui-slots`** (new, full on PRs: cheap, reads the SDK catalog and scans `apps/web/src` and
  `packages/design/src` for `ExtensionSlot` literals): every catalog slot is rendered by exactly one
  template, every `ExtensionSlot` names a catalog slot as a literal, and the template matches the
  slot's `owner`. Rules `ui-slot-unrendered`, `ui-slot-unknown`, `ui-slot-owner`; proven red first.
- **Kernel**: the contributions route takes `?slot=` and the slot's args, filters by enablement
  (`enabled.ts`), the slot's `minRole` and its scope's access rule (conversation: whoever can read
  the conversation; agent: whoever can read the agent; org: member and above; platform: super
  admin), then the arrangement. The views, actions, embed tokens and refresh stream routes check
  the same slot rule, so a view is never served outside the slot that admits it. Render args gain
  `slot` and the slot's context ids (`agentId`).
- **Catalog for tools and agents**: `GET /api/v1/ui/slots` returns the catalog (any signed-in
  person); it is mirrored as a `Platform` operation, so an agent helping someone build a plugin
  (co-build) can see where UI can go. The docs page of the slot catalog is generated from the SDK
  (`pnpm gen:ui-slots`, drift-checked by `check:ui-slots`).

## 8. What does not change

- The two kinds (schema views, sandboxed embeds), `UiView` blocks and `UI_LIMITS`, embed tokens
  (never valid for `/api`), the `/plugin-ui` proxy and its CSP sandbox, the message bridge.
- Inline cards stay display-only, recorded as `tool_result.card`, never model-visible; replays are
  unaffected. No `DriftReason`.
- Extensions stay in-process and full trust; approving `ui.embed:*` stays the sensitive step.

## 9. Tests

- SDK: catalog shape (ids unique, anchors known, versions positive), slot refs, validation of
  contributions (unknown slot, unsupported version, kind not accepted, missing required icon,
  unknown anchor).
- Kernel: an unknown-slot contribution is dropped and the extension still loads; the per-scope
  access rules on every route (a guest gets 404 `ui.not_found` for `org.page`, a member for
  `platform.page`); `agentId` passed to `agent.detail.section`; arrangement applied and limited to
  the org.
- `check:ui-slots` and `web-ui-extension-slot`: red fixtures.
- Testing package: `fake-tools-ui` moves to `slot` and gains contributions for the new slots.
- Web: an e2e test per new slot (contribution shown in the right place, hidden after an org admin
  hides it); the visual and fidelity suites cover `ExtensionSlot`'s empty / failed states where
  they are new.

## 10. Phases

1. SDK catalog and `slot` in the manifest; kernel validation and routes; today's places moved;
   `ExtensionSlot` in the conversation template; `check:ui-slots`; the plugins repository PR.
2. The new slots of §6 and the slot catalog route and `Platform` mirror.
3. Org and platform arrangement (hide, reorder) and its page.

## 11. Open questions for review

1. Is `slot` replacing `place` in the manifest (no alias, before 0.1.0) acceptable, given the
   plugins repository has to move in step (§4)?
2. Are the four new slots of §6 the right first set, or should the composer action row come
   first?
3. Org admins hide and reorder contributions per slot; should people be able to as well (§5)?
4. Should a contribution to an unknown slot fail the extension's load instead of being dropped
   with a warning (§3.2)?
