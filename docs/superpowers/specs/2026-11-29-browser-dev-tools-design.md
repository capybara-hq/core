# Browser developer tools: logs, scripts, site data, emulation and more

Status: design, 2026-11-29. Scope approved by the maintainer ("全做", 2026-11-29). Amends the browser
use design ([2026-11-23-browser-use-design.md](2026-11-23-browser-use-design.md)) §8 and §9, the
viewport rules of [2026-11-25-browser-dialogs-and-touch-design.md](2026-11-25-browser-dialogs-and-touch-design.md)
§6 and §7, and builds on the per-conversation tabs of
[2026-11-25-browser-tab-ownership-design.md](2026-11-25-browser-tab-ownership-design.md) and the
loopback rule of [2026-11-28-browser-loopback-port-grants-design.md](2026-11-28-browser-loopback-port-grants-design.md).
Repositories: capybara-hq/core (SDK, kernel, web approval card), capybara-hq/plugins (`browser`).

## 1. Why

The loopback grants made "build an app, start the dev server, test it in the browser" work. The
next step of that loop fails for want of the tools a developer opens first:

- The page is blank, and the agent cannot see the `TypeError` in the console or the `500` of
  `/api/todos`. It guesses from the accessibility tree, or it installs Playwright in the project
  to get at them (the failure mode the loopback spec observed).
- It cannot run a line of JS to read app state, reset a store, or check a computed value.
- It cannot test the mobile layout (only the person may switch to the phone profile, during a
  takeover), drag a card between columns, fill a twelve-field form without twelve approvals, clear
  a stale session, print a page to PDF, or test a page that asks for the location.

Each of these is a small tool on top of the daemon. Two of them (running a script, reading a
site's data) put the person's logged-in sessions within the model's reach, so they need an
approval rule; the maintainer set it: free on loopback pages, decided like an outside-sandbox
escalation everywhere else.

## 2. Goals, non-goals, anti-goals

Goals:

1. Ten new browser tools covering the nine capabilities (§4), on the conversation's own tabs (tab
   ownership spec §4), with English descriptions, actionable errors, no dots in keys.
2. On a page whose document comes from a loopback origin (the canonical rule of the loopback
   spec, `loopbackGrantHostOf`), scripts and site data are free.
3. On any other origin, running a script, reading site data, clearing a remote site's data and
   granting it the clipboard each need a **per-call** approval decided by the conversation's
   permission profile, exactly like an outside-sandbox escalation (person, review model, or Full
   access), and are refused in unattended runs (§5).
4. Bounded output everywhere: every list has a count cap and a character cap, below the daemon's
   reply limit and the kernel's spill threshold.

Non-goals:

- Request or response bodies, request or response headers, cookies in the network log; HAR export;
  request interception or mocking; CPU or memory profiling; a DevTools front end in the panel.
- Arbitrary user agents, network throttling, timezone or locale emulation (later, if asked).
- Real camera, microphone, location or system clipboard of the person's machine.
- Remembered approvals ("always on this site"): every remote call is decided on its own.

Anti-goals: an HttpOnly cookie value reaching the model, the kernel log or a tool result; a
script approved for one origin running on another (the tab navigated in between); an approval
of a sub-agent's or an automation's script without a person or the review model; a page able to
make the daemon believe it is a loopback page.

## 3. Approaches considered (the approval mechanism)

The origin a script would run in is known only inside the daemon, at the moment it runs. The
kernel's tool policy is decided before the handler runs, from the tool's static `defaultPolicy`
(only builtin tools have a per-call `callPolicy`).

1. **Static `ask` on the tools.** No core change. Every call asks, loopback included, which breaks
   the maintainer's rule; tool asks also differ from crossings (an agent's `toolPolicies` can set
   `allow`, a conversation grant can remember the tool, a Full access sub-agent runs it, an
   unattended run in `wait` mode asks the creator instead of refusing).
2. **Split tools** (`browser_evaluate` allow and loopback only, `browser_evaluate_site` ask, with
   an `origin` input the daemon checks). No core change and the card shows the origin, but it
   inherits every difference of approach 1 for the remote tool and doubles three tools.
