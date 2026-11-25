# Browser dialogs, HTTP auth, permission prompts, phone viewport and touch takeover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Decision dialogs (confirm, prompt, beforeunload, HTTP Basic auth) are held until answered and
permission requests are reported (panel for the person in control, `browser_dialog` and tool-result
lines for the agent); the person can switch a
phone viewport and take over from a compact window by touch.

**Architecture:** All in the `browser` plugin: the daemon keeps one pending decision dialog per tab (alerts
are closed at once and reported, as in phase 1) and replies at once to the request that opened it; a new tool answers it; the viewer protocol carries dialogs,
permission strips, viewport profiles and touch input; the panel draws them. No core change.

**Tech Stack:** playwright-core + CDP in the daemon, the plugin server (`@capybara-hq/plugin-sdk`
tools), the panel (plain TS embed page, jsdom tests), vitest.

**Spec:** `docs/superpowers/specs/2026-11-25-browser-dialogs-and-touch-design.md` (core). Read it
before any task.

## Global Constraints

- Plugins repo only (`plugins/browser`); no SDK or kernel change. If a task finds it needs one, stop
  and report.
- Page-controlled text (dialog message, realm, origin, default value) is clipped to
  `MAX_DIALOG_CHARS`, rendered as text (never HTML) in the panel and JSON-quoted in tool results.
- HTTP credentials: only from a viewer message while control is `user`; kept in daemon memory only;
  sent only to the exact origin; never in a reply, note, log line, viewer message, profile file or
  error text. A test asserts the password string appears in none of them.
- Person-only actions (dialog accept from the panel, permission grant, viewport switch) are refused by
  the daemon while control is `agent`, whatever the panel shows.
- The agent always acts on the 1280×800 desktop viewport: hand back restores it before any queued
  agent request runs.
- Tool texts English and actionable, key `browser_dialog` (no dots), `defaultPolicy: "ask"`;
  `capybara-plugin check` (tool design check) passes.
- UI text zh + en through the panel's i18n; zh says 智能体, never 企业. Touch targets ≥ 44 px at
  compact or on a touch device.
- Daemon timers are allowed (inside the device); none in the plugin server.
- Tests: no fixed sleeps (fake clock or event waits); daemon tests on the local test pages of
  `test/daemon/helpers.ts`.
- Changeset on the browser plugin; Conventional Commits; English comments.

## Review Focus

1. **A `confirm()` opened by the agent's click**: the click replies at once with the dialog; no hung
   request; `browser_dialog accept` continues the page. → Task 2 test `click that opens a confirm
   replies with the dialog`.
2. **Credentials leak**: the password typed in the panel appears in no reply, note, log, viewer
   message or file. → Task 4 test `credentials never leave the daemon memory`.
3. **The person switches to phone and the grace period hands back**: the agent's next request runs on
   1280×800 and its coordinates still hit. → Task 5 test `hand back restores desktop before the next
   request`.
4. **A viewer without control sends `dialog accept`, `permission` or `viewport`**: refused by the
   daemon. → Task 2, 4, 5 tests `… refused without control`.
