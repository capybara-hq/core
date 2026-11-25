# Browser tabs owned per conversation

Status: design, 2026-11-25. Amends the browser use spec
([2026-11-23-browser-use-design.md](2026-11-23-browser-use-design.md)) §5, §6.2, §8, §9 and §10.
Maintainer decision (2026-11-25): tabs are owned per conversation; one daemon, one Chromium and one
profile per device stay.

## 1. Why

One daemon serves every conversation on a device and keeps one "active tab" for all of them
(`BrowserSession.active` in `plugins/browser/daemon/actions.ts`). Every tool acts on that tab, so
two conversations browsing at once navigate, click and type into each other's page; `tabs list`
and every panel show every tab; a popup from one conversation's page becomes the active tab of
all of them; notes (dialogs, downloads, popups closed at the cap) ride whichever conversation's
reply comes next (`BrowserSession.unreported`); and one pending handoff is dropped by a tool call
from any conversation (`DaemonState.dropHandoff`). The shared profile (logins, cookies) is the
part worth sharing; the tabs are not.

## 2. Goals and non-goals

Goals:

1. A conversation sees and acts only on the tabs it owns. Each conversation has its own active
   tab; its first browser call gets a tab of its own.
2. The panel shows the tabs of its conversation by default.
3. A conversation can take over another conversation's tab when asked to (the person signed in
   in one conversation's panel and wants another conversation to use that page).
4. Takeover stays per device; tabs of a conversation that stopped using the browser are closed;
   the profile is never touched by any of this.
5. The conversation a request or viewer acts for comes only from the kernel: the tool call
   context, or the viewer ticket. Never from tool input or panel input.

Non-goals: separate profiles, cookie jars or Chromium processes per conversation (rejected by the
maintainer: logins stay shared); hiding one conversation's tabs from another as a security
boundary (every conversation on a personal device is the same person's, spec §5, and the person
can drive every tab during a takeover); a kernel record of tabs (the daemon stays the one place
that knows them, spec §10).

## 3. The conversation of a request and of a viewer

- **Tool requests.** `ToolCallContext.conversationId` is set by the kernel for every tool call.
  The plugin server adds it to every daemon request it sends (`ToolRequest` gains a top-level
  `conversationId`, written by `runRequest` in `src/browser.ts` from `call.conversationId`, never
  from `input`). The request socket is reached only through `ctx.deviceAccess.request` of the
  browser extension (full trust, spec §7), so the daemon trusts the field as it trusts the
  connection. A request without it is refused (`failed`, "the request names no conversation").
- **Viewer streams (core change).** The panel's stream reaches the daemon through the kernel's
  viewer relay (`packages/kernel/src/device-access/viewer.ts`), which today forwards the panel's
  bytes unchanged, so the daemon cannot tell which conversation a viewer belongs to. The kernel
  now writes one message of its own into every viewer stream it opens, right after the provider
  stream opens and before it relays any viewer byte:
  `{"kind":"viewer","conversationId":"<the ticket's conversation>"}`. The ticket's conversation
  is the embed caller's (`DeviceStreamTicket.conversationId`, checked against the owner at mint
  and on every re-check). Because the kernel writes it first, the service takes the first message
  of a viewer stream as the kernel's; a panel cannot forge it (its own `hello` comes after). The
  SDK's device service protocol (`packages/plugin-sdk/src/device-service.ts`) documents the
  message and exports its shape (`DeviceServiceViewerContext`) and a parser; providers and the
  device program pass it through like any stream message and change nothing. The message is
  written on whichever replica opens the provider stream, the hop target included.
- A daemon stream whose first message is not the viewer context is closed. No compatibility with
  a kernel that does not send it (pre-0.1.0): the browser plugin release that needs it raises its
  `@capybara-hq/plugin-sdk` range to the SDK that documents it.

## 4. Tabs, owners and the active tab (daemon)

- Every tab has at most one owner: a conversation id. `BrowserSession` keeps `owner: Map<tabId,
  conversationId>` and `active: Map<conversationId, tabId>` in place of the single `active`.
- A request acts on its conversation's active tab. When the conversation has no live tab, the
  daemon gives it one: an unowned tab if there is one (the blank tab Chromium starts with), else
  a new tab. So a conversation's first call never lands in another conversation's page.
- When a conversation's active tab closes, its active tab becomes its most recently opened
  remaining tab; with none left, the next request gets a new one (as above).
- `tabs list` lists the conversation's own tabs, then, under a separate heading, the other
  conversations' tabs on the device (id, title, URL; no conversation ids, which mean nothing to
  the model): "Tabs of other conversations on this device (use action adopt to take one over):".
