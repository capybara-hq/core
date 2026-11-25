# Browser tabs owned per conversation

Status: design, 2026-11-25, revised after the design review of core#853 the same day. Amends the
browser use spec ([2026-11-23-browser-use-design.md](2026-11-23-browser-use-design.md)) §5, §6.2,
§8, §9 and §10. Maintainer decision (2026-11-25): tabs are owned per conversation; one daemon, one
Chromium and one profile per device stay.

## 1. Why

One daemon serves every conversation on a device and keeps one "active tab" for all of them
(`BrowserSession.active` in `plugins/browser/daemon/actions.ts`). Every tool acts on that tab, so
two conversations browsing at once navigate, click and type into each other's page; `tabs list`
and every panel show every tab; a popup from one conversation's page becomes the active tab of
all of them; notes (dialogs, downloads, popups closed at the cap) and refused hosts ride
whichever conversation's reply comes next (`BrowserSession.unreported`, `Collector.blocked`); and
one pending handoff is dropped by a tool call from any conversation (`DaemonState.dropHandoff`).
The shared profile (logins, cookies) is the part worth sharing; the tabs are not.

## 2. Goals and non-goals

Goals:

1. A conversation acts only on the tabs it owns. Each conversation has its own active tab; its
   first acting call gets a tab of its own.
2. The panel shows the tabs of its conversation's tree (the conversation and its sub-agent
   conversations) by default, and everything a sub-agent asks the person (a handoff) reaches the
   panel the person actually looks at.
3. A conversation can take over another tree's tab when asked to (the person signed in in one
   conversation's panel and wants another conversation to use that page).
4. Takeover stays per device; tabs of a conversation that stopped using the browser are closed;
   the profile is never touched by any of this.
5. The conversation (and its tree) a request or viewer acts for comes only from the kernel: the
   tool call context, or the viewer ticket. Never from tool input or panel input.

Non-goals: separate profiles, cookie jars or Chromium processes per conversation (rejected by the
maintainer: logins stay shared); hiding one conversation's tabs from another as a security
boundary (every conversation on a personal device is the same person's, spec §5, and the person
can drive every tab during a takeover); a kernel record of tabs (the daemon stays the one place
that knows them, spec §10).

## 3. The conversation of a request and of a viewer

Owning and seeing are keyed differently: a tab is **owned** by one conversation (the one that
acts on it) and **seen** by its owner's tree, whose root is the conversation the person looks at
(a sub-agent's questions are shown in the root, `rootSurfaceOf` in
`kernel/src/runtime/subagents/child.ts`).

- **Tool requests (core change: `ToolCallContext.rootConversationId`).** The kernel sets
  `ToolCallContext.conversationId` for every tool call, and now also `rootConversationId`, the
  root of the call's conversation tree (the kernel computes it already for device access:
  `callScope.facts.rootConversationId`; equal to `conversationId` outside sub-agents). The plugin
  server adds both to every daemon request (`ToolRequest` gains top-level `conversationId` and
  `rootConversationId`, written by `runRequest` in `src/browser.ts` from `call`, never from
  `input`). A request without them is refused (`failed`, "the request names no conversation").
- **Trust of the request socket.** The daemon trusts these fields as it trusts the connection:
  the socket is reached only through `ctx.deviceAccess.request` of the browser extension (full
  trust, browser use spec §7). That holds on docker / e2b with plugins#226 (services run as their
  own user `capybara-svc`, socket directory 0700) and on device-local because the operation worker
  grants `allowUnixSockets` only to services; wave 2 depends on #226.
- **Viewer streams (core change: the viewer context message).** The panel's stream reaches the
  daemon through the kernel's viewer relay (`packages/kernel/src/device-access/viewer.ts`), which
  today forwards the panel's bytes unchanged. On the service socket the provider's
  `{"kind":"stream"}` is the first message; the kernel now writes the first **stream** message
  itself, after the provider stream opens (`openLocal`, the one place a provider stream opens, on
  the direct path and after a hop) and before it starts relaying the panel's messages (`pump`;
  `WsEnd` buffers the panel's early bytes until then):
  `{"kind":"viewer","conversationId":"<ticket's>","rootConversationId":"<its root>"}`. The
  ticket's conversation is the embed caller's (`DeviceStreamTicket.conversationId`, from the
  kernel-signed embed token, owner-checked at mint by `scopedDevice` and on every `ticketCheck`);
  `scopedDevice` already computes the root, the ticket records it, and the hop record's MAC
  covers it. Because the kernel writes it first, the service takes the first stream message as
  the kernel's; a later `{"kind":"viewer"}` (the panel's) is never read as context. The SDK's
  device service protocol (`packages/plugin-sdk/src/device-service.ts`) documents the message and
  exports its shape (`DeviceServiceViewerContext`) and a parser; providers and the device program
  pass it through like any stream message and change nothing.