3. **Expose `callPolicy` to extension tools**, computed by a daemon read before the call. The
   origin can change between that read and the run (time of check, time of use), and the decision
   is still a tool ask, not a crossing.
4. **A kernel crossing raised by the service during the call (chosen).** It follows the loopback
   port flow already in the pipeline: the handler finds out in the daemon that the action needs
   approval, reports it through `ctx.deviceAccess`, returns; the pipeline plans the ask with
   `approverForCrossing`, and on approval runs the call again with the decision in its context;
   the daemon runs it only if the tab is still on the approved origin. One new crossing kind,
   `site-access`, generic for "a device service acting inside a website with the person's
   session", reusable by computer use later. It costs a core change (§5.2), which the loopback
   work has already shaped.

## 4. The tools

All tools act on the calling conversation's active tab unless stated, are refused while the person
holds control (`TAKEN_OVER_MESSAGE`) and on a tab with a pending dialog (`dialog_open`), and end
with the usual page line and tab count. Page-controlled text (console text, URLs, storage keys and
values, script results) is clipped and quoted as JSON strings, never presented as instructions.
"Loopback page" below means: the tab's main frame security origin (from CDP `Page.getFrameTree`,
not from page script) has scheme http or https and a host for which `loopbackGrantHostOf` answers.
`about:blank`, `data:` and every other scheme count as non-loopback.

### 4.1 `browser_console` (console logs and page errors)

```
browser_console { level?: "all" | "error" | "warning" (default "all"), sinceSeq?: integer,
                  limit?: integer (1-200, default 50), textContains?: string }
```

- The daemon records, per tab, `console` messages (type, text, source URL and line) and uncaught
  page errors (`pageerror`: message and the first 5 stack lines) in a ring of 500 entries, from the
  tab's creation, each with a per-tab sequence number. Recording is always on (cheap; a developer
  asks after the fact).
- Returns the newest `limit` matching entries after `sinceSeq`, oldest first, one line each
  (`#41 error app.js:12 "TypeError: …"`), each text clipped to 1000 characters, the whole text to
  20,000; then `Next: sinceSeq 57.` and how many entries the ring dropped since `sinceSeq`.
- `defaultPolicy: "allow"` on every origin: the same class of information as the snapshot.
- Adopted tabs keep their ring; a crashed browser's tabs start a new one (noted).

### 4.2 `browser_network` (request log)

```
browser_network { sinceSeq?: integer, limit?: integer (1-200, default 50), urlContains?: string,
                  resourceTypes?: string[], failedOnly?: boolean }
```

- Per tab ring of 500 requests from Playwright's `request` / `response` / `requestfinished` /
  `requestfailed`: method, URL (clipped to 300 characters, query kept as the address bar shows
  it), resource type, status, duration (`request.timing()`), encoded size when known, failure text
  (`ERR_…`), served from cache or service worker, and `blocked by the device's network` when the
  daemon's blocked-host collector matched it (which points the model at the network ask it got).
- Never request or response bodies, headers, cookies or post data: the log holds none, so no
  input can ask for them.
- One line per request (`#12 GET 500 fetch 84ms https://127.0.0.1:3999/api/todos`), whole text
  capped at 20,000 characters, `Next: sinceSeq N.`
- `defaultPolicy: "allow"` on every origin (the page line already shows full URLs).

### 4.3 `browser_evaluate` (run JavaScript)

```
browser_evaluate { expression: string (<= 20,000 chars), ref?: string, timeoutMs?: integer
                   (1000-60000, default 10000) }
```

- Runs `expression` in the main world of the tab's main frame (CDP `Runtime.evaluate`,
  `awaitPromise`, `returnByValue`); with `ref`, as a function body receiving the element as `el`.
- Result: the JSON of the value (clipped to 20,000 characters, `(cut)` marked), `undefined`, or a
  description for a non-serializable value (`[object HTMLDivElement]`); console lines the script
  logged (at most 20); a thrown error as an error result (`The script threw: … (line 3)`); a
  timeout terminates the execution (`Runtime.terminateExecution`) and says so.
