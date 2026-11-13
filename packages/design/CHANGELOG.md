# @capybara-hq/design

## 0.2.0-rc.8

### Patch Changes

- ba36733: Field `action`: a control that acts on the field's value (an 「添加」 button) sits on the control's
  line, the help and error below both; the device page's 「添加域名」 row uses it.
- e76028b: ScheduleCalendar: the scheduled task runs of a week or a month (time grid with a now line, three blocks side by side then +N, a dense lane, 6 × 7 month cells, the phone agenda, roving keyboard focus, loading, empty and load-failed states); the layout.calendar-* sizes and the ink / fail on hover and selected contrast pairs (also in the SDK's theme readability check)
- 8f08231: ScheduleCalendar: at most two overlapping blocks side by side in the week view (three left about
  51 px each, an icon and a clipped time); a larger cluster keeps one block and puts the rest in +N

## 0.2.0-rc.7

### Minor Changes

- e964b57: Network asks: when a command on a connected device is refused a domain by the device's local
  policy, the device owner is asked in the conversation or on the IM card (「这次允许 / 这台设备一直允许 /
  拒绝」). "This time" allows the domain for the rest of the run tree; "always" adds it to the device's
  local policy through the new `policy` device operation. Org-layer and address-layer refusals are
  explained to the model and shown under the command. Migration 0114 adds approval kinds and device
  policy summaries.
- 239555e: The device page gains a network section for the owner of a local device: the machine's allowed
  domains with remove, an add field that takes `*.` wildcards and whether the machine accepts changes
  from the platform (`remoteGrants`, set only on the machine). Opening the network is the sandbox
  level's 开放 (see the sandbox levels changeset). The device picker and the properties panel can mark
  a device (`PickerItem.badge`, `ContextSection.sandboxBadge`).

### Patch Changes

- 0f8f5bb: The agent page's 组织技能 and the agent template's 技能 group the skills by where they come from
  (each plugin, the org's own, the built-in ones), each group with a select-all box (checked/total,
  mixed) and a filter for long lists; each row is the name and its badges on one line and the
  description cut to one muted line with the full text on hover (new design `CheckList`). A badge
  never shrinks or wraps, and a checked disabled checkbox keeps its check visible.
- bfb35e3: Tool rows no longer read a Bash command's non-zero exit as a failure (only a timeout or a stopped
  command fails; the summary names the exit code), and an `Edit` / `Write` refused by the
  read-before-write check carries the display-only `tool_result.view.kind: "guard"`, shown as
  "Blocked: read the file (again) first" and counted apart from failures; the model still gets the
  same error result

## 0.2.0-rc.6

### Patch Changes

- 0dea20f: OverviewSection: one section of an overview page with its own loading, error and ready state
- 1c8fd12: TrendChart: a time series as stacked panels on one shared x-axis (crosshair, tooltip, keyboard, hidden table), and formatCompact for large numbers (en 3.4M, zh 340万)

## 0.2.0-rc.5

### Patch Changes

- 6ca55be: Browser review polish: plain links in tables draw in ink instead of the browser's link colour;
  a disabled ghost or icon button no longer gains a border; page header actions sit on the title
  line on every page; the status bar keeps 「第 N 轮 · 已用 …」 whole and shrinks the prompt first;
  the thread fades at its scroll edges; context lines never break inside a word; tab rows that do
  not fit fade where tabs are hidden; Markdown code blocks get a copy button and Markdown tables row
  lines and room; the extension tables' state, switch and 副本 columns fit their content (the 副本
  cells drop the repeated word). One localized duration format, `formatDuration` (replacing
  `runDuration`, `subagentDuration` and `elapsed`), so the status bar and the run row agree.
- 6a4ffff: New UI parts for theme plugins: `message.user.bubble`, `code-block`, `menu`, `segmented`,
  `stat-card`, `switch` (`aria-checked`) with `switch.knob`, `org-avatar` and `agent-chip`
  (`aria-pressed`); `message.assistant` promises `aria-busy` while its text streams, and the web sets
  it on the live reply. `UiPartState` gains `aria-checked` and `aria-pressed`.

## 0.2.0-rc.4

### Patch Changes

- d7476f2: While a run waits on your question, the composer says a message skips it (else that the message
  waits for the item above); a question skipped by a message reads 已跳过：直接回复了消息, a cancelled one
  已取消 (no longer 已跳过), and the trajectory viewer shows a skipped question with its message's seq.

## 0.2.0-rc.3

### Minor Changes

- 363a2d3: The design stylesheet declares the cascade layer order `@layer design, theme, extensions;` and
  puts every file in the `design` layer, so theme and plugin CSS win by layer, not by specificity
  or source order; the design's `!important` rules still beat theirs.
- f172ba6: Built-in elements carry the public `data-cap-part` hooks of the `UI_PARTS` catalog (`owner` is now a
  list of files, since one part can be drawn by several components); the design package adds
  `DecorationLayer`, `ReplaceableFrame` and `SafeModeBanner`, the `decoration` layering token,
  `Sidebar` `brand` and `AppShell` `capState` (`data-cap-state`). `check:ui-parts` enforces the hooks.
