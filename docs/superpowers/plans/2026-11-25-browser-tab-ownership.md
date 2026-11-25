# Browser tabs owned per conversation: plan

Spec: [2026-11-25-browser-tab-ownership-design.md](../specs/2026-11-25-browser-tab-ownership-design.md).

Starts after the design review and after the in-flight browser PRs merge, since they touch the
same files: plugins#226 (device service isolation: `daemon/actions.ts`, `main.ts`, `protocol.ts`,
`viewer.ts`, `src/browser.ts`), plugins#230 (takeover feel: `main.ts`, `protocol.ts`,
`viewer.ts`, `ui-src/panel/panel.ts`), plugins#231 (full Chromium on macOS: `chromium.ts`) and
the panel mode branch `fix/browser-panel-mode`. Rebase onto them; do not merge their content by
hand.

Two PRs, in order: core first (released), then plugins.

## Wave 1: core (one PR, `feat/device-stream-viewer-context`)

1. SDK `packages/plugin-sdk/src/device-service.ts`: document the viewer context message (first
   message of a viewer stream, written by the kernel), export `DeviceServiceViewerContext`
   (`{ kind: "viewer"; conversationId: string }`) and `parseViewerContext(bytes): ... | null`.
   Unit test the parser. `pnpm gen:sdk-api`, changeset on `@capybara-hq/plugin-sdk`.
2. Kernel `packages/kernel/src/device-access/viewer.ts`: after `openStream` resolves and before
   the relay pumps viewer messages, `stream.send` the encoded context with
   `record.conversationId`. Integration test (`test/device-access/…viewer…`, device-fake): the
   first message the service receives is the context, on the direct path and after a hop; then
   the viewer's messages unchanged.
3. AGENTS.md "Device access" line: add the viewer context sentence. Amend the browser use spec
   §6.2 ("the kernel does not parse it" gains "and writes one context message first") and point
   §5 / §8 / §9 / §10 to the tab ownership spec.
4. Review: trust boundary task, reviewed alone on the most capable model.

## Wave 2: plugins (one PR, `feat/browser-tab-ownership`, after the core release)

Disjoint enough for one implementer; review as one batch.

1. `daemon/protocol.ts`: `conversationId` on `ToolRequest`; `tabs` action `adopt`; viewer
   `tab` action `adopt`; `state.otherTabs`; `CONVERSATION_IDLE_MS`.
2. `daemon/actions.ts`: owner and per-conversation active maps; tab for a conversation's first
   call (claim unowned, else open); own-tab checks on switch / close; adopt with the busy refusal
   and the note to the previous owner; popup owner; cap message; notes, `unreported`,
   `lastClick` and session events tagged by owner; per-conversation queues.
3. `daemon/state.ts`: per-conversation handoffs and keepalive; hand back note per conversation;
   per-conversation idle timers (requests and viewers counted per conversation).
4. `daemon/main.ts`: refuse a request without `conversationId`; stream: take the first message
   as the viewer context (`parseViewerContext`), close otherwise; pass the conversation to
   `ViewerSession`.
5. `daemon/viewer.ts`: state filtered to the viewer's conversation plus `otherTabs`; events and
   input on its conversation's tabs; adopt.
6. `daemon/session-file.ts`: owners, per-conversation active and handoff; restore by owner.
7. `src/browser.ts` / `src/handoff.ts` / `src/tools.ts`: `runRequest` adds
   `call.conversationId`; `browser_tabs` enum and description gain `adopt` ("list also shows
   other conversations' tabs; adopt one only when the user points you to a page opened
   elsewhere").
8. `ui-src/panel/panel.ts` + `i18n.ts`: strip from `tabs`, the other-conversations menu with
   "Move here", the conversation's empty state; zh / en texts (智能体, never "agent").
9. Raise the `@capybara-hq/plugin-sdk` range to the release from wave 1; changeset on the browser
   plugin; README "Tabs" section.
10. Tests per spec §8; then a live check on device-local and device-docker: two conversations
    browsing at once, adopt from the panel after a takeover login, idle close.

## Done when

Both PRs merged with `ci-ok` green, the browser plugin released with the new SDK range, and the
live check above passes on the dev stack.
