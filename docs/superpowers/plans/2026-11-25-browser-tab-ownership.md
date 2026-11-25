# Browser tabs owned per conversation: plan

Spec: [2026-11-25-browser-tab-ownership-design.md](../specs/2026-11-25-browser-tab-ownership-design.md).

## Prerequisites

Starts after the design review and after the in-flight browser work merges, since it touches the
same files. Rebase onto it; do not merge its content by hand:

- plugins#226 (device service isolation: `daemon/actions.ts`, `main.ts`, `protocol.ts`, `viewer.ts`,
  `src/browser.ts`; adds `tabs[].blocker`; also the request socket's trust on docker / e2b, spec §3:
  wave 2 depends on it);
- plugins#230 (takeover feel: `main.ts`, `protocol.ts`, `viewer.ts`, `ui-src/panel/panel.ts`; the
  read-only watch state whose input gate gets the adopt carve-out);
- plugins#231 (full Chromium on macOS: `chromium.ts`; one of the two launch plans of task 0);
- `fix/browser-panel-mode` (panel design: `protocol.ts` `state.verification`, `src/handoff.ts`
  `InputRequired.open`, `ui-src/panel/*`);
- plugins#207 (long waits as a suspension), if it lands first: its parked wait becomes a park
  (spec §6); if it lands later, it registers its park through the same daemon API.

Order: task 0, then the core PR (released), then the plugins PR.

## Task 0: spike, background-tab rendering (before wave 2)

