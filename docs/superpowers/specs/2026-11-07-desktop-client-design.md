# Desktop client

- Date: 2026-11-19, written against `main` at `b9c01fe0` (first draft 2026-11-07).
- Status: draft for review.
- Pairs with: the mobile layout design (`2026-11-19-mobile-layout-design.md`, branch
  `docs/mobile-layout`), whose §9 **"Shell environment"** owns the `window.capybaraShell` contract:
  its shape and types (in `@capybara-hq/plugin-sdk`), versioning (`version`, capabilities by
  `name@major`), the injection and security rule, and how the web and design use it. This document
  defines only the desktop's values and the capabilities it owns there: `device@1`, `notify@1`,
  `openExternal@1` (§7.3, §8).
- Builds on: the environments design (`2026-11-07-environments-design.md`; §13 and §15 for local
  devices), the device service control design (`2026-11-14-device-service-control-design.md`), the
  permission profiles and auto-mode designs (owner ceiling, Full access, restricted work) and the
  published program `@capybara-hq/device` (`packages/device`).
- Markers: **(decided)** is the maintainer's answer (discussions of 2026-10-19, 2026-11-07 and
  2026-11-19); **(designer's call)** is decided here and may be overturned in review.
- Written in English (AGENTS.md "Language"); UI copy is quoted in Chinese where it matters.

## 1. Why

Capybara reasons in the cloud. The agent loop, the event log, policies, credentials and metering
live in the kernel. A person's machine contributes **hands, not a brain**: `capybara-device`
connects it as a **local device** whose operations the kernel sends over an outbound WebSocket.
Today that takes a terminal: `npm i -g @capybara-hq/device`, `capybara-device login --url …`,
`start` or `service install`, and `ceiling set` to widen what the machine allows.

A desktop app gives people two things the terminal does not:

1. The deployment's web app in its own window, with OS integration: notifications, a tray, deep
   links, a dock icon.
2. Connecting this machine from inside that web app in one click (「连接本机」), with an OS
   confirmation instead of a command line.

This is the opposite of Claude Code, where the agent runs locally and remote access is the add-on.
It is closer to the Claude desktop app, which loads its web UI from the cloud. The difference is
that Claude's local MCP tools are relayed through the page, so they work only while the app shows
the conversation. Capybara's kernel reaches the device directly, so a conversation on this machine
keeps working from the browser or an IM channel while the machine is online.

## 2. Terms

- **Desktop app**: the installable application, `apps/desktop` in the repository
  `capybara-hq/clients` (§5).
- **Shell**: the desktop app's window that loads a deployment's web app. "Shell" is also the
  general word of the Shell environment contract (desktop now, mobile later).
- **Address page**: the only page bundled in the app. It asks for a deployment address.
- **Deployment profile**: one deployment the app knows: its origin, the name discovery returned and
  a separate browser session.
- **Capability**: a `name@major` object of functions on `window.capybaraShell.capabilities`
  (mobile layout §9.2); the desktop's are defined in §8. "Bridge" below means these calls.
- **Runner**: the `capybara-device start` process serving this machine. The desktop always runs
  it as the login service (§5.2); a terminal or a service installed with the CLI is used as is.
- **Keep-awake**: the device's setting that stops the computer from idle-sleeping (§9.7).
- **Native dialog**: an OS message box or menu shown by the app's main process
  (`dialog.showMessageBox`, the tray menu). Native dialogs are not "UI the desktop draws": they
  carry no layout or styling of ours, and no web content can answer them.

## 3. Goals, non-goals, anti-goals

Goals:

1. Everything the web app does, by loading the deployment's own web app. No second copy of the
   UI, and no version skew between UI and kernel **(decided)**.
2. **The desktop draws no UI of its own** **(decided)**. The only local page is the address page,
   plain HTML with no `@capybara-hq/design` dependency. Setup, onboarding, connector OAuth and
   every setting are the deployment's own web pages in the window.
   Sign-in happens in the system browser, never in the window (§6.5) **(decided)**.
3. The web adapts when it detects the desktop shell through the Shell environment contract (title
   bar insets for the macOS traffic lights, drag regions), by capability detection, never by
   user-agent sniffing **(decided)**.
4. 「连接本机」: when the shell offers the `device@1` capability, the web's 新建设备 flow offers to
   connect this machine, and the shell connects it after a native confirmation naming the
   platform **(decided)**.
5. Local policy changes from the web can only tighten; widening needs a native confirmation or an
   edit on the machine **(decided)**.
6. The device keeps serving when the window closes or the app quits: it runs as a login service,
   and the app is only its UI **(decided)**.
7. Keep-awake: the computer does not idle-sleep while the device should serve **(decided)**.
8. Several deployments side by side, each with its own session.

Non-goals:

- An agent loop, a local kernel or an offline mode. A local single-machine deployment was
  considered and rejected as too heavy **(decided)**.
- Bundling the web app, or any React Native or native UI framework **(decided)**: the UI exists
  only as the deployment's web app (self-hosted kernels differ in version; plugin UI is web only).
- Local settings windows, a start page or an activity window rendered by the app **(decided)**.
  What runs on this machine, pausing and disconnecting are shown by the deployment's device page
  through the bridge (§8, §9.6); the tray menu offers the same few actions natively.
- A local per-command confirmation ("ask me when I am at the machine"). Approvals live in the
  deployment (the `request-approval` / `approve-for-me` permission profiles); a second, local
  approval path would split the record **(designer's call)**.
- Local stdio MCP servers on the device. They need their own design: `sandbox@2` carries commands
  and file operations, not MCP.
- A virtual-machine sandbox mode. A later option (§14).
- Mobile apps in this document. They are a later Capacitor shell in the same repository and
  follow the same Shell environment contract **(decided)**.

Anti-goals (a failure even if it works):

- The device credential, the file system or command execution reachable from any web page,
  including the deployment's own pages.
- The shell environment available outside the top frame of the profile's exact origin (mobile
  layout §9.4).
- A remote page that connects the machine, resumes a paused runner or widens the local policy
  without a native confirmation.
- Any inbound port on the machine. The runner's control socket (§4.2) is a local Unix socket, not
  a network listener.
- Two runners serving one deployment on one machine.

## 4. What the device package offers, and what is missing

The 2026-11-07 draft asked `packages/device` to become "a library plus a thin CLI". It became a
CLI with a rich, tested process model instead, and the desktop should use that model rather than
fight it (§5.2). State of `@capybara-hq/device` at `b9c01fe0` (`0.1.0-rc.16`):

### 4.1 What exists

| Need | Today |
|---|---|
| Device authorization | `login --url <url> [--no-browser] [--dir] [--mode os\|docker]`: RFC 8628 shape against `POST /api/v1/device/authorize` and `/token`; the person confirms on `<web>/devices/link?code=…` (org, new or existing device, disclosure). `normalizeUrl` keeps an origin plus path prefix. Refuses while logged in ("logout first") |
| The URL opener | `LoginDeps.openBrowser` (injectable, used by tests); not exported: `src/index.ts` exports only `runCli`, `parseCommandLine` and the `Credential` / `Policy` / `SandboxMode` types and `stateDir` |
| Serving | `start` (foreground, reconnects with backoff forever, exit 0 only for a deliberate stop), `stop` (SIGTERM), `drain [--wait] [--timeout]` (SIGUSR2: no new operations, exit when the running ones finish) |
| One runner | A pid file in the state directory, verified with `ps` (`PROGRAM_BIN = "capybara-device"` must appear in the command line, start time after the file); `start` refuses while another runner lives. One per **state directory**, not per deployment |
| Login service | `service install\|uninstall\|start\|stop\|restart\|status` (launchd agent `top.capybara.device`, systemd user unit); the service file records `process.execPath` and the package's `bin`; `restart` applies an upgrade |
| Status | `status [--json]`: logged in or not, `url`, `orgId`, `deviceId`, `dir`, `mode`, `sandboxMode`; read from files, so it says nothing about the live connection |
| Owner ceiling | `ceiling show`; `ceiling set --full-access allow\|deny --project-reach workspace\|os-user [--yes]` (a widening prints the risk text and needs `--yes` or a `y`); the deployment may only narrow it (`server-ops.ts` refuses widening) |
| Local policy | `policy show\|set\|add\|remove` (`allowedDomains`, `allowCredentials`, `cpu`, `memoryMb`) under `policy.json.lock`; the runner re-reads `policy.json` on change |
| Credential | `credential.json`, mode 0600, refused when other users can read it; holds `url`, `connectUrl` (from the token response), `orgId`, `deviceId`, `dir`, `mode`, grace and frame limit |
| Command log | `commands.log` (0600, rotated at 10 MiB): one line per command and policy change, never a command's text |
| Runtime attestation | The restricted runtime is attested at binding time by hashing the **installed package files** against `dist/runtime-manifest.json`, from locations the device resolves itself |

### 4.2 What the desktop needs and does not have

| Gap | Why | Proposed change in `packages/device` |
|---|---|---|
| Live status and running operations (required: the app attaches to a service it does not host) | The bridge's `device@1.status` / `device@1.running` (§8) and the tray need the connection state (connecting, online, offline with the last error, draining), the bound device and what runs now. `status --json` reads files only; `Connection` has only `done`, `drain()`, `stop()`; there is no event stream | The runner opens a **control socket** `<stateDir>/control.sock` (Unix socket, 0600 in the 0700 state directory; checked like `credential.json`), JSON lines: `status`, `running` (tag, conversation id, account id, `restricted` / `full`, started at; never command text, like the command log), `subscribe` (status changes), `drain`, `stop`. `status --json` adds the live fields when a runner answers **(designer's call)** |
| Machine-readable login | The app must open the verification URL in the profile's own window and know when login ends; scraping the "Open … and confirm the code …" line is fragile | `login --json`: JSON lines `{ "event": "verification", "url", "userCode", "expiresIn" }`, then `{ "event": "done", "deviceId", "orgId" }` or `{ "event": "error", "code" }`; implies `--no-browser` |
| Keep-awake | §9.7: the CLI and headless servers need it too, so it belongs to the program, not the app | `policy.json` field `keepAwake: "off" \| "while-busy" \| "connected"` (default `while-busy`) and `capybara-device keep-awake off\|while-busy\|connected [--yes]`; the runner holds the OS assertion (§9.7) and reports its state on the control socket |
| Machine-readable ceiling and service state | The device page shows the ceiling from the kernel's owner report, but the app must decide whether a requested change widens it, and whether a service is installed | `ceiling show --json` and `service status --json` (the facts `service status` prints today) |
| Several deployments | One `credential.json` per state directory: a machine user is connected to one deployment at a time | None in D2: the app connects this machine to one deployment at a time and says so (§9.3). Per-deployment state is a later change **(designer's call)** |
| OS keychain | The draft wanted the credential in the keychain; it is a 0600 file, which Full access commands can read (the login risk text says so) | None in D2; a keychain store is a later device change for CLI and app alike |

Dropped from the draft: a library API (`login()` / `start()` returning promises), a per-deployment
lock, and an outside-policy confirmation hook. The control socket is the one way the app (and the
CLI's live `status`) reaches a runner, whoever started it.

## 5. Architecture

```
┌──────────────────── Desktop app (Electron, apps/desktop) ────────────────────┐
│ main process                                                                 │
│   profiles · windows · tray · deep links · updates · native dialogs         │
│   bridge (IPC, origin-checked) · runs device CLI commands                    │
│        │                                   │                                 │
│        │ control.sock · service install    │ BrowserWindow per profile        │
│        ▼                                   ▼                                 │
│                                           renderer: address page (app://)    │
│                                           renderer: deployment web app       │
└────────┼──────────────────────────────────────────┼───────────────────────────┘
         ▼                                          │
  launchd user agent top.capybara.device            │
  bundled Node ─ capybara-device start              │
  (Resources/node, Resources/device)                │
         │ wss /device/connect (outbound)           │ https (pages, /api/*)
         ▼                                          ▼
     web tier ─▶ kernel gateway role          web tier ─▶ kernel api
```

### 5.1 Repository and stack

- **Repository `capybara-hq/clients`** **(decided)**, a pnpm monorepo replacing the planned
  `capybara-hq/desktop`: `apps/desktop` now, `apps/mobile` (Capacitor) later, and
  `packages/shell` for what both share: deployment address normalization and discovery, the login
  hand-off, deep link parsing, notification routing and the Shell environment values. It follows
  the organization's conventions (Conventional Commits, changesets, `issue-linked`, the shared
  skills from `capybara-hq/.github`) and releases applications, not npm packages.
- **Dependencies**: the published `@capybara-hq/device` (an exact version, upgraded deliberately)
  and Electron. Never the kernel, never `@capybara-hq/design` **(decided)**. `docs/architecture.md`
  in core lists the clients repository as an external app (HTTP only).
- **Electron** **(decided)**: the device program and `@anthropic-ai/sandbox-runtime` are Node; a
  Rust shell would need a Node runtime next to it anyway.
- **macOS first** **(decided)**; Windows and Linux later (§11).

### 5.2 The device runs as a login service; the app is its UI (decided)

The app never hosts the runner. Connecting this machine installs the device as the login service
(the existing `service install`: a launchd user agent `top.capybara.device` on macOS, a systemd
user unit on Linux) and starts it; the app then attaches through the control socket (§4.2) for
status, the running list and actions. Closing the window or quitting the app never stops the
device.

Packaging facts that follow from the current program:

- The app ships the published `@capybara-hq/device` **unmodified** under
  `Contents/Resources/device/`, outside ASAR: runtime attestation hashes the installed package
  files from locations the program resolves itself, so they must be the published bytes on disk.
- It ships a signed Node runtime (≥ 22.12, the package's floor) under `Contents/Resources/node`
  (hardened runtime with the JIT entitlements Node needs, notarized with the app). The app runs
  every device command as `node …/bin/capybara-device.mjs <command>`; `service install` records
  `process.execPath` and the package `bin`, so the plist points at the app's Node and the app's
  copy of the program. The app binary itself never acts as Node (§7.2).
- An app update that changes the bundled device ends with `service restart` (the way the device
  applies an upgrade) when the service runs the app's copy. Moving or deleting the app breaks the
  service; the app checks `service status --json` at start and reinstalls the service from its new
  location when the plist points at a missing path.
- A service installed with the CLI (a global npm Node) is used as is; the app shows its version
  and offers to switch it to the app's copy (`service install` from the app replaces the plist).
- The CLI and the app share the state directory (`$XDG_CONFIG_HOME/capybara-device`): a machine
  connected in a terminal shows as connected in the app and the other way round. A runner started
  in a terminal is reached through the control socket like the service.
- The login service runs while the person is logged in (screen locked included); after a reboot
  it starts at login. A boot-time daemon running before anyone logs in is out of scope: it would
  run outside the owner's account, whose files and ceiling the device serves.

## 6. Connecting to a deployment

### 6.1 Address page

- Plain HTML, CSS and a small script served from the app's `app://` scheme, with a strict CSP and
  no network access except the discovery call **(decided: no `@capybara-hq/design`)**. It follows
  the OS light or dark appearance with two hand-written color sets; zh and en strings (§12).
- One field: the deployment address as typed into a browser. Normalization (in `packages/shell`):
  add `https://` when no scheme is given, keep the port, keep a path prefix (as `normalizeUrl` in
  the device does).
- **`http` only for loopback** (`localhost`, `127.0.0.1`, `::1`); every other address must be
  `https`, and certificate errors cannot be bypassed (the connector rule: https only, loopback
  exempt).
- The page calls discovery (§6.2), shows the deployment's name when it has one, saves the profile
  and loads the deployment in the shell. From then on every screen is the deployment's; a profile
  without a session lands on the deployment's sign-in page, which offers only the browser sign-in
  (§6.5).

### 6.2 Discovery endpoint (kernel change)

The kernel has no public description of itself today (only `/healthz`, `/readyz`, `GET
/api/v1/setup`, `GET /api/v1/platform/theme`). Add one, reached through the web tier's `/api/*`
proxy:

```
GET /api/v1/meta   (@Public, cache-control: no-store)
{
  "name": "Example Corp",            // platform.name, or null when unset
  "protocols": {
    "device": { "min": 3, "max": 3 }  // DEVICE_PROTOCOL_VERSION range of the gateway
  },
  "features": { "localDevices": true, "appSignIn": true }
}
```

- `name` is a new deployment config field `platform.name` (env `CAPYBARA_PLATFORM__NAME`; not
  secret, hot; unset = null, and the app shows the host) **(decided: the name is returned before
  sign-in)**. Not under `web.*`, which holds the web tools' settings.
- Protocol ranges, not the kernel build version, so the public endpoint does not reveal the exact
  version **(designer's call)**.
- No gateway URL: the token response already carries `connectUrl`, and the web tier proxies
  `/device/connect` to the gateway (`apps/web/src/lib/device-connect-proxy.ts`).
- No shell range: skew between the web and the app is carried by the Shell environment's
  `version` and capability keys (mobile layout §9.2): a web that does not know a capability
  ignores it, a shell that lacks one is treated as the browser. A missing endpoint (an older
  kernel) counts as "not a Capybara deployment or too old".
- The route gets a Platform-tool exclusion (category `transport`: pre-sign-in discovery for
  clients, nothing for an agent to do).

### 6.3 Profiles

- Several profiles, each with its own Electron session partition (cookies, storage, cache).
  Switching profiles switches windows, not accounts inside one session.
- The profile switcher is in the app menu and the tray. The last used profile opens at start;
  「添加平台」 opens the address page.
- Removing a profile clears its partition and, if this machine is connected to that deployment,
  asks natively whether to disconnect and log the device out too.

### 6.4 Managed configuration and deep links

- A managed configuration (macOS managed preferences; later the Windows registry or a JSON file
  next to the app) may list profiles, lock the app to them (`lockDeployments: true`), turn
  automatic updates off or point them at an internal feed, and turn 「连接本机」 off.
- Deep links: `capybara://connect?url=<address>` opens the address page prefilled and **never
  connects silently**: the person sees the address and confirms (a crafted link could otherwise
  send someone to a look-alike deployment). `capybara://open?url=<deployment page>` focuses the
  matching profile and navigates there when the URL is on its origin.

### 6.5 Sign-in through the system browser (decided; details designer's calls)

The app has no sign-in of its own and never signs in inside the window. It uses the
authorization code flow with PKCE for native apps (RFC 8252, RFC 7636), the same idea as
`capybara-device login`: the person authenticates where their password manager, SSO session and
security keys already are, and the app only receives a one-time code.

**Flow**

1. The person clicks 「在浏览器中登录」 on the deployment's sign-in page in the window
   (`signIn@1.start()`, §8). The main process creates `state` and a `code_verifier` (32 random
   bytes each), keeps them with the profile for 10 minutes, and opens the system browser at
   `<origin>/apps/authorize?client=desktop&redirect_uri=capybara://auth/callback&code_challenge=<S256>&code_challenge_method=S256&state=<state>&name=<machine name>`.
2. The web page `/apps/authorize` (an auth route like `/devices/link`) signs the person in if
   needed (password or SSO, unchanged), then shows one confirmation: 「在 <机器名> 上的 Capybara
   桌面端登录 <平台名称>？」 with the account and 「登录」/「取消」. Confirming calls
   `POST /api/v1/app-auth/authorize`; the page then navigates to the returned redirect.
3. The browser hands `capybara://auth/callback?code=…&state=…&iss=<public URL>` to the app. The
   main process accepts it only for a pending `state`, checks `iss` equals the profile's origin
   (mix-up defence, RFC 9207), and drops the pending entry (one use).
4. The main process calls `POST /api/v1/app-auth/token` with `{ code, codeVerifier, redirectUri }`
   through the profile's own session (Electron `net.fetch` of that partition), so the kernel's
   `Set-Cookie` lands in the partition's cookie jar; the body carries only the account. The window
   reloads, signed in. No token passes through a renderer or the app's own storage.

**Redirect: a custom scheme, not loopback** **(designer's call)**. A loopback redirect needs a
listening port on the machine, which §3 rules out, and a firewall prompt on some systems. The
known weakness of a custom scheme (another app registering `capybara://`) is covered by PKCE: a
code caught by another app cannot be exchanged without the verifier, which never leaves the main
process. The callback page in the browser says 「已返回 Capybara，可以关闭此页」.

**Kernel side**

| Route | Access | Does |
|---|---|---|
| `POST /api/v1/app-auth/authorize` | Signed-in person, human only (`HUMAN_ONLY`), CSRF header | Body `{ client, redirectUri, codeChallenge, codeChallengeMethod: "S256", state, name }`. Refuses a `redirectUri` not in `auth.appRedirectUris` and any method but S256. Issues `code` (`cap_ac_` + 32 random bytes), stores its sha256 in Redis for 60 s with the account, the browser session id, `client`, `redirectUri`, `codeChallenge` and `name`; answers `{ redirect }` (the URI with `code`, `state`, `iss`). Audit `auth.app_authorized` (client, name) |
| `POST /api/v1/app-auth/token` | `@Public`, rate-limited per IP like `/auth/login` | Body `{ code, codeVerifier, redirectUri }`. `GETDEL` of the code (one use; a second try is `app_auth.code_invalid`), checks expiry, `redirectUri` and `S256(codeVerifier)`; refuses a disabled account; creates a session with `SessionService.create` and sets `cap_at` / `cap_rt` like `/auth/login`; answers `{ account }`. Audit `auth.app_signed_in` (client, name, session id) |

- **Binding**: the code is bound to its PKCE challenge, to the redirect URI, to this deployment
  (the exchange works only on the kernel that issued it; `iss` lets the app check where it came
  from) and, through `state`, to the profile that started it. Lifetime 60 s, single use, stored by
  hash; Redis keys carry a TTL, so any replica can exchange it (multi-replica rule).
- **Config**: `auth.appRedirectUris` (list, default `["capybara://auth/callback"]`, not hot). A
  fork that ships its own build under another scheme adds its URI here.
- **Which session the window gets**: an ordinary web session, one row in the sessions table like a
  browser sign-in, with the same cookies, refresh rotation and lifetimes
  (`auth.accessTokenTtlSeconds`, `auth.refreshTokenTtlDays`). It is a separate session from the
  browser's (signing out in one does not sign out the other); its `user_agent` records
  `Capybara Desktop/<version> (<machine name>)` so it is recognisable wherever sessions are shown.
  Revoking it, a password change (which revokes sessions) or a disabled account end it as any
  session.
- **Sign-out and expiry**: the web's sign-out calls `/api/v1/auth/logout` as in a browser; the
  window lands on the sign-in page, which offers the browser flow again. When the refresh fails
  (expired or revoked), the same happens: the person re-runs the browser flow. The shell removes
  the profile's cookies when the profile is removed.
- **Enforcement in the window**: the shell blocks requests from the profile's window to
  `POST /api/v1/auth/login` and `GET /api/v1/auth/sso/*/start` (a `webRequest` filter on the
  partition), so even a web version that shows the form cannot sign in inside the window. The app
  refuses a deployment whose `/api/v1/meta` lacks `features.appSignIn` (「该平台版本过旧」).
- **Platform-tool exclusions**: both routes. `authorize`: interactive consent by the person in
  the browser; `token`: transport (an app exchanges a one-time code, nothing for an agent to do).
- **Reused for the device (D2)**: the window's session is what makes 「连接本机」 a single
  confirmation: the device's `/devices/link` page opens in the profile's partition, already signed
  in (§9.2). Confirming a device code is a deployment page's consent, not a sign-in, so it stays
  in the window.

## 7. The shell

### 7.1 Loading and navigation

- The shell loads the profile's origin in a `BrowserWindow` with the profile's partition.
  First-run setup and invitations are the deployment's own pages **(decided)**; sign-in is the
  browser flow of §6.5.
- Top-level navigation may leave the origin in the same window for connector OAuth, a full-page
  redirect through the provider and back. Off the origin the shell injects nothing (§8).
- `target=_blank` and `window.open` to other origins open in the system browser (http and https
  only); same-origin ones open a new shell window of the profile (file previews, shared pages).
- The app sets no user-agent token of its own; the web never reads the user agent (§7.3).

### 7.2 Security baseline

- `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, no `<webview>`.
- Injection and the per-call origin check follow the Shell environment's security rule (mobile
  layout §9.4): the preload injects `window.capybaraShell` only into the top frame of the
  profile's exact origin, and the main process re-checks every IPC call against
  `event.senderFrame`.
- Permission requests (notifications, microphone, camera, clipboard) are granted only to the
  profile origin, and only for the permissions the web app uses.
- Electron fuses: `RunAsNode` off, `EnableNodeOptionsEnvironmentVariable` off,
  `EnableNodeCliInspectArguments` off, ASAR integrity on, cookie encryption on. The bundled Node
  (§5.2) is a separate signed executable, so the app binary never doubles as a Node interpreter
  with the app's privacy grants.
- Distribution is Developer ID outside the Mac App Store: the OS sandbox the device uses
  (`sandbox-exec`) cannot run inside the App Sandbox.

### 7.3 The desktop in the Shell environment

Shape, versioning, the injection rule, the no-flash script, the `--cb-shell-inset-*` /
`--cb-inset-*` tokens, drag regions in design CSS and the `lib/shell.ts` adapter are the mobile
layout design's §9 (with §7.5 for the inset tokens); nothing here redefines them. The desktop's
values:

| Field | Desktop value |
|---|---|
| `version` | `1` |
| `kind` | `"desktop"` |
| `platform` | `"macos"` (later `"windows"`, `"linux"`) |
| `shellVersion` | The app's version |
| `insets` | macOS with `titleBarStyle: "hiddenInset"`: `top` 28 (the title bar band holding the traffic lights at their default position), `right` / `bottom` / `left` 0. In fullscreen: `top` 0, announced with `change` |
| `controls` | macOS: the traffic lights' rectangle at the app's fixed `trafficLightPosition`, including their margins: `{ x: 0, y: 0, width: 80, height: 28 }` (exact values measured once on the built window, **designer's call**); `null` in fullscreen, announced with `change`. Later Windows / Linux builds report their title-bar overlay buttons the same way |
| `capabilities` | `notify@1`, `openExternal@1` and `signIn@1` always; `chrome@1` (mobile layout §9.2: window background and title bar follow the theme); `device@1` when 「连接本机」 is available: macOS or Linux, not turned off by managed configuration, and the deployment's `/api/v1/meta` says `localDevices` with a `device` range the bundled program speaks |

The AppShell clears the window controls from `--cb-shell-controls-*` (mobile layout §9.3); no
geometry is keyed on `data-shell-platform`. The desktop's remaining choice, realized in design CSS
**(designer's call)**: the sidebar head, the top bar and the conversation title bar are drag
regions, every interactive element in them `no-drag`. The shell adds no drag regions of its own.

## 8. The desktop's capabilities

Offered on `window.capybaraShell.capabilities` under the rules of mobile layout §9.2 and §9.4: the
web reads them only through `lib/shell.ts` (`useShellCapability("device@1")`, reactive: `device@1`
can appear after the page loaded, once discovery answered), and treats an absent one as the
browser. Every call returns plain data, never a credential.

| Capability · function | Does |
|---|---|
| `notify@1.notify({ title, body, path? })` | OS notification; a click focuses the shell and navigates to `path` (same origin only) |
| `openExternal@1.open(url)` | Opens an http(s) URL in the system browser |
| `signIn@1.start()` | Starts the browser sign-in of §6.5 for this profile; resolves `signedIn` (the window then reloads), `cancelled` or an error code. Needs a user activation; nothing is confirmed natively (it grants the page nothing) |
| `device@1.status()` / `device@1.onStatus(cb)` | For this machine: `not_connected`, `connected_elsewhere` (logged in to another deployment: its origin only), or connected to this deployment with `deviceId`, `orgId`, run mode (`os` / `docker`), connection state (`starting`, `online`, `offline` + reason, `draining`, `stopped`), the keep-awake mode and whether an assertion is held (§9.7), the last wake. From `status --json` and the control socket |
| `device@1.running()` | What runs on this machine now (control socket `running`): tag, conversation id, account id, isolation, started at; no command text |
| `device@1.connect({ orgId, deviceId? })` | Asks natively first (§9.1); on yes, runs the authorization of §9.2; resolves `connected`, `cancelled` or an error code |
| `device@1.pause()` | Drain: no new operations, the runner stops when the running ones finish; the service stays stopped |
| `device@1.resume()` | `service start`; asks natively first, like connect |
| `device@1.disconnect()` | `service stop` (or `stop` for a terminal runner): stops now, running operations end |
| `device@1.requestCeiling({ fullAccess, projectReach })` | A narrowing applies at once (`ceiling set …`); a widening shows the native confirmation with the program's risk text (§9.5) and applies only on yes |
| `device@1.setKeepAwake(mode)` | A lower mode (`off` < `while-busy` < `connected`) applies at once; a higher one asks natively first (§9.7) |

Deliberately absent: the credential, file access, command execution, `policy add`
`allowedDomains` from the page (the deployment already has its own narrowing-only policy
operations through the device protocol), and logging the device out (revoking is the device page's
existing kernel action, which stops the runner through the protocol).

The confirming calls (`connect`, `resume`, a widening `requestCeiling`, a higher `setKeepAwake`) follow the confirmation
rule of mobile layout §9.4: a user activation, one native dialog at a time, `busy` otherwise.

## 9. 「连接本机」

### 9.1 The flow

1. On the 设备 page, 新建设备 → 本地设备 shows, when `useShellCapability("device@1")` returns it, a
   primary 「连接本机」 above the terminal steps (which stay, for other machines). If this machine
   is already connected to this deployment, the dialog shows that device's state and a link to its
   page instead; if it is connected to another deployment, it says so and offers nothing but the
   terminal steps.
2. A click calls `device@1.connect({ orgId })` with the org the person is in.
3. The shell shows a **native confirmation** **(decided)**, parented to the window: 「允许
   <平台名称>（<host>）在这台电脑上运行命令吗？」 with a detail line: what a local device is, that
   it starts restricted (no Full access, the device's workspace only) and that it can be
   disconnected from the tray at any time; that it keeps serving while the app is closed (a login
   service) and keeps the computer awake while operations run (§9.7). Buttons 「允许」/「取消」. The name is the discovery
   name (`platform.name`) when set, else only the host.
4. On 「允许」 the shell runs `capybara-device login --json --url <origin>` (§4.2) on the bundled
   Node.

### 9.2 Authorization reuses the window's session

- The verification URL (`/devices/link?code=…`) opens in a child window of the profile's partition,
  so the signed-in person is not asked to sign in again. The shell appends `org=<orgId>`; the link
  page preselects that org and 新建设备 named after the machine (a core change, §13), so the person
  reads the disclosure and confirms in one step. The page stays the deployment's: it may still let
  the person pick another org or an existing device.
- On `done` the child window closes, the shell installs and starts the login service (§5.2) and `device@1.onStatus`
  reports `online`; the web's 新建设备 dialog then sees the new device (it already polls the device
  list) and opens its page.
- The credential is written by the program to its own `credential.json`; it never enters a
  renderer, and the main process only relays the child's JSON events, which never carry it.

### 9.3 One runner, one deployment

- The control socket (and the program's pid file behind it) tells the shell whether a runner
  lives. An existing runner (a CLI-installed service, a terminal) is used, never doubled.
- A machine user is connected to one deployment at a time (§4.2). Connecting to a second one asks
  natively to disconnect the first (`logout`, after stopping its runner); the first deployment's
  device stays registered there until someone deletes it.

### 9.4 Lifecycle

- The device runs as the login service from connect until the person pauses, disconnects or the
  device is revoked; the window and the app's lifetime do not matter.
- Quitting the app only ends the UI (the tray goes away); nothing is asked about running
  operations, because they keep running.
- The app starts at login only when the person turns that on in the app menu (off by default)
  **(designer's call)**; the device does not need it.

### 9.5 Local policy: remote can only tighten

- Through the bridge the web may read status, list what runs, pause, disconnect and narrow the
  owner ceiling **(decided)**.
- Widening (Full access allowed, project reach `os-user`) and resuming need a native
  confirmation; the widening dialog shows the device program's own risk text
  (`FULL_ACCESS_RISK_TEXT`, `CEILING_WIDENING_TEXT`) and the shell then runs
  `capybara-device ceiling set … --yes`. Editing `policy.json` or running the CLI on the machine
  stays the other way.
- The deployment's own policy operations over the device protocol are unchanged (they narrow the
  ceiling and maintain `allowedDomains` within the org's allowlist, logged in `commands.log`).

### 9.6 Where state is shown

- The deployment's device page shows the machine's state as it does today (the kernel's view),
  plus, when `device@1.status` says the device is this machine, 「本机」, the live running list from
  `device@1.running`, 暂停 / 断开 / 恢复, the keep-awake choice (§9.7), and a widen action that goes
  through `device@1.requestCeiling` (instead of the `capybara-device ceiling set` line it shows in a
  browser).
- The device list and the conversation's device picker mark this machine 「本机」.
- The tray icon shows not connected, online, offline, paused and busy. Its native menu: the
  profiles, the connection state, the number of running operations, 暂停 / 恢复 / 断开 (resume with
  the same native confirmation), keep-awake, open the device page, quit (the device keeps
  running).

### 9.7 Keep-awake (decided; modes and confirmation designer's calls)

A device that sleeps serves nothing. Keep-awake is a feature of the device program, so the CLI
and headless servers have it too; the desktop surfaces it through `device@1`.

- **Modes** in `policy.json` (`keepAwake`) and `capybara-device keep-awake off|while-busy|connected`:
  `off`; `while-busy` (default **(designer's call)**: the machine stays awake while operations run
  and may sleep when idle, which spares the battery of a laptop nobody uses); `connected` (awake the
  whole time the runner is connected, for a machine meant to be reachable at any time).
- **How**: macOS: the runner holds an IOPM assertion `PreventUserIdleSystemSleep` (what
  `caffeinate -i` takes; the runner spawns `/usr/bin/caffeinate -i -w <runner pid>`, so the
  assertion dies with the runner and no native addon is needed **(designer's call)**); the display
  may still sleep and the screen still locks. Linux: `systemd-inhibit --what=idle:sleep --mode=block`
  around a child that lives as long as the assertion; without `systemd-inhibit` or when logind
  refuses, the status says `unavailable` with the reason and nothing pretends.
- **What it cannot prevent**, stated in the CLI's output, the device page and the native dialog:
  closing the lid of a Mac on battery without an external display (clamshell) still sleeps; so do
  choosing Sleep, a critically low battery and thermal emergencies; on Linux, the lid switch as
  logind handles it (taking `handle-lid-switch` needs privileges the user service lacks).
- **Sleep and wake are visible, not hidden**: when the machine sleeps the WebSocket stops; the
  kernel sees the device offline after the connection's liveness timeout, exactly as for a lost
  network, and operations follow the existing reconnect-grace rules. On wake the runner reconnects
  with its usual backoff; it notes the wake (a wall-clock jump against the monotonic clock) in its
  status and `commands.log`, so the device page can say 「电脑曾休眠」 rather than an unexplained
  gap. No new protocol frame.
- **Remote may lower, not raise** **(designer's call)**: through `device@1` the web may set a lower
  mode at once; a higher mode needs the native confirmation of mobile layout §9.4. Raising it
  changes the machine's power behaviour and battery life and lengthens the time the machine is
  reachable for remote commands, which is a widening in the sense of §9.5; lowering only narrows
  both. The deployment's policy operations do not touch `keepAwake`.



## 10. Notifications

Runs that need attention (an approval, a question, a finished background run) reach the person
through the web's existing signals; when `notify@1` is present the web also calls
`notify@1.notify`, so they show while the window is hidden. A click navigates to the
conversation.

## 11. Distribution and updates

- **macOS first** (universal, Developer ID signed, notarized) **(decided)**; Windows (signed; the
  device runs in WSL or Docker there, so `device@1` is absent on native Windows until a design says
  otherwise) and Linux (AppImage, deb) later. No macOS-only API where a cross-platform one exists.
- Signing certificates and the app id are arranged by the maintainer **(decided)**; the working
  app id is `com.capybarahq.desktop`.
- **Only the official app** is published: the Capybara name and icon, fixed **(decided)**. There
  is no white-label product; the repository is open source, and an organization that wants its
  own brand forks it and signs and publishes its own build. To make that easy, the brand (name,
  icons, app id, URL scheme, signing identity, update feed) lives in one file of `apps/desktop`
  **(designer's call)**; a fork that changes the scheme registers its redirect URI in
  `auth.appRedirectUris` (§6.5).
- The Dock icon stays the Capybara icon **(designer's call)**: switching it to a deployment's icon
  at runtime would need a deployment icon the kernel does not have, and the window title already
  names the platform.
- Updates: automatic from GitHub Releases by default; managed configuration may turn them off or
  point at an internal feed. An update that changes the bundled device runs `service restart` when
  the service runs the app's copy (§5.2).
- Compatibility comes from discovery (§6.2) and the device protocol's own 426 answer, not from
  matching versions; the app has its own version line.

## 12. Internationalization

The app's own strings are few: the address page, native dialogs, the tray and app menus. They live
in one zh / en catalog in `packages/shell` with a key-sync check like core's `check:i18n`, and
follow the repository terms: 平台, 超级管理员, 智能体, 设备 / 本地设备 / 本机; never 企业 or the
Latin word `agent`. The language follows the OS; everything else is the deployment's i18n.

## 13. Security summary

| Threat | Measure |
|---|---|
| A malicious or compromised page drives the machine | No execution, files or credential in the bridge; connect, resume and widening need a native confirmation under the rule of mobile layout §9.4; the Shell environment security rule (mobile layout §9.4) |
| A page connects the machine silently | Native dialog naming the platform and host before any login (§9.1) |
| A page loosens the local policy | Only narrowing applies directly; widening shows the program's risk text natively (§9.5) |
| A misled agent runs harmful commands | Unchanged: the permission profile, the owner ceiling, the restricted runtime, the deployment's command review; plus one-click pause and disconnect from the tray |
| A stolen sign-in code or a hijacked `capybara://` scheme | PKCE (the verifier never leaves the main process), 60 s single-use codes stored by hash, `state` and `iss` checked, redirect URIs allowlisted (§6.5) |
| A crafted deep link points to a look-alike deployment | Deep links prefill only; the address and the discovery name are shown (§6.4) |
| Device credential theft from disk | Unchanged from the CLI (0600 file, never in a renderer); revocable from the device page; keychain later (§4.2) |
| Tampered app or runtime injection | Code signing, notarization, fuses, ASAR integrity; the device package unmodified and attested (§5.2, §7.2) |
| A page keeps the machine awake | Raising keep-awake needs a native confirmation; lowering is free (§9.7) |
| Two runners fight over one deployment | The program's pid file and the control socket; the app uses an existing runner (§9.3) |

## 14. Core changes

| Where | Change |
|---|---|
| `packages/kernel` | `GET /api/v1/meta` (§6.2), `@Public`, no-store, tested through the web proxy; a Platform-tool exclusion (`transport`); new config field `platform.name` (`adding-config`: schema meta, `docs/config.md` regenerated) |
| `packages/design` | Shell environment support comes with the mobile layout design (§9.3 there); this spec adds only the desktop's drag regions (§7.3); controls clearance comes from `--cb-shell-controls-*` |
| `apps/web` | Typed accessors for `device@1` and `notify@1` on `useShellCapability` in the shell adapter `lib/shell.ts` (the adapter itself, the plugin-sdk types and the no-flash script come with the mobile layout design), `defineQuery` for `device@1.status` / `device@1.running`, `useAppMutation` for the actions); `DeviceCreateDialog` local branch: 「连接本机」 or this machine's state (§9.1); the device page's 本机 section and widen-through-bridge action (§9.6); 本机 marks in the device list and picker; `notify@1` for attention signals (§10); zh / en messages (`check:i18n`) |
| `packages/kernel` sign-in | `POST /api/v1/app-auth/authorize` and `/token` (§6.5): Redis codes, PKCE, sessions through `SessionService.create`, audit events, error codes `app_auth.*`, two Platform-tool exclusions, `features.appSignIn` in meta; config `auth.appRedirectUris` |
| `apps/web` sign-in | The `/apps/authorize` page (sign in if needed, one confirmation, redirect); the sign-in page shows only 「在浏览器中登录」 when `useShellCapability("signIn@1")` returns it; zh / en |
| `apps/web` `/devices/link` | Honour `org=<orgId>`: preselect the org and 新建设备 named after the machine (§9.2) |
| `packages/device` | The gaps of §4.2: the control socket and live `status --json`; `login --json`; `ceiling show --json`; `service status --json`; keep-awake (`keepAwake` policy field, `keep-awake` command, the macOS and Linux assertions, wake notes in status and `commands.log`); README and tests; a changeset |
| `docs/architecture.md` | `capybara-hq/clients` (desktop, later mobile) as an external app in its own repository |

## 15. Phases

| Phase | Content | Depends on |
|---|---|---|
| **D1 Shell** (macOS) | `capybara-hq/clients` with `apps/desktop` and `packages/shell`; address page; `/api/v1/meta`; browser sign-in (§6.5, kernel and web); profiles; shell security; navigation rules; the Shell environment values; `notify@1`, `openExternal@1`, `chrome@1`; deep links; managed configuration; signing and updates | `/api/v1/meta`; the app-auth routes; the AppShell side of the Shell environment (mobile layout design) |
| **D2 Connect this machine** | Bundled Node and device package; the login service from the app; `device@1`; native dialogs; 「连接本机」 and the device page's 本机 section in core web; `/devices/link?org=`; keep-awake; tray | The `packages/device` gaps of §4.2 |
| D3 Windows and Linux | Builds, signing, installers; `device@1` on Linux (WSL / Docker on Windows) | D2 |
| Later | Mobile (Capacitor) in the same repository; several connected deployments per machine user; keychain credential; a virtual-machine sandbox mode; local MCP servers on the device (own design) | — |

The order of D1 and D2 inside each phase is the designer's call; D1 does not wait for D2's core
changes.

## AGENTS.md rules touched

- **Platform tool**: the new routes `GET /api/v1/meta`, `POST /api/v1/app-auth/authorize` and
  `POST /api/v1/app-auth/token` get exclusions with reasons (§6.2, §6.5).
- **Multi-replica**: app sign-in codes live in Redis with a 60 s TTL and are taken with `GETDEL`,
  so any replica can exchange them (§6.5).
- **Web UI**: apps/web adapts only through design's AppShell and capability detection; no styles,
  no user-agent checks; new reads and writes go through `defineQuery` / `useAppMutation` (§7.3,
  §14).
- **Language / i18n**: new web copy in zh and en (「连接本机」, 「本机」); the app's own catalog
  follows the same terms (§12).
- **Dependency direction**: the clients repository is an external app (kernel HTTP only) and
  depends on the published `@capybara-hq/device`; it imports neither the kernel nor
  `@capybara-hq/design` (§5.1).
- **Sandboxes**: no inbound port; the control socket is a local Unix socket in the owner's private
  state directory (§3, §4.2).
- **Config**: the new fields `platform.name` (§6.2) and `auth.appRedirectUris` (§6.5), with the
  `CAPYBARA_` naming and regenerated `docs/config.md`.

## 16. Decisions and open questions

Decided by the maintainer:

1. Electron (§5.1); macOS first (§11); the maintainer arranges signing and the app id (§11).
2. Repository `capybara-hq/clients` (desktop now, mobile later, shared `packages/shell`); no React
   Native (§5.1).
3. The desktop draws no UI: only the plain-HTML address page; setup and onboarding are the
   deployment's web in the window (§3, §6.1, §7.1).
4. The web adapts through the Shell environment contract (mobile layout §9; the desktop values in §7.3).
5. 「连接本机」 in the 新建设备 flow, with a native confirmation naming the platform (§9.1).
6. Remote can only tighten; no local settings windows (§9.5, §3).
7. `/api/v1/meta` returns the platform name before sign-in, from a config field (§6.2).
8. The device runs as a login service the app installs and attaches to; the window closing never
   stops it (§5.2, §9.4). The desktop offers keep-awake, a device feature (§9.7).
9. Sign-in only in the system browser: authorization code with PKCE, a deep link back, a one-time
   code exchanged for the window's session (§6.5).
10. Only the official app is published; a brand of one's own means a fork (§11).

Open: none at the moment.
