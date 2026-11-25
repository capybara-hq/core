# Browser dialogs, HTTP auth, permission prompts, phone viewport and touch takeover

Status: draft for maintainer review (2026-11-25). Issue: capybara-hq/plugins#208 (follow-up of the
browser use line, core#816). Repository: capybara-hq/plugins (`browser`: daemon, tools, panel);
**no core change** (§9). Parent spec: `2026-11-23-browser-use-design.md` (§5 promised dialogs
"surfaced: to the agent as tool output, in the panel as simple design dialogs"; §8 and §14 left the
viewport switch and touch takeover to phase 2). The maintainer delegated the design decisions; each is
recorded as a ruling in §11.

## 1. Why

Phase 1 settles every page dialog on its own (`BrowserSession.onDialog` in `daemon/actions.ts`): an
alert is accepted, a confirm or prompt dismissed, a `beforeunload` accepted, and a note tells the agent
afterwards; the panel shows a strip for a few seconds (`showDialog` in `ui-src/panel/panel.ts`). So:

- the agent cannot confirm "Delete this draft?" or fill a `prompt()`, and a flow that needs it is stuck;
- the person who took over sees a strip they cannot answer;
- an HTTP auth challenge (Basic) is cancelled by headless Chromium and the page shows the 401 body;
  nobody can sign in;
- permission requests (notifications, clipboard) are denied silently; nobody learns why a button did
  nothing;
- on a phone the panel is watch-only (`interactive()` requires a non-compact window) and a 1280×800
  page scaled into a 390 px drawer is unreadable.

## 2. Goals, non-goals

Goals

1. A JS dialog that asks for a decision (`confirm`, `prompt`, `beforeunload`) stays open until
   answered: by the person in the panel while they hold control, or by the agent through a new tool
   `browser_dialog`. An `alert` (no decision) is closed at once and reported, as in phase 1.
2. The agent learns of a pending dialog in the reply of the request that opened it, in every later
   reply while it is pending, and in `browser_snapshot` (which cannot read a blocked page).
3. HTTP Basic auth: the person enters credentials in the panel during takeover; the agent is told and
   uses `browser_handoff`; credentials never reach the kernel, the log or the model.
4. Permission requests the page makes are reported to the agent and shown in the panel; the person
   may allow notifications and clipboard access for the origin during takeover.
5. A phone viewport (390×844, mobile, touch) the person switches on during takeover, and takeover
   from a compact window with touch input and a soft keyboard.

Non-goals

- Digest / NTLM / Negotiate auth, client certificates (reported as unsupported).
- Granting geolocation, camera, microphone (the device browser has no position or devices).
- An agent tool to switch the viewport or to grant permissions.
- Pinch zoom, multi-finger gestures beyond one-finger pan, a right-click by long press.
- The file chooser: unchanged (the agent uses `browser_upload`; the panel keeps its hint).

## 3. Pending dialogs (daemon)

- `page.on("dialog")` closes an `alert` at once (it only informs: the agent gets its text in a note,
  the panel shows it as an informational strip, as in phase 1). For every other kind it no longer
  settles: the session records one **pending dialog** per tab (JS dialogs are modal per page):
  `PendingDialog = { id, tabId, kind: "confirm" | "prompt" | "beforeunload" | "auth",
  message, defaultValue?, origin?, realm?, since }` (message clipped to `MAX_DIALOG_CHARS`).
- **The request that opened it replies at once.** An agent action races its own completion with
  "a dialog opened on this tab"; on the dialog it replies `ok` with the dialog in `reply.dialog` (the
  action's Playwright promise keeps running and settles once the dialog is answered; its late outcome
  goes to the next reply as a note, through the existing `unreported` path). Without this, Playwright
  actions on a page with an open dialog never finish.