- `tabs switch` and `tabs close` accept only the conversation's own tabs; another conversation's
  tab is refused with "Tab t3 belongs to another conversation; call browser_tabs with action
  adopt and tabId t3 first if the user asked you to use it."
- **Adopt** (new `browser_tabs` action `adopt` with `tabId`): moves the tab to the calling
  conversation and makes it its active tab. Ownership moves, it is not shared: two conversations
  driving one page is the collision this design removes. Refused while the current owner has a
  request in flight ("Tab t3 is in use by another conversation right now; retry shortly or open
  your own tab."). The previous owner's next reply carries a note: "Tab t3 (title) was moved to
  another conversation." An unowned tab can be adopted too.
- **Popups** belong to the owner of the page that opened them (Playwright `page.opener()`); a
  popup without an opener belongs to the conversation of the request in flight, else to the
  conversation of the most recent request. A popup becomes its owner's active tab, as today.
- **Tabs the person opens** in a panel (`+`) belong to that panel's conversation and become its
  active tab; the panel's address bar, back / forward / reload, clicks and keys act on the
  viewer's conversation's active tab.
- **Cap.** `MAX_TABS` (10) stays a device-wide cap (Chromium memory inside the device is the
  reason, spec §5). The refusal says how many of the tabs are the caller's: "The browser has 10
  tabs open, the most it keeps (3 are this conversation's); close one of yours first." Other
  conversations' tabs are freed by the idle close (§6).
- **Notes and events by owner.** A dialog, a download, a refused host, a file chooser or a popup
  closed at the cap is noted to its page's owner only: to that conversation's request in flight,
  else its next reply (`unreported` becomes per conversation). `blocked` and `dialog` viewer
  messages and `lastClick` go only to the viewers of the owning conversation.
- **Concurrency.** The single action queue (`BrowserSession.serial`) becomes one queue per
  conversation: actions on different pages do not wait for each other (one conversation's 30 s
  navigation no longer stalls another). Device-wide state (the download cap, the takeover) stays
  device-wide.

## 5. Takeover, handoff and the panel

- **Takeover stays per device** (spec §9, §10): while the person controls the browser from any
  conversation's panel, agent requests from every conversation are refused as today.
- **The hand back note** (spec §9) goes to every conversation once: each conversation's first ok
  reply after a hand back carries "The user controlled the browser from …" (today the first reply
  of any conversation takes it and the others never learn). `DaemonState` keeps the last takeover
  start and the set of conversations already told, cleared at the next takeover.
- **Handoff becomes per conversation.** `handoff_notice` / `handoff_clear` carry the request's
  conversation; the daemon keeps at most one pending handoff per conversation. A tool request
  drops only its own conversation's pending handoff (today any conversation's request drops it).
  A viewer's `state.handoff` is its conversation's. The keepalive (`HANDOFF_KEEPALIVE_MS`) counts
  from the oldest pending notice. The panel's handoff answer already goes through the kernel with
  the embed caller's conversation (`ctx.deviceAccess.answerHandoff`), so nothing changes there.
- **Panel.** `ViewerOut.state.tabs` lists only the viewer's conversation's tabs; a new
  `state.otherTabs: { id, title, url }[]` lists the rest of the device's tabs. The tab strip shows
  the conversation's tabs; when `otherTabs` is not empty, a small "其他对话 (N)" / "Other
  conversations (N)" menu at the end of the strip lists them, each with "移到此对话" / "Move
  here", which sends a new viewer message `{ t: "tab", action: "adopt", tabId }` (the same rules
  as the tool's adopt). There is no watching another conversation's tab without moving it. When
  the conversation owns no tab yet but the browser runs, the panel shows its empty state ("智能体
  尚未在此对话中打开网页" / "The agent has not opened a page in this conversation yet") with the
  other-conversations menu, not another conversation's page.

## 6. Closing a conversation's tabs

- **Idle close.** A conversation's tabs close when, for `CONVERSATION_IDLE_MS` (15 minutes, equal
  to the daemon's own idle stop, `IDLE_STOP_MS`), it has made no request and no viewer of it has
  been open, unless it has a pending handoff (then the handoff keepalive applies). A conversation
  alone on its device behaves as today: the daemon's idle stop comes first. The timer is the
  daemon's (spec §10: the daemon keeps its own timers inside the device).
- **Deleted conversations** are not signalled to the daemon: no lifecycle hook tells an extension
  that a conversation was deleted, and `ctx.deviceAccess` refuses a deleted conversation, so no
  call could reach the device for it anyway. The kernel already closes a deleted conversation's
  viewer streams (`viewer.ts`); with no requests and no viewer, its tabs close by the idle close
  within 15 minutes.
- Closing tabs never touches the profile (cookies, storage and the session file's other tabs
  stay).
- **Session file** (`daemon/session-file.ts`, a restart moments ago restores tabs): each saved tab
  carries its owner, the active tab and pending handoff are saved per conversation, and a restore
  gives each tab back to its owner. An older file is not restored (pre-0.1.0; the next start
  begins with one blank tab, as when a file is too old).

## 7. Rulings

1. **Adopt is an action of `browser_tabs`, not a new tool or a parameter on every tool.** It is a
   tab operation like switch and close, it keeps the tool list unchanged, and a per-tool `tabId`
   would let every call silently act on another conversation's page. The agent learns other tabs
   exist from `tabs list`, which lists them under their own heading. Cost if wrong: an agent that
   should reuse a page does not think to list tabs; the person can move the tab from the panel
   (§5), and the tool description says to list tabs when the user points to a page they opened.
2. **Adopt moves ownership; it does not share.** Sharing brings back two conversations driving
   one page. Cost if wrong: the previous owner loses the tab and must open a new one, which its
   note tells it.
3. **The owner is the call's own conversation, not its root.** A sub-agent conversation has its
   own tabs, so parallel sub-agents browsing do not collide. Cost if wrong: a root
   conversation's panel does not show its sub-agents' pages except under "Other conversations",
   and the person must move one to watch it closely.
4. **The viewer's conversation comes from a kernel-written first stream message**, not from the
   panel's `hello` (which the panel could fill from the ticket route's answer). The panel's
   input is not trusted for whose tabs it sees, matching the rule that tool calls take the
   conversation from the kernel. Cost if wrong: a small core change (one message, one SDK doc
   and type) where a panel-supplied id would have done for a filter that is not a security
   boundary.
5. **Idle close after 15 minutes without requests or viewers; no deletion signal.** It equals the
   daemon's own idle stop, so a busy device does not keep a silent conversation's tabs longer
   than an idle device would. Cost if wrong: a deleted conversation's tabs (and their memory)
   linger up to 15 minutes; a person returning after 15 minutes to a conversation whose device
   stayed busy finds its pages closed (the login survives in the profile).
6. **The tab cap stays device-wide (10).** The limit protects the device's memory, which is
   shared. Cost if wrong: one conversation can fill the cap; the refusal says so and the idle
   close frees others' tabs.
7. **Per-conversation action queues.** Actions on different pages are independent in Chromium.
   Cost if wrong: an interaction between concurrent actions (focus, a download started by one
   and noted to the other) shows up as a flaky test; falling back to one queue is a one-line
   change.
8. **Handoff becomes per conversation; takeover stays per device.** A handoff is one
   conversation's question; a takeover is the person holding the one browser. Cost if wrong:
   none known beyond the session file format.

## 8. Testing

- Daemon unit tests (fake clock, real headless shell as the existing daemon tests do): two
  conversations navigate concurrently and each reply reports its own page; `tabs list` sections;
  switch / close of another's tab refused; adopt and its note to the previous owner, refused
  while busy; a popup's owner; the first call claims the blank tab, the second gets a new one;
  the cap message; notes routed to the owner; per-conversation handoff drop; the hand back note
  to each conversation once; idle close with and without a viewer or handoff; session file
  round trip with owners; a request without a conversation refused; a stream without the
  viewer context closed.
- Panel tests: the strip shows only `tabs`, the other-conversations menu and its adopt message,
  the empty state when the conversation owns no tab.
- Plugin server tests: `runRequest` sends `call.conversationId`, never an input field.
- Kernel: the viewer relay test asserts the context message is the first message the provider
  stream receives, with the ticket's conversation, on the direct path and after a hop.

## AGENTS.md rules touched

- **Device access (`ctx.deviceAccess`)**: the kernel's viewer relay now writes one message of its
  own (the viewer context: the ticket's conversation) as the first message of every viewer
  stream; otherwise the stream stays opaque. The rule line gains: "a viewer stream starts with
  the kernel's viewer context message".
- **Public API reports**: the SDK documents and exports the viewer context shape in the device
  service protocol: `pnpm gen:sdk-api` plus a changeset on `@capybara-hq/plugin-sdk`.
- **Multi-replica discipline**: unchanged; tab ownership, idle close and handoff state live in the
  daemon inside the device (spec §10), no kernel record.
- **Tools**: `browser_tabs` gains `adopt`; English description and actionable errors (writing-tools).
