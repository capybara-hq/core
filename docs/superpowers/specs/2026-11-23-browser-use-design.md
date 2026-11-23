# Browser use: a real browser in the conversation's device, watched and taken over from the side panel

Status: draft for maintainer review (2026-11-23). Repositories: capybara-hq/core (kernel, SDK, web),
capybara-hq/plugins (the `browser` plugin, the device providers' stream support), capybara-hq/core
`packages/device` (the local device program).

## 1. Why

Agents today reach the web through WebSearch / WebFetch, which return text and explicitly leave out
JavaScript interaction and screenshots (web tools spec, non-goals). Two kinds of work need a real
browser:

- public pages that only work with JavaScript, forms, multi-step flows, screenshots;
- sites behind a login (company back offices, SaaS consoles, document sites) where the person logs in
  once and the agent keeps using that session.

The maintainer also wants to **see** what the agent does in the browser and **take over** when needed
(log in, pass a captcha, fix a wrong turn), from a browser button in the conversation's right area,
even though the browser itself runs headless. Computer use (the person's real desktop) is a separate,
later design (§11).

## 2. Terms

- **Browser**: one headless Chromium with one persistent profile, run inside a device by the
  browser daemon.
- **Browser daemon**: a small program the `browser` plugin ships and runs inside the device; it owns
  the Chromium process and its CDP connection, serves the agent's browser tools and the live view.
- **Profile**: Chromium's user data directory, kept in the device's file system.
- **Live view**: the screencast of the browser shown in the right area, with simulated browser chrome
  (tabs, address bar, back / forward / reload).
- **Takeover**: the person controls the browser through the live view; the agent's browser tools
  pause until the person hands it back.
- **Handoff**: the agent asks the person to do something in the browser (log in) and waits.
- **Device stream**: a new, generic, byte-oriented bidirectional stream between a client and a
  target inside a device, relayed by the kernel (§6).

## 3. Goals, non-goals, anti-goals

Goals

1. A `browser` plugin gives agents a real browser for public pages and logged-in sites. (maintainer)
2. The browser runs in the conversation's device (docker, e2b, the person's Mac through
   `device-local`, any provider implementing the device stream). Its profile lives in the device's
   file system and so belongs to the device's owner; it lasts until the device is deleted.
   Devices are personal (`devices.owner_kind = 'personal'`) and a conversation uses its owner's
   device (`conversations.account_id`), so two people sharing an agent each use their own device.
   Because a run's trigger account may differ from the conversation's owner (group chats, shared
   conversations: `ToolCallContext.accountId` vs `ownerAccountId`), **browser tools work only in
   runs triggered by the conversation's owner**; any other trigger gets an actionable error.
   (maintainer, 2026-11-23, Q1 a)
3. On the local device the browser is a **separate profile**, never the person's everyday Chrome.
   (maintainer, option B)
4. Live view in the right area through the CDP screencast; the browser stays headless. (maintainer,
   option 1)
5. Simulated browser chrome: tab strip, address bar, back / forward / reload, loading and https state.
   (maintainer)
6. Takeover and hand back from the live view; a handoff tool for the agent. (takeover: maintainer;
   handoff tool: designer's proposal, accepted in the discussion)
7. Agent tools work primarily on a page structure snapshot (accessibility tree with element refs) so
   every chat model can browse; a screenshot tool (and coordinate clicks) for vision models.
   (maintainer)
8. The browser uses the device's own network setting (open public internet or allowlist with asks,
   under the org and platform ceilings). No separate browser network setting. (maintainer)
9. A fixed viewport (default 1280×800) independent of the panel; the panel scales the picture.
   (§8, accepted)

Non-goals

- Driving the person's everyday Chrome, its extensions or its cookies (a later, separate design if
  ever).
- Computer use: the person's real screen, mouse and keyboard (§11).
- Firefox / WebKit (the screencast is Chromium-only).
- Phone takeover (phase 2: viewing only on compact).
- A browser network setting separate from the device's.

Anti-goals (a failure even if it works)