- Loopback page: runs (tool `defaultPolicy: "allow"`, so an org or agent policy may still make it
  ask or deny). Any other page: the daemon refuses with `site_access` and the origin; the plugin
  raises a `site-access` crossing (§5) with action `evaluate`, the origin and the script, and the
  call runs again only after approval, only while the tab is still on that origin.
- `keyArgs: ["expression"]`.

### 4.4 `browser_viewport` (viewport and device emulation)

```
browser_viewport { preset?: "desktop" | "laptop" | "tablet" | "phone" | "phone-landscape",
                   width?: integer (320-1920), height?: integer (320-1440),
                   deviceScaleFactor?: number (1-3), mobile?: boolean }
```

- Presets: desktop 1280×800 (default), laptop 1440×900, tablet 820×1180 (mobile, touch, scale 2),
  phone 390×844 (the existing phone profile: mobile, touch, scale 2, the derived Android user
  agent), phone-landscape 844×390. `width` + `height` without a preset is a custom desktop size;
  `mobile: true` adds touch and the mobile user agent.
- **Per conversation (decided).** The viewport belongs to the conversation, applies to every tab
  it owns, to tabs and popups it opens later, and to a tab it adopts. Per tab was rejected: the
  model reasons about "testing mobile", not about one tab, and `adopt` and popups would silently
  change sizes. Sub-agent conversations start on desktop. The daemon keeps it in memory and in
  its session file (restored with the tabs), and drops it with the conversation's tabs.
- The dialogs spec's rule "the agent always acts on 1280×800" becomes "the agent acts on its
  conversation's viewport": the person's takeover profile still overrides while they hold
  control, and hand back restores the owner's viewport (not always desktop) before the next
  request. Coordinate tools' schema bounds become 1920×1440 and the daemon refuses a point outside
  the current viewport (`x 1000 is outside the viewport 390x844; take a viewport screenshot
  first.`). The page line names a non-desktop viewport (`Viewport 390x844 (phone).`), and the
  screenshot description no longer hard-codes 1280×800.
- Panel and screencast: `state.viewport` becomes the shown tab's viewport, so the panel
  letterboxes and maps input per tab (portrait for phones, as the phone profile does today); the
  screencast's `maxWidth` / `maxHeight` already cap frame size, so a 1920-wide viewport costs no
  more bandwidth than the expanded view does now.