5. **A dialog left unanswered by an ended run**: it stays pending (no timer, no default) and the next
   run's first reply names it. → Task 2 test `a pending dialog survives until answered and is named in
   the next reply`.

---

## Waves

| Wave | Tasks | Review |
|---|---|---|
| 0 | 1 | spike gate (HTTP auth under the proxy; touch dispatch) |
| 1 | 2 | own review (blocking semantics, protocol) |
| 2 | 3, 4, 5 | 3 tool + rendering, 4 auth + permissions (own review, credentials), 5 viewport + touch (daemon side); files disjoint except `protocol.ts` (Task 2 lands the shared types first) |
| 3 | 6 | panel (dialog box, auth form, permission strip, compact takeover, keyboard); batched review |
| 4 | 7 | acceptance and release |

---

### Task 1: Spike: HTTP auth detection and routed Basic header; touch dispatch (throwaway)

**Files:**
- Create: `<scratchpad>/browser-208-spike/spike.mjs` (not committed)
- Modify: `docs/superpowers/plans/2026-11-25-browser-dialogs-and-touch.md` in core (append "Spike results")

- [ ] **Step 1:** With playwright-core and a local server answering `401 WWW-Authenticate: Basic realm="x"` unless the right header is present: confirm (a) the main-frame `response` event shows 401 and the header, (b) `context.route("http://127.0.0.1:<port>/**", r => r.continue({ headers: { ...r.request().headers(), authorization } }))` + reload loads the page, (c) both with `proxy: { server, username, password }` pointed at a local authenticating proxy (as the docker device runs it) and without.
- [ ] **Step 2:** Check the pinned Chromium for a CDP-native signal of a permission request (none expected); record it. If one exists, Task 4 uses it instead of the init-script wrapper.
- [ ] **Step 3:** In the docker device: `Emulation.setDeviceMetricsOverride` (390×844, mobile) + `setTouchEmulationEnabled` + `Input.dispatchTouchEvent` tap on a button with a `touchstart` listener; record that the listener fires and the screencast frame is portrait.
- [ ] **Step 4:** Record pass / fail and any deviation in "Spike results"; a failure in (c) means the auth task changes approach before Wave 2 (report, do not improvise).

---

### Task 2: Pending dialogs in the daemon

**Files:**
- Modify: `plugins/browser/daemon/protocol.ts` (`PendingDialogView`, `ToolRequest` `op: "dialog"`, `ToolErrorCode` `dialog_open`, `ToolReply.dialog`, `ViewerIn` `dialog`, `ViewerOut` `state.dialogs`)
- Modify: `plugins/browser/daemon/actions.ts` (`onDialog` :600 closes alerts at once with a note and records the other kinds; per-tab pending map; actions race "dialog opened on this tab"; `snapshot` / other ops on a blocked tab; `dialogOp`; late action outcomes to `unreported`; no timer)
- Modify: `plugins/browser/daemon/main.ts` (route `op: "dialog"` through the takeover refusal like other agent input)
- Modify: `plugins/browser/daemon/viewer.ts` (`state.dialogs`; viewer `dialog` answer only while control is `user`; the old `dialog` message only for `alert` and `file`)
- Test: `plugins/browser/test/daemon/tools.test.ts`, `plugins/browser/test/daemon/viewer.test.ts`

**Interfaces:**
- Produces:
  ```ts
  type DialogKind = "confirm" | "prompt" | "beforeunload" | "auth";
  interface PendingDialogView { tabId: string; kind: DialogKind; message: string;
    defaultValue?: string; origin?: string; realm?: string }   // in ToolReply.dialog
  interface ViewerDialog extends PendingDialogView { id: string }  // in state.dialogs
  // ToolRequest
  | { op: "dialog"; action: "accept" | "dismiss"; text?: string; tabId?: string }
  // ViewerIn
  | { t: "dialog"; id: string; action: "accept" | "dismiss"; text?: string;
      username?: string; password?: string }
  ```

- [ ] **Step 1: Failing tests:**
  - `click that opens a confirm replies with the dialog` (reply ok, `dialog.kind === "confirm"`, within the action timeout).
  - `snapshot on a blocked tab returns the dialog line`; `click on a blocked tab fails with dialog_open`; `actions on another tab work`.
  - `dialog accept with text answers a prompt`; `dismiss answers a confirm`; `beforeunload accept lets the navigation go on`.
  - `an alert is closed at once and noted`.
  - `a pending dialog survives until answered and is named in the next reply` (fake clock advanced an hour; still pending).
  - `viewer dialog answer refused without control`; `viewer dialog answer works with control`.
  - `state carries one dialog per tab and clears on answer`; `a viewer answer with a stale id changes nothing`.
- [ ] **Step 2:** `pnpm exec vitest run plugins/browser/test/daemon/tools.test.ts plugins/browser/test/daemon/viewer.test.ts` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Rerun → PASS.
- [ ] **Step 5:** Commit `feat(browser): hold page dialogs until answered`.

---

### Task 3: `browser_dialog` and dialog lines in tool results

**Files:**
- Create: `plugins/browser/src/dialog.ts` (tool spec + handler)
- Modify: `plugins/browser/src/index.ts` (register it), `plugins/browser/src/browser.ts` (`toResult` renders `reply.dialog`; `daemonToolError` maps `dialog_open`)
- Modify: `plugins/browser/README.md`
- Test: `plugins/browser/test/tools.test.ts`

- [ ] **Step 1: Failing tests:** `browser_dialog spec: key, ask policy, schema`;
  `accept maps to op dialog`; `no dialog → actionable ToolError`;
  `auth dialog accept → handoff ToolError`; `toResult renders confirm / prompt / beforeunload / auth lines and the alert note`;
  `dialog_open error names browser_dialog`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement (texts exactly as spec §4–§5).
- [ ] **Step 4:** Rerun → PASS; `capybara-plugin check`.
- [ ] **Step 5:** Commit `feat(browser): browser_dialog tool`.

---

### Task 4: HTTP Basic auth and permission reports (daemon)

**Files:**
- Modify: `plugins/browser/daemon/actions.ts` (401 detection on main-frame responses; `auth` pending dialog; per-origin credential map in memory; `context.route` per origin; reload; clear on a new 401; unsupported-scheme note; permission init script + random binding name; dedup set; `grantPermissions`)
- Modify: `plugins/browser/daemon/protocol.ts` (`ViewerIn` `permission`; `ViewerOut` `permission`)
- Modify: `plugins/browser/daemon/viewer.ts` (auth answer and permission grant only while control is `user`)
- Create: `plugins/browser/daemon/permissions.ts` (the init script source and the binding handler; pure, unit-testable)
- Test: `plugins/browser/test/daemon/auth.test.ts`, `plugins/browser/test/daemon/permissions.test.ts`

- [ ] **Step 1: Failing tests:**
  - `401 Basic raises an auth dialog with origin and realm`; `Digest is noted as unsupported`.
  - `viewer credentials sign in and reload`; `the agent's next reply notes the sign-in`.
  - `credentials never leave the daemon memory` (the password string absent from every reply, note, viewer message, log line captured, and the profile and state directories).
  - `credentials go only to the exact origin` (a request to another port / host has no header).
  - `a new 401 clears the credentials and asks again`.
  - `auth answer refused without control`.
  - `notifications request is reported once per origin`; `clipboard grant from the panel takes effect`; `geolocation denial is reported as unavailable`; `permission grant refused without control`; `the wrapper returns the page the same result`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement (approach per the Task 1 spike).