- A daemon stream whose first stream message is not the viewer context is closed. No
  compatibility with a kernel that does not send it (pre-0.1.0): the browser plugin release that
  needs it raises the manifest's `sdk` range (§9).

## 4. Tabs, owners and the active tab (daemon)

- Every tab records `{ owner, root }` (a conversation id and its tree's root) or is unowned.
  `BrowserSession` keeps that map and `active: Map<conversationId, tabId>` in place of the single
  `active`.
- **Acting requests** (navigate, snapshot, screenshot, the element and coordinate actions, wait,
  `tabs open` / `switch` / `close`) act on the conversation's active tab. When the conversation
  has no live tab, the daemon gives it one: an unowned tab if there is one (the blank tab
  Chromium starts with), else a new tab (subject to the caps). So a conversation's first acting
  call never lands in another conversation's page.
- **Non-acting requests never open a tab:** `tabs list`, `tabs adopt`, `handoff_notice` and
  `handoff_clear`. The reply's `page` becomes optional; with no tab the result says "This
  conversation has no browser tab yet."
- When a conversation's active tab closes, its active tab becomes its most recently opened
  remaining tab; with none left, the next acting request gets a new one.
- **`tabs list`** lists the conversation's own tabs, then its tree's other tabs (sub-agent or
  parent conversations, which it may not drive; "Tabs of other conversations in this task"),
  then other trees' tabs ("Tabs of other conversations on this device"), with a closing line
  "use action adopt to take one over". The sections outside the conversation's own carry ids,
  titles clipped to 120 characters and URLs without query or fragment (a page of another
  conversation is text from outside this one: a prompt injection path, kept short); no
  conversation ids, which mean nothing to the model.
- `tabs switch` and `tabs close` accept only the conversation's own tabs; any other tab is
  refused with "Tab t3 belongs to another conversation; call browser_tabs with action adopt and
  tabId t3 first if the user asked you to use it."
- **Adopt** (new `browser_tabs` action `adopt` with `tabId`): moves the tab to the calling
  conversation (owner and root) and makes it its active tab. Ownership moves, it is not shared:
  two conversations driving one page is the collision this design removes. Refused while the
  current owner is **in use**: it has a request in flight (from the request's arrival to its
  reply, queued requests and `wait`, which runs outside the queue, included) or a pending park
  (§6) ("Tab t3 is in use by another conversation right now; retry shortly or open your own
  tab."). The previous owner's next reply carries a note: "Tab t3 (title) was moved to another
  conversation." An unowned tab can be adopted too.
- **Popups** belong to the owner of the page that opened them, attributed from the opener side:
  every tracked page listens to Playwright's `page.on("popup")`, which fires on the opener for
  `noopener` popups too (the default for `target="_blank"` links); a page whose opener the
  session cannot find (opened by the browser itself) stays unowned, never guessed. A popup
  becomes its owner's active tab, as today.
- **Tabs the person opens** in a panel (`+`, in control) belong to that panel's conversation and
  become its active tab.
- **Caps.** `MAX_TABS` (10) stays a device-wide cap (Chromium memory inside the device, spec §5),
  and a conversation may own at most `MAX_TABS_PER_CONVERSATION` (6). At the device cap, before
  refusing, the daemon closes one tab of a conversation that is evictable: not in use (no request
  in flight, no pending park, not pinned by a viewer, see below) and with no request for at least
  `EVICT_MIN_IDLE_MS` (5 minutes; an agent between two tool calls, while its model generates, is
  never evicted). Among evictable owners it picks the least recently used one, and closes that
  owner's least recently used non-active tab before its active tab. It notes the close to the
  owner ("Tab t4
  (title) was closed to make room for another conversation."). It refuses only when no tab
  qualifies: with own tabs "The browser has 10 tabs open, the most it keeps (3 are this
  conversation's); close one of yours first."; with none "Other conversations hold all 10 tabs
  of the browser; retry later or ask the user to close one in the browser panel." At the
  per-conversation cap: "This conversation has 6 tabs open, the most one conversation keeps;
  close one first."
- **What a viewer pins.** An open viewer counts as use only for its own conversation and for the
  owner of the tab it currently shows; the other conversations of its tree idle and are evictable
  as usual (their tabs stay listed in its strip until they close). So a root panel left open for a
  whole task does not keep finished sub-agents' tabs.
- **Notes, refused hosts and events by owner.** A dialog, a download, a refused host, a file
  chooser or a popup closed at the cap belongs to its page's owner: its note goes to that
  conversation's request in flight, else its next reply (`unreported` becomes per conversation),
  and its refused hosts go into that conversation's reply `blockedHosts` only (so the kernel's
  network ask from `reportBlockedHosts` appears in the conversation whose page was refused).
  `blocked` and `dialog` viewer messages and `lastClick` go to the viewers of the owner's tree.
- **Concurrency.** The single action queue (`BrowserSession.serial`) becomes one queue per
  conversation, so one conversation's 30 s navigation does not stall another, provided background
  tabs render (ruling 7, plan task 0). Device-wide state (the download cap, the takeover) stays
  device-wide. Agent paths no longer call `bringToFront`, which would change what another
  conversation's viewer sees; what is front is decided only by a viewer in control.

## 5. Takeover, handoff and the panel

- **Takeover stays per device** (spec §9, §10): while the person controls the browser from any
  conversation's panel, agent requests from every conversation are refused as today.
- **The hand back note** (spec §9) goes to each conversation that owned a tab when the takeover
  began or whose tab the person used (input, navigation or a new tab) during it, once, on its next
  ok reply. Conversations that had no tab then, or started later, are not told (it would be false).
  `DaemonState` keeps, per takeover, the set of conversations to tell, cleared as each is told.
- **Handoff becomes per conversation, seen by the tree.** `handoff_notice` / `handoff_clear` carry
  the request's conversation; the daemon keeps at most one pending handoff per conversation. A
  tool request drops only its own conversation's pending handoff (today any conversation's request
  drops it). A viewer's `state.handoffs` lists the pending handoffs of its tree, each with its
  `callId`, its `conversationId` (from the trusted request; an opaque id the panel only echoes,
  never shown to the model or the person) and its conversation's tab ids; the banner shows the newest. The keepalive (`HANDOFF_KEEPALIVE_MS`)
  counts from the oldest pending notice.
- **The panel's Done from the root (core fix).** `/ui/handoff-answer` calls
  `ctx.deviceAccess.answerHandoff` with the embed caller's conversation, and the kernel today
  looks the question up only in that conversation, while a sub-agent's question row carries the
  sub-agent's conversation (`questions.service.ts` `askIn`), so Done from the root panel answers
  `question.not_found`. `callId` is unique only within its run, so two sub-agents of one
  tree may have pending handoffs with the same `callId`; a lookup by `callId` across the tree could
  resume the wrong one. So the panel echoes the handoff's `conversationId` in
  `/ui/handoff-answer`, `ctx.deviceAccess.answerHandoff` takes it (`handoffConversationId`), and
  the kernel checks that it is the scope conversation or one of its descendants, then queries the
  pending question by `(conversation_id, call_id)` exactly (same extension check, same owner
  rules).
- **Panel: what it shows.** `ViewerOut.state.tabs` lists the viewer's tree: its own conversation's
  tabs first, then one group per other conversation of the tree (labelled "子任务" / "Sub-task"
  with its tabs; no conversation names, which the daemon does not know). A new `state.otherTabs:
  { id, title, url }[]` lists other trees' tabs, without the per-tab detail of the tree's tabs
  (no `blocker`, plugins#226, and no verification state, `fix/browser-panel-mode`). Each viewer
  has its own **shown tab**, a viewer-local choice (it moves no ownership and no agent's active
  tab): by default its own conversation's active tab; with none, the active tab of the tree's
  conversation that acted last; on a new handoff, the handoff's conversation's active tab.
  Choosing a tab of the tree in the strip changes the shown tab (allowed in the watch state: it is
  not page input). When the tree owns no tab yet but the browser runs, the panel shows its empty
  state ("智能体尚未在此对话中打开网页" / "The agent has not opened a page in this conversation
  yet") with the other-conversations menu, not another tree's page.
- **Panel: what it does.** Input, navigation and `+` / `switch` / `close` stay control-only
  (plugins#230's read-only watch state) and act on the shown tab, which may be a sub-agent's: the
  person driving a sub-agent's page moves no ownership. In control, a `switch` to a tab of the viewer's
  own conversation also makes it that conversation's active tab (the person chose it, as today); a
  `switch` to a tab another conversation of the tree owns changes only the shown tab, never that
  sub-agent's active tab, so its next action still lands on the page of its last result. If the
  person then uses that tab, the sub-agent is told by the hand back note (it is a conversation
  whose tab the person used). When `otherTabs` is not empty, a small
  "其他对话 (N)" / "Other conversations (N)" menu lists them, each with "移到此对话" / "Move here",
  which sends `{ t: "tab", action: "adopt", tabId }` (the tool's adopt rules, and only for other
  trees' tabs: a viewer adopt of a tab in its own tree is ignored, since inside the tree the person
  drives tabs without moving them). Adopt is an
  ownership change, not page input, so it is allowed in the watch state too: a carve-out in
  #230's input gate for `action: "adopt"` only. A refused adopt (owner in use) comes back as a
  new `{ t: "notice", code: "tab_in_use" }` viewer message, which the panel shows as a short,
  i18n'd line ("该标签页正被其他对话使用，请稍后再试" / "Another conversation is using this tab;
  try again shortly").

## 6. Closing a conversation's tabs

- **Parks.** A conversation has a pending park while it waits without a model turn on the browser:
  a pending handoff, a parked long wait (plugins#207, long waits as a suspension: the park ends on
  `watch_end`, on the watch's heartbeat drop and on its eviction at `MAX_WATCHES`), or a held decision
  dialog on one of its tabs (plugins#208: until it is answered or its tab closes; it pins only that
  tab: idle close skips it and closes the conversation's other tabs as usual, eviction and adopt skip
  it). (amended
  2026-11-25 by `2026-11-25-browser-long-waits-design.md` and
  `2026-11-25-browser-dialogs-and-touch-design.md`) The daemon
  tracks parks per conversation like handoffs. A pending park keeps the conversation's tabs, counts
  as in use for adopt and for the cap eviction, and keeps an otherwise idle daemon alive under the
  handoff keepalive.
- **Idle close.** A conversation's tabs close when, for `CONVERSATION_IDLE_MS` (15 minutes, equal
  to the daemon's own idle stop, `IDLE_STOP_MS`), it has made no request, no viewer has pinned it
  (§4: a viewer pins its own conversation and the owner of the tab it shows) and it has no pending
  park. A conversation alone on its device behaves as today: the
  daemon's idle stop comes first. The timer is the daemon's (spec §10: the daemon keeps its own
  timers inside the device). Idle close also deletes the conversation's per-conversation state
  (its active entry, queue, `unreported` notes, handoff and park, hand back flag, counters), so the
  maps stay bounded by the live conversations.
- **Deleted conversations** are not signalled to the daemon: no lifecycle hook tells an extension
  that a conversation was deleted, and `ctx.deviceAccess` refuses a deleted conversation, so no
  call could reach the device for it anyway. The kernel already closes a deleted conversation's
  viewer streams (`viewer.ts`); with no requests and no viewer, its tabs close by the idle close
  within 15 minutes (or earlier, by the cap eviction).
- Closing tabs never touches the profile (cookies, storage).
- **Session file** (`daemon/session-file.ts`, a restart moments ago restores tabs): each saved tab
  carries its owner and root, the active tab, handoff and park are saved per conversation, and a
  restore gives each tab back to its owner. An older file is not restored (pre-0.1.0; the next
  start begins with one blank tab, as when a file is too old).

## 7. Rulings

1. **Adopt is an action of `browser_tabs`, not a new tool or a parameter on every tool.** It is a
   tab operation like switch and close, it keeps the tool list unchanged, and a per-tool `tabId`
   would let every call silently act on another conversation's page. The agent learns other tabs
   exist from `tabs list`, which lists them under their own headings and never opens a tab. Cost
   if wrong: an agent that should reuse a page does not think to list tabs; the person can move the
   tab from the panel (§5), and the tool description says to list tabs when the user points to a
   page they opened.
2. **Adopt moves ownership; it does not share.** Sharing brings back two conversations driving
   one page. Cost if wrong: the previous owner loses the tab and must open a new one, which its
   note tells it.
3. **Owned per conversation, seen per tree** (revised after review C1). Ownership, active tab and
   queue are the call's own conversation's, so parallel sub-agents do not collide; visibility,
   handoffs, events and the panel's Done follow the tree's root, the conversation the person looks
   at. This needs `ToolCallContext.rootConversationId` (SDK public API), the root in the viewer
   context, and `answerHandoff` searching descendants. The rejected fallback, owner = root with an
   active tab per conversation, needs only the root in the call context but lets parallel
   sub-agents of one task close or clobber each other's tabs. Cost if wrong: one more SDK field
   and a kernel query change where the fallback would have done.
4. **The viewer's conversation and root come from a kernel-written first stream message**, not
   from the panel's `hello` (which the panel could fill from the ticket route's answer). The
   panel's input is not trusted for whose tabs it sees, matching the rule that tool calls take the
   conversation from the kernel; a route handler has no tool call context, so the plugin server
   cannot register a viewer with the daemon itself. Cost if wrong: a small core change where a
   panel-supplied id would have done for a filter that is not a security boundary.
5. **Idle close after 15 minutes without requests, a pinning viewer or a park; no deletion
   signal.** A viewer pins only its own conversation and the owner of the tab it shows (re-review
   N3), so an open root panel does not keep finished sub-agents' tabs. It equals the daemon's own idle stop, so a busy device does not keep a silent
   conversation's tabs longer than an idle device would. Cost if wrong: a deleted conversation's
   tabs linger up to 15 minutes (or until the cap evicts them); a person returning after 15
   minutes to a conversation whose device stayed busy finds its pages closed (the login survives
   in the profile).
6. **Caps: 10 per device, 6 per conversation, eviction at the device cap only of owners not in use
   and idle for at least 5 minutes, non-active tabs first, else refuse** (revised after review I3
   and re-review N1). The device cap protects shared memory; the
   per-conversation cap and the eviction keep one conversation (or one task's sub-agents) from
   locking the others out until the idle close. Cost if wrong: a tab the person meant to come back
   to is closed to make room; its owner is told, and the login survives in the profile.
7. **Per-conversation action queues, no `bringToFront` on agent paths, gated on a spike** (revised
   after review I4). Actions on different pages are independent in Chromium only if background
   tabs keep rendering; with the full Chromium (plugins#226 on Linux, #231 on macOS) a hidden tab
   may stop producing frames, stalling another conversation's viewer and screenshots. Plan task 0
   proves both launch plans before wave 2; if a plan stalls, each conversation's tabs open in a
   window of their own (`Target.createTarget` with `newWindow: true`) or the renderer
   backgrounding flags are set explicitly, and this ruling records which. Cost if wrong: falling
   back to one queue is a one-line change; a stalled screencast is what the spike exists to catch.
   **Spike result (2026-11-26): per-conversation queues work as they are.** One Chromium, one
   context, two animating tabs each with a screencast, no `bringToFront` between: on the Linux
   plan (Chromium 159 full build in new headless mode, in the device-docker sandbox image with its
   container settings) and on the macOS plan (the full Chromium of #231 under the device-local
   launch) the non-front tab kept about 60 frames per second, ran `requestAnimationFrame` about
   60 times per second, stayed `visible`, and answered `page.screenshot` as fast as the front tab
   (about 33 ms). No separate windows and no extra flags: Playwright's default switches already
   disable timer throttling, renderer backgrounding and occluded-window backgrounding; without
   them macOS background screenshots slowed to 50–160 ms. So the daemon never launches with an
   `ignoreDefaultArgs` that drops them (a daemon test asserts it). Not measured: more than two
   tabs, runsc or e2b, the device-local seatbelt.
8. **Handoff per conversation and seen by the tree; takeover per device.** A handoff is one
   conversation's question that the person answers from the root; a takeover is the person holding
   the one browser. Cost if wrong: none known beyond the session file format.
9. **Adopt and the shown tab are allowed in the watch state; page input is not** (review I1).
   Adopt is an ownership change and the shown tab is a viewer-local choice; requiring a takeover
   for them would refuse every other conversation's agent while the person only moves a tab.
   Cost if wrong: a person can move a tab away from a conversation they are not watching closely;
   adopt is refused while that conversation is in use, so no action is cut off mid-way.
10. **Popups attributed from the opener side or left unowned** (review I2). Guessing from the
    request in flight is ambiguous once queues are per conversation. Cost if wrong: a popup the
    browser opened by itself stays unowned until a conversation's first call or an adopt claims it.
11. **A handoff answer names its conversation** (re-review N2). The panel echoes the trusted
    `conversationId` the daemon recorded, and the kernel checks it against the scope's tree before
    looking up `(conversation_id, call_id)`. Refusing when several questions match was the
    alternative; it would leave the person unable to answer either. Cost if wrong: one more field
    on `answerHandoff` (SDK public API).
12. **Inside its tree a viewer drives tabs but never moves ownership or a sub-agent's active tab**
    (re-review N4, N5). Cost if wrong: a person who wants a sub-agent to continue on another of its
    tabs must tell it in the conversation.
13. **The hand back note goes only to conversations whose tabs the takeover concerned** (review
    M5). Telling every conversation would put a false statement into the model's context. Cost if
    wrong: a conversation whose page changed indirectly (a shared login expiring) is not told.

## 8. Replay

Every new model-visible text (the notes, the list headings, the refusals, the cap and eviction
messages, the "no tab yet" line, the `adopt` description) is a tool result or the tool
description, logged in the conversation's event log. Nothing is injected by the kernel outside a
tool result, so no `DriftReason` is needed. `rootConversationId` in the call context is not
model-visible.

## 9. Testing

- Plan task 0 (spike, before wave 2): two conversations, each with a viewer, both pages animating;
  frames arrive on both streams and a screenshot of the non-front tab returns, on both launch
  plans (full Chromium in new headless mode as of plugins#226; the macOS build of #231).
- Daemon unit tests (fake clock, real headless browser as the existing daemon tests do): two
  conversations navigate concurrently and each reply reports its own page; `tabs list` sections,
  clipping, and that it opens no tab; switch / close of another's tab refused; adopt and its note,
  refused while the owner has a queued request, while it runs `wait` and while it has a park;
  a `target=_blank rel=noopener` link and a `window.open(…, "noopener")` clicked in A while B has
  a request in flight both become A's tabs; the first acting call claims the blank tab, the second
  gets a new one; both caps, the eviction and its note, the refusal with 0 own tabs; a conversation that made a
  request a moment ago is never evicted, and an evictable owner loses a non-active tab before its
  active one; notes and
  refused hosts routed to the owner (B gets no network ask for A's host); per-conversation handoff
  drop; a sub-agent's handoff shown to the root viewer; the hand back note only to the concerned
  conversations; idle close with and without a viewer, handoff or park, and the per-conversation
  state gone after it; a finished sub-agent's tab closes after `CONVERSATION_IDLE_MS` while the
  root panel stays open (showing another tab); session file round trip with owners; a request without a conversation
  refused; a stream without the viewer context closed; a second `{"kind":"viewer"}` from the panel
  changes nothing.
- Viewer / panel tests: the strip shows the tree's groups and the other-conversations menu; the
  shown tab follows a new handoff; adopt from a watching viewer moves another tree's tab while `switch` from a
  watching viewer is still dropped; a viewer adopt of a tab of its own tree is ignored; in control,
  a `switch` to a sub-agent's tab changes the shown tab but not the sub-agent's active tab, and the
  sub-agent is told by the hand back note only if the person used the tab; `state.handoffs` carries
  each handoff's `conversationId`; a refused adopt shows the notice; the empty state when the tree
  owns no tab.
- Plugin server tests: `runRequest` sends `call.conversationId` and `call.rootConversationId`,
  never input fields.
- Kernel: the viewer relay test sends viewer bytes before the device-fake stream opens and asserts
  the context (with the ticket's conversation and root) is still the first stream message, on the
  direct path and after a hop; `ToolCallContext.rootConversationId` for a root call and a
  sub-agent call; `answerHandoff` from the root's scope answers a sub-agent's question by
  `(handoffConversationId, callId)`; with two sub-agents of one tree pending under the same
  `callId`, the named one is answered and the other stays pending; it still
  refuses another tree's or another extension's question.

## AGENTS.md rules touched

- **Device access (`ctx.deviceAccess`)**: the kernel's viewer relay now writes one message of its
  own (the viewer context: the ticket's conversation and its root) as the first stream message of
  every viewer stream; otherwise the stream stays opaque. `answerHandoff` takes the handoff's
  conversation, checks it is the scope conversation or a descendant, and looks the question up by
  `(conversation_id, call_id)`. The rule line gains: "a viewer stream starts with
  the kernel's viewer context message".
- **Public API reports**: `ToolCallContext.rootConversationId`, `answerHandoff`'s
  `handoffConversationId`, and the viewer context shape and
  parser in the device service protocol: `pnpm gen:sdk-api` plus a changeset on
  `@capybara-hq/plugin-sdk`.
- **Multi-replica discipline**: unchanged; tab ownership, parks, idle close and handoff state live
  in the daemon inside the device (spec §10), no kernel record.
- **Runtime and replay**: no new kernel-injected model input (§8).
- **Tools**: `browser_tabs` gains `adopt`; English description and actionable errors
  (writing-tools).
