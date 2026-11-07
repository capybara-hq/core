# Desktop client

- Date: 2026-11-07, written against `main` at `76b32e10`.
- Status: draft for review. Implementation starts after phase 2 (connected personal environments)
  of the environments design has shipped.
- Builds on: the environments design (`2026-11-07-environments-design.md`, branch
  `feat/environments`), mainly §6 (connected environments, `@capybara-hq/device`). This document
  lifts that design's non-goal "a desktop app or tray UI for the connector program" (§3) and its
  "no local confirmation UI" (§6.4) for the desktop only; everything else there stands.
- Markers: **(decided)** is the maintainer's answer in the 2026-10-19 and 2026-11-07 discussions;
  **(designer's call)** is decided here and may be overturned in review.
- Written in English (AGENTS.md "Language"); UI copy is quoted in Chinese where it matters.

## 1. Why

Capybara reasons in the cloud. The agent loop, the event log, policies, credentials and metering
all live in the kernel. A person's machine contributes **hands, not a brain**: the environments
design makes a machine a *connected environment* whose commands the kernel sends over an outbound
WebSocket. Today that takes a command line program (`capybara-device login`, `start`,
`service install`).

A desktop app gives people two things the command line does not:

1. One window with everything the web app does, plus OS integration: notifications, a tray, deep
   links and a global shortcut.
2. Connecting the machine in one click, with a visible, local place to see what agents are running
   on it and to stop them.

This is the opposite of Claude Code, where the agent runs locally and remote access is the add-on.
It is closer to the Claude desktop app, which loads its web UI from the cloud. The difference is
that Claude's local MCP tools are relayed through the page, so they work only while the app shows
the conversation. Capybara's kernel reaches the machine directly, so a conversation bound to the
machine keeps working from the web or an IM channel while the machine is online.

## 2. Terms

- **Desktop app**: the installable application, in its own repository `capybara-hq/desktop`.
- **Shell**: the desktop app's window that loads a deployment's web app.
- **Start page**: a local page bundled in the app that asks for a deployment address.
- **Deployment profile**: one deployment the app knows. It holds the address, the display name and
  a separate browser session.
- **Bridge**: the small API the shell exposes to the deployment's web pages (§8).
- **Embedded device**: the `@capybara-hq/device` runtime running inside the desktop app (§9).
- **Local settings**: windows rendered from the app's own local pages, never from the deployment.
  Policy and machine settings live here.

## 3. Goals, non-goals, anti-goals

Goals:

1. Everything the web app does, by loading the deployment's own web app. No second copy of the
   UI, and no version skew between UI and kernel **(decided)**.
2. A start page that asks for the deployment address, for example `https://capybara.example.com`
   or `http://localhost:3000` **(decided)**.
3. Connecting this machine as a connected environment by embedding `@capybara-hq/device`
   **(decided)**. The device protocol, the execution modes and the local policy stay exactly as in
   the environments design.
4. Several deployments side by side, each with its own session.
5. Local transparency and control: what runs on this machine now, pausing, disconnecting, and
   editing the local policy.

Non-goals:

- An agent loop, a local kernel or an offline mode. A local single-machine deployment was
  considered and rejected as too heavy **(decided)**.
- Bundling the web app.
- Local stdio MCP servers on the device. They need their own design: `sandbox@2` carries
  commands, not MCP.
- A virtual-machine sandbox mode (the Claude app ships one on macOS). It is a later option (§14).
- Mobile apps.

Anti-goals (a failure even if it works):

- The device credential, the file system or command execution reachable from any web page,
  including the deployment's own pages.
- The bridge available to any origin other than the profile's deployment origin.
- A remote page that can loosen the local policy or answer a local confirmation.
- Any inbound port on the machine. The control socket of §9.3 is local-only, not network.
- Two device runners serving the same deployment on one machine.

## 4. What the device package must offer

The desktop app embeds `@capybara-hq/device` rather than spawning the CLI and parsing its output.
The environments phase 2 plan should therefore build the package as **a library plus a thin CLI**
**(designer's call)**. The CLI should only parse arguments and call the library. The library needs:

| Need | Why the desktop needs it |
|---|---|
| `login(url, { openAuthorizationUrl })` with the URL opener injected | The app opens the authorization page in its own window, using the profile's session (§9.2) |
| `start()`, `drain()`, `stop()`, `logout()` returning promises | Lifecycle driven by the app |
| A status event stream: connection, environment, mode, running commands, last error | Tray, status window, activity list |
| Policy read, validate and write | Local settings window (§9.5) |
| `service install` / `uninstall` / `status` | "Stay connected when the app is closed" |
| A credential store interface: OS keychain by default, file fallback for headless servers | Desktop and CLI share one credential |
| A per-deployment lock in the shared config directory | One runner per deployment per machine (§9.3) |
| A local control socket in the runner (Unix socket `0600` / named pipe) | The desktop attaches as UI to a runner it did not start (§9.3) |
| A hook for operations outside the policy, defaulting to "refuse" | Local confirmation (§10), later |

None of this changes the wire protocol or the kernel.

## 5. Architecture

```
┌──────────────────────── Desktop app (Electron) ────────────────────────┐
│ main process                                                           │
│   profiles · windows · tray · deep links · updates · bridge (IPC)      │
│        │                                                               │
│        ├─ utility process: embedded device ──wss (outbound)──┐         │
│        │    (@capybara-hq/device library)                    │         │
│        │                                                     │         │
│ renderers                                                    │         │
│   start page / local settings  (local, @capybara-hq/design)  │         │
│   shell: deployment web app    (remote, origin-checked bridge)│        │
└──────────────────────────────────────────────────────────────┼─────────┘
                        https (pages, /api/*)                  │
                               ▼                               ▼
                        web tier ─▶ kernel api          kernel gateway role
```

- **Electron** **(decided)**. The device package and `@anthropic-ai/sandbox-runtime` are
  Node, and Electron runs them in-process with no sidecar binary. Tauri would need a bundled Node
  runtime next to a Rust shell. Electron's size cost is acceptable for a desktop app.
- **The embedded device runs in an Electron `utilityProcess`** **(designer's call)**, not in the
  main process. A device crash then leaves the windows alive, and the main process restarts it.
- **Repository**: its own, `capybara-hq/desktop` **(decided)**, so native build tooling, signing
  and three-OS CI stay out of core. It is released as an application, not on npm. It depends only
  on published packages: `@capybara-hq/device` and `@capybara-hq/design` (start page and local
  settings only), never the kernel. **`@capybara-hq/design` is private today and must be published
  to npm before D1** (§15). Its version range is pinned in the desktop repository and upgraded
  deliberately, like any external dependency. `docs/architecture.md` in core lists the desktop app
  as an external app (HTTP only) in the capybara-hq organization.

## 6. Connecting to a deployment

### 6.1 Start page

- One field: the deployment address, as the person types it into a browser.
- Normalization: add `https://` when no scheme is given, strip paths, keep the port.
- **`http` only for loopback** (`localhost`, `127.0.0.1`, `::1`); every other address must be
  `https`, and certificate errors cannot be bypassed. This is the same rule as connectors (https
  only, loopback exempt).
- The page calls the discovery endpoint (§6.2), shows the deployment's name, and saves the profile.

### 6.2 Discovery endpoint (kernel change)

The kernel has only `/healthz` and `/readyz` today. Add a public endpoint, reached through the web
tier's `/api/*` proxy:

```
GET /api/v1/meta   (@Public)
{
  "name": "Example Corp",                 // the platform's display name
  "protocols": {
    "desktop": { "min": 1, "max": 1 },    // bridge and app compatibility
    "device":  { "min": 1, "max": 1 }     // device protocol (environments §6.3)
  },
  "deviceGatewayUrl": "wss://gw.example.com/device",
  "features": { "connectedEnvironments": true }
}
```

- It returns protocol ranges, not the kernel build version, so the public endpoint does not reveal
  the exact version to attackers **(designer's call)**.
- `deviceGatewayUrl` matters because the gateway role may sit on another host than the web tier,
  and the app must not guess it. The CLI can use the same endpoint, so `login --url` also takes
  the web address.
- An app outside `protocols.desktop` shows 「请升级客户端」 and does not load the shell.

### 6.3 Profiles

- Several profiles, each with its own Electron session partition (cookies, storage and cache
  isolated). Switching profiles switches windows, not accounts inside one session.
- The profile switcher lives in the app menu and the tray. The last used profile opens at start.
- Removing a profile clears its partition and, if this machine is connected to that deployment,
  asks whether to disconnect it too.

### 6.4 Preconfiguration and deep links

- A managed configuration (macOS managed preferences, the Windows registry, a JSON file next to
  the app) may list profiles and lock the app to them (`lockDeployments: true`).
- Deep link `capybara://connect?url=<address>` opens the start page prefilled. **It never connects
  silently**: the person sees the address and confirms, because a crafted link could otherwise
  send someone to a look-alike deployment.

## 7. The shell

### 7.1 Loading and navigation

- The shell loads the profile's web origin in a `BrowserWindow` with the profile's partition.
- Top-level navigation may leave the origin (SSO login goes through an identity provider). The
  bridge is still safe because **every IPC call is checked in the main process against
  `event.senderFrame.origin`**, and only the profile's exact origin is served. Frames, including
  extension embeds under `/plugin-ui`, are checked the same way and are refused unless they are the
  top frame on the profile's origin.
- `target=_blank` and `window.open` to other origins open in the system browser (http and https
  only).

### 7.2 Security baseline

- `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, no `<webview>`.
- Permission requests (notifications, microphone, camera, clipboard read) are granted only to the
  profile origin, and only for the permissions the web app uses.
- Electron fuses: `RunAsNode` off, `EnableNodeOptionsEnvironmentVariable` off, ASAR integrity
  validation on, cookie encryption on.
- Local pages are served from a custom `app://` scheme with a strict CSP and no network access
  except the discovery call.

### 7.3 Web app changes

The web app stays a plain web app; it only feature-detects `window.capybaraDesktop`:

- The 新建环境 dialog's connected-environment guide shows 「连接这台电脑」 (calls
  `device.connect`) instead of the install command when the bridge is present.
- The environment picker marks the environment that is this machine (「本机」).
- Notifications for runs that need attention (an approval, a question, a finished background run)
  go through `notify` when the bridge is present.

These live in a small `desktop` adapter in apps/web; without the bridge every page behaves as in a
browser.

## 8. Bridge API (version 1)

Exposed with `contextBridge` as `window.capybaraDesktop`, and served only to the profile origin
(§7.1):

| Call | Does |
|---|---|
| `info()` | App version, platform, bridge version |
| `device.status()` / `device.onStatus(cb)` | For this profile: `not_connected` / `online` / `offline` / `paused`, the environment id and name, the mode |
| `device.connect({ environmentId? })` | Starts the authorization of §9.2 in an app window; resolves when done or cancelled. Returns no credential |
| `device.openSettings()` | Opens the local settings window (§9.5) |
| `notify({ title, body, conversationId? })` | OS notification; a click focuses the shell on that conversation |
| `openExternal(url)` | System browser, http and https only |

Deliberately absent: policy editing, disconnecting or revoking, the credential, file access and
command execution. A compromised or misled page can therefore start an authorization, which the
person still confirms, but cannot widen what the machine allows or act on it. Disconnecting is a
local action (tray, local settings) so that a page cannot quietly take the machine offline either.

## 9. Embedded device

### 9.1 What it is

The same runtime as `capybara-device start`, configured from the profile: deployment address,
`deviceGatewayUrl` from discovery, credential from the shared store. Modes (OS sandbox, Docker),
the local policy file, reconnect grace and offline behaviour are exactly the environments design
§6.3–§6.4.

### 9.2 Authorization

- `device.connect`, the tray or the local settings start the library's `login`. The authorization
  URL opens in an app window **using the profile's session**, so a signed-in person only confirms.
  The page states what the environments design §6.2 requires: who may run commands here and what is
  sent to the cloud.
- The machine receives the device credential (environments §6.2). It is separate from the web
  session, is stored by the library's credential store (OS keychain), and never enters a renderer.
- The default environment directory is chosen in this flow (`~/capybara-device/<environment>`,
  changeable).

### 9.3 One runner per deployment

- Desktop and CLI share the config directory and the credential store, so a machine connected with
  the CLI shows as connected in the app and the other way round.
- The library's per-deployment lock allows one runner. If a runner is already running (a launchd or
  systemd service, or a foreground `capybara-device start`), the app **attaches** through the local
  control socket and acts as its UI instead of starting a second one.

### 9.4 Lifecycle

- The embedded device runs while the app runs. The app starts at login when the person enables
  「开机启动」 (off by default) **(designer's call)**.
- 「关闭窗口后保持接入」 installs the user-level service through the library; the app then
  attaches to it. Turning the option off uninstalls the service.
- Quitting while commands are running asks: wait (drain), or stop them now.

### 9.5 Local settings

These are local pages built from `@capybara-hq/design`, never loaded from the deployment:

- Per profile: connection state, environment, mode (OS sandbox / Docker), environment directory,
  allowed domains, which local credentials commands may use (none by default), CPU and memory
  ceilings, program version, the log.
- Actions: 暂停接入 (drain: refuse new commands, finish running ones), 断开 (stop), 移除这台电脑
  (logout and revoke the credential server-side).
- Policy edits go through the library's validation and write the same policy file the CLI uses.
  The cloud still can only tighten it (environments §6.4).

### 9.6 Activity and the tray

- The tray icon shows online, offline, paused, and a busy state while commands run.
- The tray menu lists running commands, each with its conversation, its agent and a stop button,
  and opens the conversation in the shell.
- The local settings keep the last 200 commands executed on this machine, so the person can see
  what agents did here without opening the web app.

## 10. Local confirmation (later phase)

The environments design refuses every operation outside the local policy, because nobody may be at
the machine. The desktop can add a middle ground, as an opt-in per policy rule: 「我在电脑前时询问」.

- The prompt is a **native window from the main process**, never web content. It shows the
  conversation, the agent, the person who started it, and the exact command or path.
- "At the machine" means the app is running and the OS reports user input within the last 5
  minutes. Otherwise the request is refused at once.
- No answer within 60 seconds means refused, the same failure-is-denial rule as approvals.
- Answers: allow once, or refuse. Lasting changes go through the local settings, so a stream of
  prompts cannot be clicked into a permanent hole.
- It plugs into the library's outside-policy hook (§4). The protocol does not change, because the
  device answers the operation after the decision, within the command timeout.

## 11. Distribution and updates

- Platforms: **macOS first** (universal, signed and notarized) **(decided)**. Windows (signed) and
  Linux (AppImage and deb) follow in a later phase. The design keeps them in mind: no macOS-only
  API is used where a cross-platform one exists, and the embedded device already supports Linux and
  WSL (environments §6.4).
- Signing certificates (Apple Developer ID, later Windows code signing) and the app id are arranged
  by the maintainer **(decided)**; the working app id is `com.capybarahq.desktop`.
- Updates: automatic from GitHub Releases by default. A managed configuration can turn automatic
  updates off or point them at an internal feed.
- Compatibility comes from discovery (§6.2): the app refuses deployments outside its desktop
  protocol range, and the device refuses gateway protocols it does not speak (environments §6.3).
- CI and releases live in the desktop repository. It follows the repository conventions of the
  capybara-hq organization (Conventional Commits, changesets, `issue-linked`, the shared skills from
  `capybara-hq/.github`). The app has its own version line; compatibility with deployments is
  carried by the protocol ranges, not by matching versions.

## 12. Internationalization

zh and en. The app's local pages have their own small message catalog, with a key-sync
check in the desktop repository like core's `check:i18n`. The zh UI follows the repository terms: 平台,
超级管理员 and 智能体, never 企业 or the Latin word `agent`.

## 13. Security summary

| Threat | Measure |
|---|---|
| A malicious or compromised page drives the machine | The bridge exposes no execution, no files, no credential and no policy editing (§8); origin checked per IPC call (§7.1) |
| A misled agent runs harmful commands | Unchanged from the environments design: OS sandbox or Docker, the local policy that the cloud can only tighten; plus local visibility and a one-click stop (§9.6) |
| A crafted deep link points to a look-alike deployment | Deep links prefill only and need confirmation (§6.4); the deployment name from discovery is shown |
| Local confirmation clicked through | Native window, presence check, 60 s timeout, allow-once only (§10) |
| Device credential theft from disk | OS keychain; never in a renderer; revocable from the environment page and from the app |
| Tampered app or runtime injection | Code signing, notarization, Electron fuses, ASAR integrity (§7.2) |
| Two runners fight over one deployment | Shared lock and attach mode (§9.3) |
| Data leaves the machine unnoticed | The authorization page says what is sent (environments §6.2); activity list (§9.6) |

## 14. Phases

| Phase | Content | Depends on |
|---|---|---|
| **D1 Shell** (macOS) | Start page, discovery endpoint, profiles, shell security, navigation rules, notifications, deep links, managed configuration, signing and updates | The discovery endpoint and a published `@capybara-hq/design` |
| **D2 Embedded device** | Library integration, one-click authorization, attach mode, lifecycle and service, local settings, tray and activity, the web adapter's 「连接这台电脑」 and 「本机」 | Environments phase 2 shipped, with the library API of §4 |
| **D3 Local confirmation** | §10 | D2 and the outside-policy hook |
| D4 Windows and Linux | Builds, signing, installers, the WSL / Docker device modes in the app | D2 |
| Later | A virtual-machine sandbox mode (Apple Virtualization, WSL2 / Hyper-V); local MCP servers on the device (needs its own design) | — |

The maintainer has decided that the desktop work waits until the environments work is done
**(decided)**. D1 does not technically need to wait, but it is scheduled after environments phase 2
with D2.

## 15. Changes in core

| Where | Change |
|---|---|
| `packages/kernel` | `GET /api/v1/meta` (§6.2), public, with an error-code-free response and a test through the web proxy |
| `@capybara-hq/device` (environments phase 2) | Library plus thin CLI, with the API of §4 |
| `apps/web` | `desktop` adapter: bridge detection, 「连接这台电脑」, 「本机」, notifications (§7.3) |
| `packages/design` | Published to npm (drop `private`, add it to the release workflow and changesets) |
| `docs/architecture.md` | The desktop app as an external app in its own repository |

## 16. Resolved and open questions

Answered by the maintainer on 2026-11-07:

1. Electron (§5).
2. Its own repository, `capybara-hq/desktop` (§5).
3. The maintainer arranges the signing certificates and the app id (§11).
4. macOS first; Windows and Linux in D4 (§11, §14).

Open:

1. Should `/api/v1/meta` return the platform's display name before sign-in, or should the start
   page show only the address until the person signs in (§6.2)?
2. Publishing `@capybara-hq/design`: as a supported public package with semver guarantees, or as
   an unstable `0.x` package documented as "for Capybara's own apps" (§5)?