- [ ] **Step 4:** Rerun → PASS.
- [ ] **Step 5:** Commit `feat(browser): HTTP auth and permission requests`.

---

### Task 5: Viewport profiles and touch input (daemon)

**Files:**
- Modify: `plugins/browser/daemon/protocol.ts` (`VIEWPORT_PROFILES = { desktop: {1280, 800, mobile: false}, phone: {390, 844, mobile: true, dpr: 2} }`; `ViewerIn` `viewport`, `touch`; `state.viewport`)
- Create: `plugins/browser/daemon/viewport.ts` (apply / restore a profile to a page through CDP; mobile UA derivation; tap and pan translation for the desktop profile)
- Modify: `plugins/browser/daemon/actions.ts` (profile applied to new tabs; restore on hand back serialized before the request queue)
- Modify: `plugins/browser/daemon/state.ts` (hand back hook that awaits the restore)
- Modify: `plugins/browser/daemon/viewer.ts` (`viewport` only while control is `user`; `touch` dispatch)
- Test: `plugins/browser/test/daemon/viewport.test.ts`

- [ ] **Step 1: Failing tests:**
  - `phone profile sets 390x844 mobile with touch on every tab and new tabs`.
  - `hand back restores desktop before the next request` (queue a click_at during hand back; it lands at desktop coordinates).
  - `viewport switch refused without control`.
  - `touch tap in phone dispatches touch events` (page `touchstart` listener fires).
  - `touch tap in desktop clicks`; `one-finger pan in desktop scrolls`.
  - `state carries the viewport`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Rerun → PASS.
- [ ] **Step 5:** Commit `feat(browser): phone viewport and touch input for takeover`.

---

### Task 6: Panel: dialogs, auth form, permission strip, compact takeover, keyboard

**Files:**
- Modify: `plugins/browser/ui-src/panel/panel.ts` (dialog box from `state.dialogs` replacing the timed strip; auth form with `type="password"` cleared after send; permission strip; `interactive()` = control `user` at every size; compact takeover bar with 手机宽度 / 桌面宽度, 键盘, 交还智能体 and the once-per-takeover phone hint; coordinate mapping from `state.viewport`; pointer `touch` events → `touch` messages; off-screen textarea → `char` / Backspace / Enter)
- Modify: `plugins/browser/ui-src/panel/page.ts` (markup and CSS; 44 px targets at compact or `(pointer: coarse)`)
- Modify: `plugins/browser/ui-src/panel/i18n.ts` (zh + en strings)
- Test: `plugins/browser/test/panel/panel.test.ts`

- [ ] **Step 1: Failing tests:**
  - `confirm box shows the message and answers with control`; `an alert stays an informational strip`; `read-only box without control shows the take-over hint`.
  - `prompt box fills the default value`; `auth form sends credentials and clears the field`.
  - `permission strip offers allow only for grantable permissions and only with control`.
  - `compact panel can take over`; `phone toggle sends viewport`; `phone hint shows once per takeover`.
  - `touch pointer events map through the phone viewport`.
  - `keyboard textarea sends char and clears`.
  - `page text renders as text` (a message with `<img onerror>` stays literal).
- [ ] **Step 2:** `pnpm exec vitest run plugins/browser/test/panel/panel.test.ts` → FAIL.
- [ ] **Step 3:** Implement; rebuild the panel bundle (`build:ui`).
- [ ] **Step 4:** Rerun → PASS.
- [ ] **Step 5:** Commit `feat(browser): panel dialogs and compact touch takeover`.

---

### Task 7: Acceptance and release

- [ ] **Step 1:** Plugins PR green (`ci-ok`); the main session releases the browser rc and pins it where pinned.
- [ ] **Step 2:** Dev stack, docker device: agent clicks a "Delete" button with `confirm()`; the result shows the dialog line; `browser_dialog accept` (approval per profile) deletes. Same with `prompt()`.
- [ ] **Step 3:** A Basic-auth test site: the agent reports the sign-in need and calls `browser_handoff`; the person takes over, enters credentials in the panel, the page loads; the agent continues. Check the conversation log, kernel log and daemon state directory for the password: absent.
- [ ] **Step 4:** A notifications demo page: the agent's reply notes the denial; the person allows it from the panel; the page action works on retry.
- [ ] **Step 5:** From a phone (compact web): open the panel, take over, switch to phone width, tap, type with the soft keyboard, hand back; the agent's next screenshot is 1280×800.
- [ ] **Step 6:** Local device (`device-local`, chrome-headless-shell): Steps 2 and 5 once.
- [ ] **Step 7:** Close plugins#208 with the release note.