- Anyone other than the device's owner watching or controlling a browser, or reaching a profile:
  "view only" enforced only in the UI (a known flaw of other products: anyone holding the raw CDP or
  live URL controls the browser). Viewing and control are authorized by the kernel on every stream.
- A live view or CDP endpoint reachable from the network: no published port, no public URL, no
  password in a URL or a log.
- Screencast frames passing through Redis or PG (they would swamp them at scale).
- The browser bypassing the device's network ceilings, the command review or the conversation's
  approvals.
- Agent element refs or coordinates silently invalidated because the person resized the panel.

## 4. Shape

```
 web (right area)                kernel                         device
 ┌──────────────────┐   WS    ┌──────────────┐  device stream  ┌────────────────────────┐
 │ browser panel    │◀───────▶│ stream relay │◀───────────────▶│ browser daemon         │
 │ (plugin client   │ ticket  │ (authorizes, │  provider        │  ├ Chromium (headless) │
 │  component)      │         │  pipes bytes)│  openStream      │  │  profile in fs      │
 └──────────────────┘         └──────────────┘                  │  └ CDP                 │
                                     ▲                          └────────────────────────┘
 agent ── browser tools ── browser plugin (server) ── ctx.deviceAccess.ensureService / request ──┘
```

- **Kernel (core)**: the device stream (provider capability + relay + viewer endpoint),
  `ctx.deviceAccess` for extensions (a service and streams in the conversation's device, under the
  command review, the owner rule and the device network rules, §7).
- **`browser` plugin (plugins repo)**: the daemon, the agent tools, the panel (an embed page in the
  `conversation.panel` slot, like `example-board`), the handoff tool.
- **Device providers**: `device-docker`, `device-e2b`, `device-local` + `packages/device` implement
  `openStream`. A provider without it: the browser button shows disabled with the reason.

## 5. The browser daemon and its profile