- **While a JS dialog (confirm, prompt, beforeunload) is pending on a tab** (an `auth` dialog does
  not block: its page is loaded, so only the first bullet applies to it):
  - every ok reply carries `reply.dialog` (the active tab's, or the tab the request touched);
  - `snapshot` returns the dialog line instead of the tree (the tree read evaluates in the page,
    which a modal dialog blocks): `The page is blocked by a confirm dialog: "…". Answer it with
    browser_dialog (accept or dismiss) to continue.`;
  - `screenshot` works, with the dialog line before it (the headless capture does not draw dialogs);
  - other actions on that tab fail fast with new error code `dialog_open` and the same text;
  - actions on other tabs work.
- **Answering**: `dialog.accept(text?)` / `dialog.dismiss()`; the pending dialog clears; viewers get
  the new state; a long wait watching that tab has already ended with reason `dialog`
  (`2026-11-25-browser-long-waits-design.md` §6.2).
- **No hold timer**: a pending dialog stays until it is answered, its tab closes, or the daemon stops
  (idle stop, device suspension). A blocked tab harms nothing else (other tabs work), every reply
  names it, and the next agent run sees it in its first reply. An automatic default after a delay
  would race an agent whose `browser_dialog` call waits for the person's approval, and would decide
  for the person; the phase 1 defaults are gone for decision dialogs.
- `beforeunload` (the page asks whether to leave): pending like the others. `accept` leaves (the
  navigation the agent or person started goes on), `dismiss` stays. The agent's `browser_tabs close`
  keeps skipping `beforeunload` (Playwright's default), as in phase 1.

## 4. HTTP Basic auth

- Detection: a main-frame navigation response `401` with `WWW-Authenticate: Basic …` (Chromium has
  already cancelled the challenge; the page shows the 401 body). The daemon records a pending dialog
  `kind: "auth"` with `origin` and `realm` (clipped, page-controlled). Not blocking: the page is
  loaded, so the request replies normally with `reply.dialog`. A scheme other than Basic is noted:
  `The site asks for <scheme> sign-in, which the browser cannot do; ask the user how to continue.`
- The agent: `browser_dialog` on an auth dialog accepts only `dismiss` (clears it); `accept` fails:
  `Signing in needs the user's credentials; call browser_handoff and ask the user to sign in.` The
  description of `browser_handoff` already says never to ask for passwords in the chat.
- The person (panel, holding control): the auth dialog shows the origin, the realm (as page-supplied
  text, labelled so) and username / password fields; 登录 sends `{ t: "dialog", id, action: "accept",
  username, password }` over the viewer stream, straight to the daemon (the kernel relays bytes and
  never parses them, browser use spec §6.2).
- The daemon then adds `Authorization: Basic …` to requests to that exact origin through
  `context.route` (origin-scoped pattern) and reloads the page. The credentials live only in the
  daemon's memory for its lifetime (gone at idle stop, never in the profile, never in a reply, a log,
  a viewer message or a note); a later `401` from that origin clears them and raises a new auth
  dialog. The agent's next reply notes `The user signed in to <origin> (HTTP auth).`
- Proxy auth (the device's egress proxy, `LaunchPlan.proxyAuth`) is untouched: Playwright answers the
  proxy's 407 itself. **First plan task**: spike that a site 401 is visible as described under the
  device proxy (docker) and with no proxy (local), and that the routed header works through the proxy.

## 5. Agent tool `browser_dialog`

```
browser_dialog { action: "accept" | "dismiss", text?: string, tabId?: string }
```

- Answers the pending dialog of the active tab (or `tabId`): `text` only for a prompt (`accept` with no
  text accepts the default value). Alerts never need it (closed at once). No pending dialog →
  ToolError `No dialog is open on this tab; call browser_snapshot to see the page.`
- `defaultPolicy: "ask"` (accepting a confirm can delete or pay; the permission profile decides, as
  for `browser_click`).
- Refused while the person holds control (the usual `TAKEN_OVER_MESSAGE`).
- Result: the page line plus `Accepted the confirm dialog "…".` and any note that followed.
- Rendering of a pending dialog in every tool result (`toResult` in `src/browser.ts`):
  `The page shows a confirm dialog: "…". Answer it with browser_dialog (accept or dismiss) before
  acting on this tab.` (a prompt adds the default value; `beforeunload`: `The page asks whether to
  leave (it may have unsaved changes): accept leaves, dismiss stays.`; an auth dialog: the sign-in
  sentence from §4). An alert's note: `The page showed an alert: "…" (closed).`

## 6. Permission prompts

- Headless Chromium denies permission requests without a prompt, and CDP has no event for a
  request (the Task 1 spike confirms this on the pinned Chromium; a CDP-native signal, if one exists,
  replaces the wrapper). The daemon wraps the request APIs in an init script
  (`context.addInitScript`) that calls the original and, only when the result is a denial, reports `{ origin, permission }` to the daemon
  through a binding (`context.exposeBinding` with a per-daemon random name). Wrapped:
  `Notification.requestPermission`, `navigator.clipboard.read` / `readText`, the error callbacks of
  `navigator.geolocation.getCurrentPosition` / `watchPosition` (code 1), and
  `navigator.mediaDevices.getUserMedia` rejections with `NotAllowedError`. Page-visible behaviour is
  unchanged (same result, same timing within a microtask).
- Reported to the agent as a note in the next reply (deduplicated per origin and permission for the
  daemon's life): `The page asked for notifications permission, which was denied.` plus, for the
  grantable ones, ` The user can allow it from the browser panel.` and for the others
  ` The device's browser cannot provide it.`
- Panel: a strip `<origin> 请求通知权限` with 允许 when the permission is grantable (notifications,
  clipboard-read) and the person holds control; 允许 sends
  `{ t: "permission", origin, permission, allow: true }`; the daemon calls
  `context.grantPermissions([permission], { origin })`, which lasts for the daemon's life (not
  written to the profile). The person repeats the page action afterwards (the original request was
  already denied). Not grantable: the strip only informs.

## 7. Phone viewport and touch takeover (daemon + panel)

### 7.1 Viewport profiles

- Two profiles: `desktop` (1280×800, the fixed default of the parent spec) and `phone` (390×844,
  device scale factor 2, `mobile: true`, touch with 5 points, a mobile user agent derived from the
  browser's own by the Android Chrome pattern).
- Applied per page through CDP (`Emulation.setDeviceMetricsOverride`, `setTouchEmulationEnabled`,
  `setUserAgentOverride`), to every open tab and to tabs opened while it is on. No reload (responsive
  pages reflow; the person reloads a user-agent-sniffing site).
- Only the person switches, only while holding control: `{ t: "viewport", profile }` from the panel.
  **Hand back restores `desktop`** before any agent request runs (the hand back and the restore are
  serialized ahead of the request queue). So the agent always acts on 1280×800: the tool schemas'
  coordinate bounds, the screenshot text and the `VIEWPORT` constant stay as they are, and the anti-goal
  "agent refs or coordinates silently invalidated" holds.
- Viewers: `state.viewport = { width, height, mobile }`; the panel maps input through it (today it
  uses the `VIEWPORT` constant) and letterboxes the frame by its aspect (portrait in phone).
- The takeover note the agent gets after hand back is unchanged; the viewport is already desktop again.

### 7.2 Touch and keyboard from a compact window

- Compact takeover is allowed: the panel's `interactive()` becomes `control === "user"` at every
  size class; at compact the panel takes over inside its drawer (already full width; no full-mode
  bridge message), shows a takeover bar with 手机宽度 / 桌面宽度, 键盘 and 交还智能体, and suggests
  手机宽度 once per takeover (a hint, never automatic: a switch reflows the page).
- Pointer events with `pointerType === "touch"` send `{ t: "touch", kind: "start" | "move" | "end" |
  "cancel", points: [{ id, x, y }] }` in viewport coordinates. The daemon dispatches
  `Input.dispatchTouchEvent` in the `phone` profile; in `desktop` it translates: a tap (short, little
  movement) → mouse click, a one-finger pan → `mouseWheel` by the movement, anything else ignored.
- 键盘 focuses an off-screen `textarea` in the panel to raise the soft keyboard; its `input` events
  send the inserted text as `{ t: "key", kind: "char", text }` (the existing IME path), Backspace and
  Enter as key down / up. The textarea is cleared after each send, so nothing accumulates in the panel.
- Controls in the takeover bar are at least 44 px tall at compact or on a touch device (the platform's
  mobile size rule, applied by the panel's own CSS since it is the plugin's embed page, not
  `apps/web`).

## 8. Panel (embed page)

- The dialog strip becomes a dialog box drawn over the picture, persistent while the dialog is
  pending (from `state.dialogs`, not a timed message): kind, message (page text, shown as text, never
  HTML), and for the person holding control the controls: 确定 / 取消 (confirm),
  a text field + 确定 / 取消 (prompt, default value filled), 离开 / 留下 (beforeunload), username +
  password + 登录 / 取消 (auth). Watching without control: the same box read-only with
  接管后可回答 / Take over to answer. An alert keeps the phase 1 informational strip.
- The password field is `type="password"`, `autocomplete="off"`, cleared after sending; its value
  exists only in the viewer message to the daemon.
- Permission strip and viewport / touch controls as in §6 and §7.
- All text zh + en through the panel's i18n; the zh text says 智能体.

## 9. Protocol changes (`daemon/protocol.ts`) and why core does not change

- `ToolRequest`: `{ op: "dialog"; action: "accept" | "dismiss"; text?: string; tabId?: string }`.
- `ToolErrorCode`: `+ "dialog_open"`. `ToolReply` (ok): `dialog?: PendingDialogView` (no `id`,
  no `since`).
- `ViewerIn`: `{ t: "dialog"; id; action; text?; username?; password? }`,
  `{ t: "permission"; origin; permission; allow: true }`, `{ t: "viewport"; profile }`,
  `{ t: "touch"; kind; points }`. The daemon refuses `dialog`, `permission` and `viewport`
  from a viewer while control is `agent` (the panel hides them, the daemon enforces it).
- `ViewerOut`: `state` gains `dialogs: (PendingDialogView & { id })[]` (one per tab at most; a viewer
  answer names the `id`, so a stale click never answers a newer dialog) and `viewport`; new
  `{ t: "permission"; origin; permission; grantable }`; the `dialog` message stays for `alert` and `file`
  (informational).
- Core: none. Dialog text reaches the model only inside browser tool results (recorded, so no
  `DriftReason`); the viewer stream stays opaque bytes to the kernel; no new route, permission, SDK
  type or kernel table.

## 10. Security

- A dialog's message, realm and origin are page-controlled: clipped, rendered as text in the panel and
  quoted in tool results (JSON string), never as instructions to the agent.
- HTTP credentials: typed by the person, carried over the owner-only viewer stream, kept in daemon
  memory only, sent only to the exact origin that asked, never to the model, kernel, log, profile or
  any other viewer; the agent can never submit credentials.
- Accepting a dialog is an action under the permission profile; viewport, permission grants and
  credentials are person-only and control-gated in the daemon.
- The init script changes no page-visible result; its binding name is random per daemon start.

## 11. Rulings (designer, delegated by the maintainer)

- R1 Decision dialogs (confirm, prompt, beforeunload, auth) are held open, one per tab; the opening
  request replies at once. Alerts are closed at once and reported (no decision to make).
- R2 No hold timer and no automatic default: a pending dialog waits for an answer, its tab's close or
  the daemon's stop.
- R3 One tool `browser_dialog` (`accept` / `dismiss`, `text`), `defaultPolicy: "ask"`.
- R4 A blocked page's snapshot returns the dialog instead of the tree; other actions on the tab fail
  with `dialog_open`; other tabs work.
- R5 HTTP auth: Basic only, detected from the 401 response, credentials by the person only, applied by
  an origin-scoped route header kept in daemon memory; the agent is pointed to `browser_handoff`.
- R6 Permissions: detection through an init-script wrapper that only reports denials; the person may
  grant notifications and clipboard reading for the daemon's life; geolocation / camera / microphone are
  reported as unavailable; the agent cannot grant.
- R7 Viewport: `desktop` and `phone` only (no tablet); person-only during takeover; hand back
  restores desktop, so agent coordinates never change.
- R8 Compact takeover inside the drawer; 手机宽度 suggested, never automatic.
- R9 Touch: phone profile dispatches touch events; desktop translates tap → click and pan → wheel.
- R10 Soft keyboard through an off-screen textarea using the existing `char` key path.
- R11 No core change; the spec lives in core docs because the parent spec does.

## AGENTS.md rules touched

- **Tools**: new browser tool `browser_dialog` (English description, actionable errors, no dots in
  the key, `defaultPolicy: "ask"`); browser tool results carry pending dialog lines.
- **Device access**: the viewer stream now carries HTTP credentials the person types; still owner-only,
  single-use tickets, frames and input never through Redis or PG, the kernel never parses them.
- **Mobile and shells**: takeover now works at compact with touch; size classes by window width; the
  panel (a plugin embed page, not `apps/web`) applies the mobile control sizes itself.
- **Runtime and replay**: dialog, permission and auth notes are model-visible only inside tool
  results; no `DriftReason`.
- No kernel, SDK, migration or multi-replica rule changes.