- `defaultPolicy: "allow"` (changes nothing outside the conversation's tabs).

### 4.5 `browser_drag` and `browser_drag_at` (drag and drop)

```
browser_drag    { fromRef: string, toRef: string }
browser_drag_at { fromX, fromY, toX, toY: number (within the viewport) }
```

- By refs: Playwright `locator.dragTo` (mouse down, stepped moves, mouse up; Chromium's drag
  interception covers HTML5 drag and drop). By coordinates: `mouse.move` / `down` / `move` with 10
  steps / `up`, for canvases and custom widgets. The agent's pointer is flashed in the panel as
  for clicks.
- `defaultPolicy: "ask"`, like the other actions. Dropping workspace files onto a drop zone is out
  of scope (`browser_upload` covers file inputs).

### 4.6 `browser_storage` (cookies, localStorage, sessionStorage)

```
browser_storage { action: "list" | "clear",
                  kinds?: ("cookies" | "localStorage" | "sessionStorage")[] (default all three),
                  origin?: string (default: the active tab's origin), name?: string }
```

- Scope: cookies that would be sent to `origin` (`context.cookies(url)`, parent-domain cookies
  included), its localStorage (CDP `DOMStorage` by storage key), and sessionStorage of the active
  tab only (it is per tab). `name` narrows to one cookie or key. An `origin` other than the active
  tab's must be a loopback origin (`Open a page of https://x.example first; site data is read
  only for the active page's site or a local origin.`).
- `list`: cookies as name, domain, path, expiry, size, `HttpOnly` / `Secure` / `SameSite`, and the
  value clipped to 200 characters, **except HttpOnly cookies, whose value is never returned**
  (`(HttpOnly: value hidden)`), on every origin. Storage entries as key and value clipped to 500
  characters; at most 200 entries and 20,000 characters in all.
- `clear`: `context.clearCookies({ domain, path?, name? })` for the cookies listed by the same
  input, `Storage.clearDataForOrigin` / `DOMStorage.clear` for storage. The result says what was
  removed.
- Approval (maintainer rule): `list` and `clear` of a **loopback origin** are free from any page;
  `list` or `clear` of a **non-loopback origin** raises a `site-access` crossing (actions
  `storage-read`, `storage-clear`) naming the origin and the kinds. Clearing a remote site's
  cookies signs the person out of it in every conversation on the device (one shared profile),
  which the approval text says. Tool `defaultPolicy: "allow"`.
- **Why HttpOnly values stay hidden everywhere, approved or not:** HttpOnly is the site's own
  statement that no script may read the cookie; it is almost always a session or refresh token,
  and a value in a tool result lands in the event log, the review model's input and any
  trajectory or share, where it would outlive the session it unlocks. No task needs the raw value:
  the agent sees that the cookie exists, its flags and expiry, and can clear it. A loopback app's
  own developer can read it from their server. Non-HttpOnly values are what page scripts (and
  `browser_evaluate`) can read anyway, so they follow the same approval as evaluate.

### 4.7 `browser_fill_form` (several fields in one call)

```
browser_fill_form { fields: { ref: string, value: string | boolean | string[] }[] (1-50) }
```

- The daemon resolves every ref first and checks each value fits its element (text field or text
  area: string; checkbox, radio, switch: boolean; select: string or string array; a contenteditable:
  string); one bad pair refuses the whole call before anything is typed (`Field 3 (e17) is a
  checkbox; pass true or false.`). Then fills in order (`fill`, `setChecked`, `selectOption`) and
  stops at the first failure, saying which fields were filled.
- Never submits: the model clicks the submit button in a separate call, so the approval of the
  form and of sending it stay apart.
- `defaultPolicy: "ask"`; one approval covers the listed fields; `keyArgs: ["fields"]`. The card
  shows each ref and value (the kernel's existing input view of the call).

### 4.8 `browser_pdf` (save the page as PDF)

```
browser_pdf { name?: string, landscape?: boolean, printBackground?: boolean (default true),
              format?: "A4" | "Letter" (default A4), pageRanges?: string }
```

- CDP `Page.printToPDF` with `transferMode: "ReturnAsStream"`, read through `IO.read` in chunks
  (no single huge base64 message), written by the daemon into `<workspace>/downloads/` under the
  sanitized name (default the page title), numbered on collision, never overwriting: the
  downloads directory is the only workspace path the service may write (browser use spec §5), and
  the existing `saveDownload` checks (real path, no link swap) apply. The download size cap
  (`BROWSER_DOWNLOAD_MAX_BYTES`, default 200 MiB) applies.
- Works in the full Chromium's new headless mode and in `chrome-headless-shell` (the old headless
  mode, where `printToPDF` originated). The macOS headless shell runs `--single-process` under the
  local sandbox: the plan's first task proves `printToPDF` and font access there; if it fails, the
  tool answers `Saving as PDF needs the full browser; ask the user to update capybara-device on
  that machine.` (the existing `HEADLESS_SHELL_NOTE` path).
- Result: the absolute path and size; the model may `Deliver` it. `defaultPolicy: "allow"` (a
  download the agent asked for, in the place downloads go).

### 4.9 `browser_permissions` (geolocation and web permissions)

```
browser_permissions { action: "list" | "grant" | "revoke", origin?: string (default the active
                      tab's origin), permissions?: ("geolocation" | "notifications" |
                      "clipboard-read" | "clipboard-write" | "camera" | "microphone")[],
                      geolocation?: { latitude, longitude, accuracy? } | null }
```

- Allowed set and why: `geolocation` (only an emulated position: CDP
  `Emulation.setGeolocationOverride` per tab of the conversation, like the viewport; headless
  Chromium has no location provider, and the person's real location is never used), `notifications`
  (headless shows nothing; lets a page's flow continue), `clipboard-write`, `clipboard-read` (the
  browser's own clipboard; the spike confirms it is not the Mac's system clipboard, otherwise
  `clipboard-read` stays person-only), `camera` and `microphone` (only Chromium's fake devices:
  the daemon launches with `--use-fake-device-for-media-stream`, never a real device). Anything
  else (`midi`, `storage-access`, `idle-detection`, …) is refused by the schema.
- Grants use `Browser.setPermission` per origin and permission: device-wide for the daemon's
  life, not written to the profile, as the panel's grants of the dialogs spec §6 already are.
  `list` shows the origin's grants and the conversation's geolocation; `revoke` sets `denied`.
  `geolocation: null` clears the emulated position.
- Approval: free on a loopback origin; on another origin free for all but `clipboard-read`, which
  raises a `site-access` crossing (action `permission-grant`): a remote site reading the browser's
  clipboard could read what the person pasted during a takeover. `origin` other than the active
  tab's must be loopback, as for storage. Tool `defaultPolicy: "allow"`.
- The dialogs spec's denial note now adds, for these names, `call browser_permissions to grant it
  and repeat the page action.`

## 5. The `site-access` crossing

### 5.1 Flow

1. The handler asks the daemon. The daemon reads the tab's main frame security origin; for a
   non-loopback origin without an approval in the request it replies `ok: false`, error
   `site_access`, with `{ action, origin, detail }` and does nothing.
2. The plugin calls `ctx.deviceAccess.requestSiteAccess(call, { service: "browser", action,
   origin, detail })` and returns an error result with the pending text (below).
3. After the handler returns, the pipeline plans the ask, as it plans a loopback refusal today
   (`loopbackBlocked` in `tools/pipeline.ts`): refused at once if the run is unattended (an
   automation's conversation, or an automation run with no person joined) or the trigger is not the
   conversation's owner; otherwise `approverForCrossing({ crossing: "site-access", … })`.
4. Person: an approval card (detail kind `site`), owner decides, scope **once** only. Review model:
   a `site-access` review (§5.3). Full access: allowed, recorded, except for a sub-agent, which
   goes to the review model (the same rule `outside-sandbox` and `loopback-port` follow).
5. Approved: the pipeline runs the call again as `attempt + 1` with
   `ToolCallContext.siteAccess = { action, origin, detailSha256, source }`. The plugin passes it in
   the daemon request; the daemon runs only if the tab's origin, the action and the SHA-256 of the
   detail it would send match, else replies `site_access` again with `The page moved to
   https://y.example since the approval; call the tool again.` (no second ask in the same call).
   Denied or expired: the kept result gets the note, as for loopback.

Not bounded by the device's outside-sandbox setting (decided): nothing leaves the sandbox; the
risk is the person's session in the profile, and an org admin who wants none of it switches off
the single tools (existing per-tool switch).

### 5.2 Core changes (SDK and kernel)

SDK (`packages/plugin-sdk`, public API: `pnpm gen:sdk-api` + changeset):

- `permissions.deviceAccess.siteAccess?: boolean`, validated with `services` and `loopbackPorts`,
  shown in the import review ("may ask to run scripts and read site data on websites, each call
  approved by the conversation's permission profile").
- `DeviceAccessCtx.requestSiteAccess(call, ask: SiteAccessAsk): void`, synchronous like
  `reportBlockedHosts`; at most one per call (a second replaces the first). `SiteAccessAsk =
  { service: string; action: "evaluate" | "storage-read" | "storage-clear" | "permission-grant";
  origin: string /* http(s) origin, ≤ 300 chars */; detail: string /* ≤ 20,000 chars: the script,
  the kinds and name, the permission */ }`. An extension without `siteAccess` throws
  `DeviceAccessError("site_access_not_declared")`.
- `ToolCallContext.siteAccess?: { action; origin; detailSha256: string; source: "human" |
  "review-model" | "full-access" }`, set only on the re-run after an approval, never from input.

Kernel:

- `PermissionCrossingKind` gains `site-access`; `approverForCrossing` treats it like
  `outside-sandbox` (sub-agent under Full access → review model).
- `ServiceBlocked` / `CallScope` carry the call's site ask; `rerunPoints` gains an approved `site`
  ask; the per-run ask cap counts it.
- Approval detail `SiteAccessAskDetail { kind: "site"; service; action; origin; detail; attempt;
  outcome?: "once" }`, scopes `["once"]`. Records: `permission_reviewed` with `scopeKind:
  "site-access"`, `approval_requested` / `approval_decided`, audit `device.site_access_decided`
  (origin, action, source; the detail's hash, not the script).
- No table: a decision lives one call; nothing is kept in kernel memory.
- Web (`apps/web`): the approval card for `site` (§6), zh and en.

### 5.3 Review model

New classifier kind `site-access` with its fixed system prompt start: the agent's browser asks to
run a script / read / clear site data / grant clipboard read on `<origin>` using the person's
signed-in session. Allow only when the person's messages make acting on that site part of the
task; answer ask for scripts that read cookies, tokens or storage, send data to another origin,
or change account settings, and for clearing data of a site the task does not name. Input: origin,
action, the detail clipped to 8,000 characters (marked when cut).

### 5.4 Model-facing text

- Pending: `This page is on https://x.example, not a local origin. Running a script there uses the
  user's session on that site, so it needs approval for this call; an approval was requested.`
  (storage: `Reading this site's data…`, `Clearing this site's data…`; clipboard: `Granting
  clipboard read to this site…`).
- Unattended: `… needs the user's approval, which an unattended run cannot get; it did not run.
  Use browser_snapshot or browser_network to read the page instead.`
- Denied: `The user did not approve running this script on https://x.example.` plus the reason.
- Loopback pages never mention approval.

## 6. Panel and UI

Approval card (web, kernel-rendered, owner decides):

| action | zh | en |
|---|---|---|
| evaluate | 允许智能体在 x.example 上运行脚本？ | Allow the agent to run a script on x.example? |
| storage-read | 允许智能体查看 x.example 的 Cookie 和网站数据？ | Allow the agent to view cookies and site data of x.example? |
| storage-clear | 允许智能体清除 x.example 的 Cookie 和网站数据？本设备所有会话都会退出该网站。 | Allow the agent to clear cookies and site data of x.example? Every conversation on this device is signed out of it. |
| permission-grant | 允许 x.example 读取浏览器剪贴板？ | Allow x.example to read the browser's clipboard? |

The card shows the script in a code block (first 40 lines, the rest behind 展开 / Show all) and
the kinds or permission; buttons 允许本次 / Allow once, 拒绝 / Deny.

Browser panel (plugin embed page, zh and en through its i18n):

- The address bar shows a chip for a non-desktop viewport (`390×844`) and a pin for an emulated
  location (`已模拟位置` / `Location emulated`); the picture letterboxes by the shown tab's
  viewport.
- The person's takeover buttons 手机宽度 / 桌面宽度 stay; hand back restores the conversation's
  viewport (`已恢复智能体的视口` / `Restored the agent's viewport` in the status line).
- No console or network view in the panel (the model reads them; the person has the takeover).

## 7. Data and limits

| item | limit |
|---|---|
| console ring | 500 entries per tab, 1000 chars per entry, 20,000 chars per reply |
| network ring | 500 requests per tab, URL 300 chars, 20,000 chars per reply |
| evaluate | script 20,000 chars, result 20,000 chars, 20 console lines, 60 s |
| storage | cookie value 200, storage value 500 chars, 200 entries, 20,000 chars |
| fill form | 50 fields |
| PDF | download cap (200 MiB default), streamed |
| site ask detail | 20,000 chars (review model sees 8,000) |

Every reply stays far below the 8 MiB service message (`DEVICE_SERVICE_MAX_MESSAGE`); a reply that
still does not fit fails with `REPLY_TOO_LARGE_MESSAGE` adapted per tool (`ask for less: a smaller
limit or a narrower filter`). Results above the kernel's 50,000-character spill go to the output
archive as usual. Rings live in daemon memory only (never in the profile or the session file).

## 8. Multi-replica and state

- Rings, per-conversation viewport and geolocation, and permission grants live in the daemon, the
  one process every request of the device reaches (browser use spec §10); viewport and
  geolocation are also saved in the daemon's session file so a service restart keeps them.
- The kernel keeps nothing in memory: an ask is an approval row and events in PG, the re-run is
  the existing durable call path; a replica dying between approval and re-run resumes like a
  loopback re-run.
- No new queue, timer, Redis key or table.

## 9. Replay

Every new model-visible text is inside a tool result, recorded in `tool_result`; the re-run's
result replaces the kept one as for loopback. No `DriftReason`. The tool definitions are ordinary
extension tools. The `site-access` review is a `permission_reviewed` record, not model-visible.

## 10. Testing

- SDK: `siteAccess` permission validation; `SiteAccessAsk` bounds; API report.
- Kernel integration (fake extension in `@capybara-hq/testing` `fixtures/extensions` calling
  `requestSiteAccess`, device-fake): approver per profile; sub-agent under Full access goes to the
  review model; unattended refusal; deny and expiry notes; re-run carries `siteAccess` with the
  right hash; one ask per call; audit row. Dual-replica: one approval, one re-run.
- Daemon (real Chromium, plugins test style): loopback detection from the frame tree (a page
  that sets `document.domain` or `history.pushState` cannot pass); origin change between ask and
  re-run refused; HttpOnly values absent from every reply; rings and caps; viewport per
  conversation across adopt, popup, takeover hand back and restart; drag on an HTML5 list and a
  canvas; fill form refusal before any typing; PDF in both builds; fake media; geolocation
  override per tab.
- Plugin server: `site_access` reply → `requestSiteAccess` → pending text; tool design check.
- Live on the Mac: the todo-app prompt with console, network, evaluate and phone viewport; an
  evaluate on a remote site under each profile.

## 11. Rollout

1. Plugins wave 1 (no core change): console, network, viewport, drag, fill form, PDF, permissions
   without remote clipboard read, and evaluate / storage on loopback origins (remote: a plain
   refusal `needs a newer Capybara`).
2. Core: SDK + kernel crossing + web card, released (sdk and kernel rc, images).
3. Plugins wave 2: the browser declares `siteAccess`, depends on the new SDK, and raises the
   crossing; the import review shows the new permission.

## AGENTS.md rules touched

- **Device access (`ctx.deviceAccess`)**: add "a device service's action inside a non-loopback
  website (a script, reading or clearing site data, a clipboard-read grant) is a per-call
  `site-access` crossing decided like an outside-sandbox escalation and refused in unattended
  runs; HttpOnly cookie values never leave the browser daemon".
- **Extensions**: `permissions.deviceAccess.siteAccess` joins `loopbackPorts` as a reviewed
  device access permission.
- **Public API reports**: no rule change; the SDK change follows it.

## 12. Calls made here (the maintainer can overturn them)

1. Approval mechanism: a new generic kernel crossing `site-access` raised by the service during
   the call (approach 4), not tool-level `ask` or split tools; per call, no remembered scope.
2. `site-access` follows the outside-sandbox approver rules (sub-agent → review model under Full
   access) but is **not** bounded by the device's outside-sandbox setting.
3. HttpOnly cookie values are hidden everywhere, loopback included and with approval.
4. Viewport and geolocation are per conversation, not per tab; hand back restores the owner's
   viewport.
5. Console and network logs are free on every origin; URLs keep their query strings.
6. Fill form never submits; drag and fill form are `ask` like other actions.
7. Permission set: geolocation (emulated only), notifications, clipboard read/write, camera and
   microphone (fake devices only); only remote clipboard read needs approval; grants are
   device-wide for the daemon's life.
8. PDF goes only into `<workspace>/downloads/`, `allow`.
9. Site data on a non-active origin is reachable only for loopback origins.
10. Wave 1 ships in plugins before the core change.