- One daemon and one Chromium per device, shared by every conversation on that device (they are all
  the owner's). Profile directory under the device's state area in the file system (exact path:
  builder's call; it must not be inside a project root, so it never lands in a repository or a share).
- **Service process (designer's call, contract change).** A long-lived daemon does not fit `exec`
  (time limits, abort kills, `killTagged`, per-operation scopes whose writes stay in the project and
  workspace). `device-provider@1` gains an optional service concept, roughly
  `startService(h, { name, argv, stateDir }) / stopService / serviceStatus`: one named service per
  device, run under the device's own sandbox (not under any one conversation's operation scope),
  writable only in its own state directory (a new per-service write root outside every project
  root) plus the workspace downloads directory, network through the device's network setting
  (§7.1), killed on suspend / destroy. The kernel starts it on behalf of an extension holding
  `permissions.deviceAccess`; its launch passes the command review once per start (fail closed).
  Each provider implements it (docker / e2b: a supervised process in the instance; local: a
  process the device program supervises under the local sandbox).
- Chromium: Playwright's Chromium (docker / e2b, per the sandbox dev tiers spec: runtime libraries,
  `ShmSize`, downloads into the cache under `PLAYWRIGHT_BROWSERS_PATH`); on macOS
  `chrome-headless-shell` with `--single-process` until the full Chrome works under the local sandbox
  (dev tiers spec §9). **First task of the plan: prove screencast + `Input.dispatch*` +
  `Target.*` work in `chrome-headless-shell --single-process` under the local sandbox.**
- macOS: `--use-mock-keychain` so no Keychain prompt appears; cookies are then protected by the
  directory's file permissions only (accepted).
- No macOS TCC permission (Screen Recording, Accessibility) is needed: frames come from Chromium, input
  goes into the page through CDP.
- The daemon starts on the first browser tool call or the first live view, and stops after an idle
  period with no tool call and no viewer (builder's call on the period); a suspended or destroyed
  instance kills it like any other process. The profile survives in the file system.
- The daemon listens on a unix socket (or loopback port where a provider needs it) inside the device,
  never on a published address. The device stream (§6) and `exec` are the only ways in.
- Downloads land in a downloads directory in the workspace; uploads take a workspace path.
  (designer's call)
- Native dialogs (alert / confirm / prompt, file chooser, HTTP auth, permission prompts) are
  intercepted through CDP and surfaced: to the agent as tool output, in the panel as simple design
  dialogs.
- Memory: a Chromium with a few tabs takes roughly 300–500 MB inside the device's memory limit (docker
  default 2 GiB). The tab count per browser is capped (builder's call on the number).

## 6. The device stream (kernel and providers)

### 6.1 Provider capability

`device-provider@1` gains an optional method, roughly:

```ts
openStream?(h: SandboxHandle, target: { unixSocket: string } | { port: number },
            signal: AbortSignal): Promise<DeviceStream>   // duplex bytes, close, error
```

- `device-docker`: a connection into the container (exec of a relay or the docker attach API:
  builder's call).
- `device-e2b`: the e2b SDK's port / process stream.
- `device-local`: multiplexed over the existing dial-in connection. Today a provider reaches the
  machine only through `ctx.dialIn.request`, and every request and answer goes through Redis
  (`kernel/src/dial-in/relay.ts`: a Redis list per device, answers under `capk:device-res:*`). That
  path cannot carry frames. **New SDK primitive (public API change):** `ctx.dialIn.openStream`,
  usable only on the gateway replica that holds the machine's socket, which sends stream frames
  straight over that socket (new envelope kinds `stream-open` / `stream-data` / `stream-close`,
  each within `maxFrameBytes`, per-stream credit flow control so a stream cannot starve the
  machine's operations). `packages/device` implements the machine side.
- The target must be inside the device and refer to a socket the daemon owns; the stream is not a
  general port forward (the provider refuses any other target class the kernel does not ask for).

### 6.2 Relay and viewer endpoint

- The plugin's panel asks the plugin server for a viewer ticket; the plugin server calls
  `ctx.deviceAccess.streamTicket({ conversationId, accountId, target })`. The kernel checks that the caller is
  the device's owner (the conversation's owner on their own device) and the extension is on in the
  org, and returns a short-lived single-use ticket.
- The web panel opens a WebSocket to a kernel endpoint with the ticket. The kernel re-checks the
  session, opens the provider stream and pipes bytes both ways. The protocol on the stream (screencast
  frames, input events, tab / navigation state) is the plugin's; the kernel does not parse it.
- **Frames never pass through Redis or PG.** The viewer WebSocket is served by the replica that can
  open the provider stream directly: any replica for docker / e2b; for local devices the gateway
  replica holding the machine's dial-in socket. Routing (designer's call): the viewer path is
  `/device/stream`, served only on the `gateway` role; the web server forwards its upgrades to a
  gateway replica exactly as it already forwards `/device/connect`
  (`apps/web/src/lib/device-connect-proxy.ts`, `CAPYBARA_WEB_GATEWAY_URL`), and an external proxy
  may route it to the gateway replicas directly. Cookies are not forwarded there, so the ticket is
  the only credential. A gateway replica that does not hold the machine's socket forwards the
  WebSocket once to the holder over an internal replica-to-replica connection. Today no state says
  which replica holds a machine (the lease value is a random token), so the holder records its
  internal address next to the lease (`capk:device-holder-addr:<deviceId>`, same TTL as the lease);
  the hop is authenticated with an HMAC over the ticket id under the kernel's internal secret.
- An open viewer stream counts as device use: it refreshes the instance's last use (and a takeover
  holds it), so idle suspension never cuts off a person logging in. (designer's call)
- Every open, close and takeover is audited (`browser.view`, `browser.takeover`); frames are not.
- Embed tokens stay invalid for `/api`; the ticket is valid only for its one stream.

### 6.3 Bandwidth

- Frames flow only while a panel is open; no viewer = no stream. Load scales with concurrent viewers,
  not with tasks.
- Chromium emits frames only on change; the screencast's frame ack gives backpressure, so a slow
  network lowers the frame rate instead of queueing.
- `Page.startScreencast` gets `maxWidth` / `maxHeight` from the panel's current size: small frames in
  the side panel (≈15–30 KB JPEG, peak ≈200 KB/s), larger in the expanded view (peak ≈0.5–1 MB/s).
- Input round trip same region: ≈100–200 ms.

## 7. `ctx.deviceAccess` for extensions

Extension tools cannot reach the conversation's device today. New `ctx.deviceAccess` (permission
`permissions.deviceAccess`, reviewed at import like every permission):

The browser needs no general `exec`: everything goes through the service and its stream. So the
surface is small (amended 2026-11-23 after mapping the kernel):

- `ensureService(call, spec)`: starts (or finds running) the named service in the conversation's
  device (§5): the kernel writes the spec's files into the service's state directory, runs the
  command review on the launch argv (fail closed), and starts it through the provider. Returns the
  service's status.
- `request(call, { service, body, timeoutMs })`: one request / response to the service's socket, for
  tool calls. Tool calls run on API / worker replicas, not on the gateway, and their payloads are
  small (snapshots, actions; a screenshot is capped to the device's frame capacity), so this rides
  the provider's ordinary request path (for local devices the existing Redis relay). Streams are
  only for viewers (§6.2). Provider side: optional `serviceRequest?(h, name, body, opts)`.
- `streamTicket({ conversationId, accountId, target })`: a viewer ticket (§6.2); the account must be
  the conversation's owner.
- `reportBlockedHosts(call, hosts)`: the daemon saw requests refused by the device's allowlist during
  this call; the kernel raises the network ask in the call's conversation (§7.1) and the pipeline
  waits on it as for an exec. Only an ask, so trusting the plugin's report costs nothing.
- `addNetworkHosts({ conversationId, accountId, hosts })`: owner-only, used from the panel during
  takeover (§7.1), through the same device write the device page uses (ceilings apply, audited).
- `answerHandoff({ conversationId, accountId, callId, done })`: answers the handoff question of that
  call from the panel (§9); the kernel's own question rules apply (only the run's starter answers).
- Each call is refused when the conversation has no device, the device's provider is unavailable or
  lacks the service / stream capability, or the trigger account is not the conversation's owner
  (actionable English error for the model).

The daemon's launch command has a fixed shape so the command review can recognize it; how the review
classifies it is the builder's call, but it is never exempt from review. Every `ctx.deviceAccess`
call is refused when the run's trigger account is not the conversation's owner (§3 goal 2).

### 7.1 Network asks for the browser (maintainer, Q3 a)

Network asks and run grants today hang off one `exec` (`ExecResult.network.blocked`, grants routed
by `actor.runId`). The browser is a long-lived service, so:

- Chromium's traffic goes through the device's network enforcement like any other process
  (`--proxy-server` to the device's proxy where the provider uses one; providers that enforce
  differently apply the same allowlist). Closed address classes stay closed.
- Under `allowlist`, a request to a new host is held by the daemon and reported to the plugin. If a
  browser tool call is in flight, the plugin raises the ask in **that call's conversation** through
  the existing network ask flow; the person's approval adds the host to the device's allowlist (the
  device-wide grant the device page already edits), so every conversation on the device then
  reaches it. The tool call waits for the answer the way an exec waits for its network ask. The
  ask offers only "always" (device allowlist): a "once" grant is applied per exec
  (`NetworkGrants.forExec`) and cannot reach a long-lived service.
- During takeover (no run), the panel shows the blocked host with 允许; it calls
  `ctx.deviceAccess.addNetworkHosts` (device allowlist), owner-only.
- Subresource requests of an already allowed page follow the same rule (no exemption); a page that
  pulls many new hosts asks for each new host once. The ask text explains that open mode stops the
  asks.
- Org and platform ceilings bound every grant, as today.

## 8. The panel

- A browser button in the conversation's right area opens the plugin's panel (`conversation.panel`,
  `kind: "embed"`; amended 2026-11-23: embed routes get the caller's account and conversation
  (`RouteCaller`), which the ticket, network and handback routes need, and a client component's
  actions can return no data). Takeover, hand back and every input event go over the viewer stream
  straight to the daemon; the plugin's embed routes serve only `stream-ticket`, `network-hosts` and
  `handoff-answer`.
- Before the service runs (no browser tool call yet) the panel shows an empty state; the panel
  never starts the service itself, so every start passes through a tool call and its review.
- **Watch state (side panel, default)**: tab strip, address bar, back / forward / reload, the picture
  scaled to the panel width at 16:10 with letterboxing, a status line ("agent: filling the form…"),
  the agent's clicks flashed on the picture. Clicking in the small view works (closing a popup).
- **Expanded state**: the right area's existing full-screen mode (`RightArea` `full`: the panel
  maximised inside the page) at near 1:1; 接管 asks the host to switch to it through the embed bridge
  (a new bridge message if none exists), 交还智能体 and `Esc` restore. No new overlay. (amended
  2026-11-23)
- Input coordinates are mapped back through the scale. The viewport stays fixed (default 1280×800);
  resizing or closing the panel never changes it. A viewport switch (desktop / tablet / phone via
  `Emulation.setDeviceMetricsOverride`) is phase 2.
- Compact: watch only; the panel follows the slot's `compact: "drawer"`. Touch takeover is phase 2.
- Address bar and tabs come from CDP (navigation events, `Page.navigate`,
  `Page.getNavigationHistory` / `navigateToHistoryEntry`, `Page.reload`, `Target.getTargets` /
  `createTarget` / `activateTarget`). What the person types in the address bar is navigation under
  the device's network setting like any other.
- All UI text through i18n (zh / en); the zh text says 智能体.

```
┌ 浏览器 ──────────────── [⤢] ┐
│ [知乎] [飞书文档] [+]         │
│ ← → ⟳ 🔒 feishu.cn/docx/...  │
│ ┌──────────────────────────┐ │
│ │   scaled page (≈0.37)    │ │
│ │          ◉ last click    │ │
│ └──────────────────────────┘ │
│ 智能体：正在填写表单…  [接管] │
└──────────────────────────────┘
```

## 9. Agent tools

Primary, structure based (every chat model):

- navigate (url, or back / forward / reload), tabs (list / open / switch / close)
- snapshot: the accessibility tree compacted to text with element refs (`e12`), size-capped, large
  output archived per the tool output rules
- click / type / select / press key / scroll / hover by ref; upload a workspace file to a ref
- wait (for text, a ref, navigation, or a time cap)
- handoff (`message` for the person): opens the expanded view with the message on top, waits until
  the person hands back or cancels, then returns the new page state. The wait is the existing
  resumable `InputRequired` (a two-choice form: 完成 / 取消, answered in the conversation or by
  交还智能体 in the panel through `ctx.deviceAccess.answerHandoff`), so it survives replica restarts. `wait` with a long cap uses the same
  mechanism. (designer's call)

Vision:

- screenshot (viewport or full page; through the kernel's media limits and downscaling) and
  click / type at coordinates in viewport pixels.

Rules:

- English descriptions, actionable errors, no dots in tool keys (writing-tools).
- While the person has taken over, browser tools other than handoff and wait fail at once with an
  actionable error ("The user is controlling the browser; call wait or handoff."). (designer's call)
- On hand back, the next browser tool result starts with a note that the person controlled the
  browser and the current URL / title. This is new model-visible input inside a tool result, logged
  through the event log; replay: tool results are recorded, so no new `DriftReason` is needed unless
  the note is injected outside a tool result (builder checks against replay-evals).
- Tool policy (maintainer, Q2 a): snapshot, screenshot, navigate, tabs, wait and handoff need no
  approval; click, type, select, press key, upload and coordinate actions follow the
  conversation's permission profile (request-approval: ask each time; approve-for-me: the review
  model decides; full-access: run). Navigation still obeys the network rules (§7.1).
- Takeover is per device (the browser is shared by the device's conversations): while the person
  controls it from any conversation's panel, browser tools in every conversation on the device get
  the "user is controlling" error, and every open panel shows who holds it and 交还智能体.
  (designer's call)

## 10. Multi-replica and state

- Takeover state (who controls, since when) lives in the daemon, the one place every tool call and
  every viewer stream of the device reaches; it refuses agent input while taken over, so the
  kernel keeps no takeover record and two replicas can never disagree about it. A takeover ends
  when the person hands back, or when the last viewer stream closes and a grace period passes
  (builder's call on the period). (amended 2026-11-23)
- The daemon's lifecycle follows the device instance; its idle stop is the daemon's own timer inside
  the device (allowed: it is not kernel process state).
- Viewer streams end cleanly on replica shutdown; the panel reconnects with a new ticket.

## 11. Computer use (later, not designed here)

Needs the real screen and input: on macOS Screen Recording and Accessibility granted to
`capybara-device`, outside any sandbox; on cloud devices a virtual display (Xvfb + headful apps)
and VNC over the same device stream. The device stream and the panel's takeover model are meant to be
reused.

## 12. Decisions taken after the builder check (2026-11-23)

Maintainer:

- Q1 a: only runs triggered by the conversation's owner may use browser tools.
- Q2 a: reads and navigation without approval; actions follow the permission profile.
- Q3 a: new-host asks go to the in-flight tool call's conversation (or the panel during takeover);
  approval widens the device allowlist.

Designer's calls (check while reviewing): the service process concept (§5), `ctx.dialIn.openStream`
on the holding gateway replica (§6.1), viewer routing through the gateway role with one internal hop
(§6.2), viewer streams count as device use (§6.2), handoff on `InputRequired` (§9), per-device
takeover (§9).

## 13. Approaches considered

- **CDP screencast over a new device stream (chosen)**: same on docker, e2b and the Mac; stays
  headless; kernel authorizes every stream; no published address. Cost: page content only (dialogs
  re-drawn in the panel), Chromium only, a new stream capability in the device contract.
- **Virtual display + VNC (noVNC)**: complete picture, reusable for computer use; impossible on the
  local Mac without capturing the real desktop, heavier images. Deferred to computer use.
- **Polling screenshots through `exec`**: no contract change; 1–2 fps and high latency make takeover
  painful. Rejected.
- **Viewport follows the panel**: rejected (mobile layouts at panel width, refs invalidated on
  resize).
- **Separate browser network setting**: rejected by the maintainer (one network rule per device).
- **Using the person's everyday Chrome on the Mac**: rejected for now (all cookies exposed, extension
  or debug port needed).

## 14. Phases

1. Spike: screencast + input in `chrome-headless-shell --single-process` under the local sandbox and in
   the docker device.
2. Kernel: `openStream` + service process in the contract, `ctx.dialIn.openStream`, relay + viewer endpoint, `ctx.deviceAccess`, network asks for services;
   fake provider support for tests.
3. Providers: docker, e2b, local (+ `packages/device`).
4. `browser` plugin: daemon, tools, panel (watch + expanded + takeover + handoff).
5. Phase 2: viewport switch, touch takeover, phone.

## AGENTS.md rules touched

- **Extensions**: new `permissions.deviceAccess` and `ctx.deviceAccess`; extensions reach the
  conversation's device only through it, under the command review and approvals.
- **Sandboxes**: `device-provider@1` gains optional `openStream` and a service process concept with
  its own write root; the browser obeys the device network setting and its asks (§7.1); no
  published socket or port.
- **Extensions (dial-in)**: `ctx.dialIn.openStream` carries stream frames directly on the gateway
  replica holding the machine's socket, outside the Redis request relay.
- **Extension UI**: the browser panel is an embed page in `conversation.panel`; a new kernel
  WebSocket endpoint for device streams with single-use tickets (embed tokens still never valid for
  `/api`); the embed bridge may ask the host to enter or leave the panel's full mode.
- **Multi-replica discipline**: frames never through Redis / PG; takeover state lives in the daemon (no kernel record); the dial-in holder records its internal address next to the lease.
- **Tools**: new browser tools follow writing-tools; snapshot / screenshot outputs follow output
  archiving and media limits.
- **Public API reports**: SDK changes (`openStream`, `ctx.deviceAccess`, permission) need
  `pnpm gen:sdk-api` and a changeset.