- 90e6e18: `AppShell` (and `SetupPage`) take a `banner`: a shell-wide row (safe mode's `SafeModeBanner`) drawn
  as the shell's first grid row across the sidebar and the content column, which share the rest of
  the window. In safe mode the web draws its banner there instead of above the 100dvh shell, so the
  status bar and the bottom of the page are no longer clipped.

### Patch Changes

- f437001: `Sidebar` takes `brand` as a function of the panel it is drawn in (`{ collapsed, panel: "full" |
  "rail" | "drawer" }`), called once per drawn panel. `ReplaceableFrame` takes a `ref`, and a pending
  frame is revealed by CSS alone after 1 500 ms (no `inert` / `aria-hidden`: `visibility` already takes
  hidden content out of focus and the accessibility tree), so a pending frame the server drew never
  stays hidden.
- 08b3e72: `ComposerBox` takes `frame={false}`: the composer's inputs without the frame's box
  (`ComposerFrame bare`, `data-frame="bare"`, the same `composer` part), for a plugin's frame drawn
  around the composer.
- 60a8d66: `DecorationLayer` no longer puts `aria-hidden` on the whole layer: it hides each decoration element
  from assistive tech and leaves interactive ones (marked `data-cap-interactive`, or focusable) and
  their ancestors exposed, keeping up with the plugins' later DOM changes, so an interactive element
  never sits under `aria-hidden`.
- 99a970a: `IconButton` carries the `button` UI part (`button button.primary` for the primary variant) like
  `Button`, so plugin CSS on `[data-cap-part~="button"]` reaches every button, the composer's send and
  stop among them.
- 9d72577: The sidebar's breakpoints are exported once (`SIDEBAR_RAIL_QUERY`, `SIDEBAR_DRAWER_QUERY`), and the
  App Shell's `sidebar=` state token reads them through the sidebar instead of repeating the widths.
- e531e6d: The SDK exports `UI_PARTS`, the catalog of built-in elements (`data-cap-part`) plugin CSS may
  select; `capybara-plugin check` reports `ui-part-unknown` against it.
- 8c49d09: The shell element publishes `run=`, `theme=<plugin>/<file id>`, `motion=` and `sidebar=rail|full` in
  `data-cap-state`; the open conversation's log is turned into client events on the client (history
  loaded on open emits nothing). `ThemeRef` gains `key`.

## 0.2.0-rc.2

### Patch Changes

- 098c38c: One name: devices. The 环境 / Environments page is now 设备 / Devices at `/devices` and
  `/devices/[id]`; 新建设备 offers 云端 / 本地 (cloud and local devices). The sign-in confirmation
  page moves from `/device` to `/devices/link`; `/device` and `/environments` are the app's 404. The
  composer's picker, the properties panel and all copy say 设备 / device. The design system's
  composer picker prop `pickers.environment` is now `pickers.device` (reference blocks
  `composer-device` and `composer-device-locked`).

## 0.2.0-rc.1

### Minor Changes

- 789068d: The composer takes an `environment` picker between the agent and the model (locked after the first
  message), and `PickerItem.disabled` marks a choice that cannot be picked.

### Patch Changes

- 3c45446: Agents gain the `Platform` builtin tool, on for new agents: an agent browses, searches and describes
  the platform's operations, calls them as the person who started the run, and reads the agent docs.
  Operations cover skills, agents, agent templates, plugins, marketplaces, requests, connectors and
  extensions (`skills.*`, `agents.*`, `plugins.*`, ...); results never carry secrets, and a super admin
  sees other orgs as counts only. Reads run; writes ask the person to confirm, and org and platform
  writes are confirmed every time and never remembered (`approval.scope_not_allowed` for any other
  scope). Tool policies can be keyed per call (`Platform:<operation>`); an approval stores its
  kernel-rendered summary (zh and en) and runs only with the exact input it showed. Confirmations show
  the operation and the summary on the web and in IM cards, and offer only the scopes the approval
  allows. Orgs gain the `platformTool` setting (`on` / `read-only` / `off`, default on) on the
  organization settings page; writes are unavailable when no person is present. Audit events of writes
  made through the tool carry `{ via: "agent", conversationId, runId, operation }`. `describe` lists an
  operation's notable errors and paged lists take `params.cursor`. `check:platform-ops` fails a kernel
  HTTP route that has neither an operation nor a reasoned exclusion.

## 0.1.1-rc.0

### Patch Changes

- 15af7fd: Server-rendered times no longer break hydration. Until a page has hydrated it writes relative ages
  ("现在", "1 分钟前"), running durations and local dates with the clock and time zone of the server
  render, then switches to the browser's: an age that crossed a minute between the server render
  and the hydration, or a viewer in another time zone, used to fail hydration (Next's error overlay
  in development) or keep the server's times. The browser's time zone is saved in the `cb-tz`
  cookie, so later server renders write dates in the viewer's zone.