Throwaway branch in plugins. Two conversations, each with a viewer stream, both pages animating
(a CSS animation and a canvas); assert frames keep arriving on both streams and `screenshot` of the
non-front tab returns within its normal time, on both launch plans: the full Chromium in new
headless mode (plugins#226, Linux docker) and the macOS build (plugins#231, device-local). If a plan
stalls, try in order: no `bringToFront` anywhere on agent paths (already in the spec); each
conversation's tabs in a window of their own (`Target.createTarget` with `newWindow: true`); the
renderer backgrounding flags set explicitly. Record the result in spec ruling 7 (a docs commit)
before wave 2 starts.

## Wave 1: core (one PR, `feat/browser-tab-tree-context`)

1. SDK `tool.ts`: `ToolCallContext.rootConversationId` (documented: the root of the call's
   conversation tree, equal to `conversationId` outside sub-agents). Kernel tool pipeline sets it
   for every call (the root is already computed for device access; compute it once per run, not
   per call). Tests: a root call and a sub-agent call.
2. SDK `device-service.ts`: document the viewer context (the first stream message after the
   provider's `{"kind":"stream"}`, written by the kernel; a later one is never context), export
   `DeviceServiceViewerContext` (`{ kind: "viewer"; conversationId; rootConversationId }`) and
   `parseViewerContext(bytes)`. Unit test the parser. `pnpm gen:sdk-api`, changeset on
   `@capybara-hq/plugin-sdk`.
3. Kernel `device-access`: the ticket records the root (from `scopedDevice`), the hop record
   carries it under the MAC, and `openLocal` sends the encoded context before `pump`. Integration
   test (device-fake): viewer bytes sent before the provider stream opens; the context with the
   ticket's conversation and root is still the first stream message, on the direct path and after
   a hop; then the viewer's messages unchanged.
4. Kernel + SDK `answerHandoff`: takes `handoffConversationId`; checks it is the scope
   conversation or a descendant (recursive on the conversation parent link, org-scoped), then
   looks up the pending question by `(conversation_id, call_id)` (same extension check). Tests:
   root scope answers a sub-agent's question; two sub-agents of one tree pending under the same
   `callId`: only the named one is answered; a conversation outside the scope's tree, another
   tree's and another extension's question stay `question.not_found`.
5. AGENTS.md "Device access" line: the viewer context sentence. Amend the browser use spec §6.2
   ("the kernel does not parse it" gains "and writes one context message first") and point §5 /
   §8 / §9 / §10 to the tab ownership spec.
6. Review: trust boundary and cross-tenant query (`answerHandoff`), reviewed alone on the most
   capable model.

## Wave 2: plugins (one PR, `feat/browser-tab-ownership`, after the core release)

One implementer; review as one batch.

1. `daemon/protocol.ts`: `conversationId` / `rootConversationId` on `ToolRequest`; `page` optional
   in the ok reply; `tabs` action `adopt`; viewer `tab` action `adopt` and a shown-tab message;
   `state.tabs` grouped by conversation of the tree, `state.otherTabs` (id, title, url only),
   `state.handoffs` (each with `callId` and the trusted `conversationId`); `{ t: "notice", code: "tab_in_use" }`; `CONVERSATION_IDLE_MS`,
   `MAX_TABS_PER_CONVERSATION`.
2. `daemon/actions.ts`: `{ owner, root }` per tab and per-conversation active maps; a tab for a
   conversation's first acting call (claim unowned, else open); non-acting ops open no tab;
   own-tab checks on switch / close; adopt with the in-use refusal (in flight from arrival to
   reply, queued and `wait` included, or parked) and the note to the previous owner; popups via
   `page.on("popup")` on every tracked page, unowned when unattributable; both caps and the eviction
   (only owners not in use and with no request for `EVICT_MIN_IDLE_MS`, 5 min; least recently used
   owner, its non-active tabs before its active tab; else refuse) with its note and the two refusal
   texts (tests: a conversation that made a request a moment ago is never evicted; non-active tab
   first); notes, `unreported`, refused
   hosts (`blockedHosts`), `lastClick` and session events tagged by owner; per-conversation queues;
   no `bringToFront` on agent paths; list sections with the clipping of other conversations'
   titles and URLs.
3. `daemon/state.ts`: per-conversation handoffs and parks and the keepalive; the hand back note
   for the conversations the takeover concerned; per-conversation idle timers (requests per
   conversation, parks, and viewers pinning only their own conversation and the owner of the tab
   they show; test: a finished sub-agent's tab closes after `CONVERSATION_IDLE_MS` with the root
   panel open), and deletion of all per-conversation state on idle
   close.
4. `daemon/main.ts`: refuse a request without the conversation fields; stream: take the first
   stream message as the viewer context (`parseViewerContext`), close otherwise, never re-read a
   later one; pass conversation and root to `ViewerSession`.
5. `daemon/viewer.ts`: state for the viewer's tree plus `otherTabs`; the viewer's shown tab
   (default, last acting conversation, follows a new handoff); input on the shown tab in control;
   #230's input gate lets `adopt` and the shown-tab choice through in the watch state; a viewer
   adopt of a tab of its own tree is ignored (test); in control, `switch` sets the owner's active
   tab only for the viewer's own conversation, otherwise only the shown tab, and a sub-agent whose
   tab the person then uses gets the hand back note (test); the `tab_in_use` notice.
6. `daemon/session-file.ts`: owners and roots, per-conversation active, handoff and park; restore
   by owner.
7. `src/routes.ts`: `/ui/handoff-answer` takes and passes the handoff's `conversationId`
   (`handoffConversationId`); `src/browser.ts` / `src/handoff.ts` / `src/tools.ts`: `runRequest` adds `call.conversationId`
   and `call.rootConversationId`; results without a page say "This conversation has no browser tab
   yet."; `browser_tabs` enum and description gain `adopt` ("list also shows other conversations'
   tabs; adopt one only when the user points you to a page opened elsewhere").
8. `ui-src/panel/panel.ts` + `i18n.ts`: strip with the tree's groups ("子任务" / "Sub-task"),
   the other-conversations menu with "Move here", the `tab_in_use` line, the tree's empty state,
   the newest handoff of the tree in the banner, whose Done / Cancel echo its `conversationId`; zh / en texts (智能体, never the Latin word).
9. Raise the extension manifest's `sdk` range (`src/index.ts`, checked by the kernel's
   `extensions/resolve.ts`) to the release from wave 1, and the plugins repo's pnpm override that
   keeps one `@capybara-hq/plugin-sdk` instance; changeset on the browser plugin; README "Tabs"
   section.
10. Tests per spec §9; then a live check on device-local and device-docker: two conversations
    browsing at once; a sub-agent's handoff answered Done from the root panel, the sub-agent
    resuming on its own signed-in tab; "Move here" from a watching panel; the cap eviction; idle
    close.

## Done when

Task 0's result is recorded, both PRs are merged with `ci-ok` green, the browser plugin is released
with the new `sdk` range, and the live check above passes on the dev stack.
