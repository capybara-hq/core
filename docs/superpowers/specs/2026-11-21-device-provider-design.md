# Device providers: one extension point, many implementers, many connections per machine

Status: draft for maintainer review (2026-11-21). Repositories: capybara-hq/core, capybara-hq/plugins,
capybara-hq/clients. Supersedes the parts of the desktop client spec
(`2026-11-07-desktop-client-design.md`) §8 and §9 that assume one connection per machine, and the
parts of the approval-only profiles and project root designs named in §12.

## 1. Why

A technician serves two groups that each run their own Capybara, or belongs to two orgs of one
platform. They want their laptop to be the local device of each, used by each side's agents, at
the same time. The maintainer hit the small version of it today: this Mac's `capybara-device` is
connected to prod, so the local dev platform's 新建设备 dialog can only say "connected to another
platform" and print three commands.

Looking at why one machine can hold only one connection showed a deeper asymmetry: the local
device is a kernel-internal provider (`@local`) with its own pages, settings and flows, while cloud
devices come from a single `sandbox@2` plugin. Two cloud providers cannot coexist, a third party's
own virtualization cannot sit next to docker, and every device page branches on "local or cloud".
The maintainer's direction (2026-11-21): **a device is one thing with one contract; docker, e2b
and local are implementers of it, as plugins, side by side.** The local implementer then supports
many connections per machine as its own feature.

## 2. Terms

- **Device provider**: an extension implementing the extension point `device-provider@1`
  (replaces `sandbox@2`). Official ones: `device-docker`, `device-e2b`, `device-local`.
- **Device**: a record in an org, created by one provider and bound to it for life
  (`devices.provider`). Unchanged meaning: one file system kept until deleted, plus an instance.
- **Dial-in device**: a device whose machine connects to the deployment (the local provider's,
  or any provider that ships its own agent program). The kernel's **dial-in channel** (§5) carries
  it.
- **Connection** (local provider only): one (deployment, org, device) a machine is connected to.
  One machine may hold many; each is a separate device on its deployment.
- **Shell**: the desktop app's `window.capybaraShell` (desktop spec §7, §8). The shell capability
  keeps its name `device@…` (§9); the extension point is `device-provider@…`, so the two do not
  collide.

## 3. Goals, non-goals, anti-goals

Goals

1. One extension point, `device-provider@1`, with `multi` cardinality. Several providers are on in
   one org at once; 新建设备 asks which one. A device keeps its provider for life.
2. Each provider ships a connection guide (markdown, the existing setup-guide format) shown in
   新建设备. docker / e2b guides are short (a name, then 新建); the local guide carries the install,
   sign-in and start steps (today's hard-coded terminal steps).
3. The kernel keeps what must be uniform and trusted: approvals (the conversation's permission
   profile), the command review, the network allowlist and network asks, project roots, locking,
   suspension and destruction, and a generic dial-in channel (machine sign-in, credentials,
   revocation, online status, request relay across replicas).
4. How a sandbox is enforced is the provider's. A cloud container may be its own boundary with no
   inner sandbox; the local provider aligns with Claude Code (§7).
5. One device detail page for every provider: overview, network, projects, delete. No "sandbox"
   command lines, no "machine / disconnect this machine" section.
6. Network aligned with Claude Code: open (the public internet, closed address classes) or an
   allowlist where new hosts ask; org and platform ceilings act as managed settings; one setting
   in the kernel for every device.
7. The local provider holds many connections per machine (different deployments, different orgs
   of one deployment), isolated from each other, each with its own credential, state, service and
   limits. No migration of existing machines or deployments (maintainer, 2026-11-21: nothing was
   ever released, so no compatibility): §7.4.
8. (Withdrawn 2026-11-23: the desktop's 「连接本机」 and tray rows are gone; desktop and shells
   manage no devices, §9.)

Non-goals

- A sandbox on/off switch like Claude Code's `/sandbox`. A provider decides whether it sandboxes;
  the conversation's permission profile decides who approves crossings (maintainer, 2026-11-21).
- One device shared by two orgs. Two orgs = two devices (§6.5).
- Kernel-enforced CPU / memory budgets across connections (§8.4).
- Windows-native local devices (unchanged).

Anti-goals (a failure even if it works)

- A connection reading another connection's state, credential, working directory or logs through
  sandboxed work.
- A provider plugin holding machine credentials or long connections itself: the trust-critical
  part stays one kernel implementation.
- A page learning which other deployments this machine is connected to (today's
  `connected_elsewhere` leaks the origin; it goes away).
- The device page growing back per-provider sections.

## 4. Approaches considered

The hard part of the local device is its transport: the gateway's `/device/connect` WebSocket,
the Redis relay across replicas, machine credentials and revocation, the sign-in page.

- **A. Move all of it into `plugin-device-local`.** The SDK would gain WebSocket upgrade routes,
  long-connection holding and a cross-replica relay for one implementer, and the credential and
  revocation logic would leave the kernel. Largest SDK surface, security-critical code in a plugin.
- **B. The kernel keeps a generic dial-in channel; the plugin keeps the device semantics.**
  (chosen, maintainer 2026-11-21.) The kernel owns sign-in (RFC 8628 shaped), credentials,
  revocation, the lease that means "online", and request/response relay. `device-local` owns the
  guide, the protocol frames and what they mean, the owner ceiling, and the Claude Code alignment.
  docker / e2b never touch the channel. A third party's agent program can use it too.
- **C. Keep `@local` in the kernel, only allow several cloud providers.** Least work, but the local
  device stays special everywhere, which is what the maintainer wants gone.

## 5. The dial-in channel (kernel)

The existing generic parts of `packages/kernel/src/local-devices` become the module
`packages/kernel/src/dial-in` (designer's call on the name); the local semantics move to the plugin
(§7). Split, from the current code:

| Stays in the kernel (generic) | Moves to `device-local` |
|---|---|
| `device-auth*` (code flow, `/devices/link`, throttling), minus `createLocal` and the `@local` hard-code | hello payload meaning (roots, mode, home, features, owner ceiling, recent ops) |
| `machines.ts`: issue, authenticate, revoke / revokeActive, activeFor, touch, disconnect | protocol 4 frames and parsers (`device-protocol.ts` leaves the SDK's core exports, §10) |
| `device-routes.ts` (`GET /device/connect`, bearer before upgrade, protocol header) | `local-device-provider.ts`, `instance-bindings.ts` |
| gateway holder: lease, claim, ping, takeover, reauth, close codes | `policy-summary.ts` (what the machine reports of its own narrowing) |
| relay request / response lists, cancel, reconnect grace; `keys.ts`; `targets.ts` | `owner-report*` |

The kernel → machine policy ops (`device-policy.service.ts`, `policy-op-jobs.ts`, the `policy`
request, `POST /orgs/:orgId/devices/:id/policy`) are deleted, not moved: they existed so the web
could narrow the machine's network, which is now the kernel's device setting (§6.3). A change the
owner makes on the machine reaches the kernel as a report revision (§6.7).

Contract to providers (SDK, `DialInChannel` on the provider's `ctx`; exact shape the builder's):

- A provider declares `dialIn: { protocol: "<name>/<major>" }` in its manifest permissions. The
  channel's `/device/connect` routes a connection to the provider whose device the credential
  belongs to and checks the protocol header against that provider's declaration (426 on mismatch).
- `ctx.dialIn.request(deviceId, frame, { signal, timeoutMs })` relays one request to whichever
  replica holds the machine and resolves its response; `deviceOffline` when no holder within the
  reconnect grace.
- `ctx.dialIn.onHello(deviceId, hello)` and `onFrame` deliver what the machine sends (opaque JSON
  to the kernel, bounded by `maxFrameBytes`); the provider answers with its device report (§6.2).
- `ctx.dialIn.stop(deviceId, reason)` and revocation stay kernel actions: deleting the device (or
  the machine signing in to the same device elsewhere) revokes the credential and closes 4003 /
  4002 as today.
- The sign-in confirm page lists the providers that declared `dialIn` and are on in the org; a
  confirm creates the device with that provider (`createLocal` becomes `createDialIn(provider)`).

Data: `device_machines` stays the credential table (data locations keep their names). Generic
columns stay (`credential_hash`, `device_id`, `org_id`, `program_version`, `os`, `arch`,
`boot_id`, `last_seen_at`, `revoked_at`); provider-specific facts (`features`, `local_policy`,
`owner_report`, `pending_policy_ops`, `home`, `roots`, `mode`) move behind the provider: either a
`provider_state jsonb` written only through the channel, or the plugin's own `plugin_device_local`
schema (builder's call; the old columns go by expand-then-contract).

The rule "another machine signing in to the same device replaces the first" is the partial unique
index `device_machines_active_uq` and `issue` revoking the active row; it is unchanged.

## 6. The extension point `device-provider@1` (SDK + kernel)

### 6.1 Contract

`device-provider@1` is today's `SandboxProvider` (permission v2 members, lifecycle, I/O,
background, `list` / `scan`) renamed, with `multi` cardinality and these changes:

- **Device report** replaces the kernel's local-only reads (`owner_report`, `program_version`
  checks in `permission-facts.ts`, `home` in project scope). A provider answers
  `report(handle) → { description, outsideSandbox, network: { allowlist, perOperationHosts },
  home?, limits?, reset }`:
  - `description`: one localized line for the device page ("Reads the whole machine except
    secrets; writes only in the project; runs outside the sandbox only per approved call").
  - `outsideSandbox`: whether a per-call escalation can be granted on this device now (the local
    provider answers its owner ceiling; a container provider usually `false`).
  - `network.allowlist` / `perOperationHosts`: what it can enforce (§6.3). `perOperationHosts`,
    reported but unused today, becomes the gate for per-call host grants.
  - `home`: the base the project picker starts from (local OS mode), else the workspace.
  - `limits`: limits the provider or the machine's owner applies on top (shown, read only).
  - `reset`: whether "重建文件" exists (today cloud only).
- **Scope**: an operation's scope carries `projectRoot` (the conversation's working directory, its
  write boundary and where AGENTS.md, skills, hooks and MCP config load from: project root
  design, maintainer 2026-11-14) plus `writeRoots` (project root, workspace). Read roots are no
  longer sent: what a sandboxed operation may read is the provider's rule. Writes outside
  `writeRoots` keep going through the command review and per-call escalation.
- **Project paths**: the kernel's `restrictedProjectReach`, `withinMode` and the hidden-project
  count go. Adding a project asks the provider (`list(path, { limit: 1 })` as today); a provider
  may refuse a path with a reason (`project.refused`, text from the provider), e.g. the local
  provider refusing another connection's directory (§7.2).
- **Guide**: a provider may declare one setup guide at the new place `device-connection` (§6.4).
- **Dial-in**: optional `dialIn` (§5).

### 6.2 Kernel: devices bound to their provider

- `SandboxProviders.cloud()` and `providerForDevice → cloud()` go. `DeviceProviders.forDevice`
  resolves `devices.provider` (a plugin name) to that loaded provider, or "unavailable" (the
  device page and tools say the provider is off or uninstalled; files are kept).
- The "current cloud provider" concept goes with it: `demotedFrom`, `stranded`,
  `demoted_from_provider`, `otherProvider` refusals, and `cloudAvailable` become "which providers
  are on in this org". Sweeps (`suspendIdle`, `destroyInactive`, `reconcileMarked`) iterate per
  provider over that provider's rows.
- **Which providers an org can use** is the catalog's existing scope: a provider plugin is
  `all` / `optional` / `named` and switchable per org; its deployment config may carry org
  overrides (`orgAccess`). No new setting.
- **The person's default device**: a platform setting `devices.defaultProvider` (a provider plugin
  name or empty) names the provider that makes a person's default device; an org may override it
  among the providers on in it. Empty: no automatic default; the person creates one. (Designer's
  call; replaces "the current cloud provider makes it".)
- **No compatibility** (maintainer, 2026-11-21): `device-docker` / `device-e2b` / `device-local`
  are new plugins. A deployment installs and configures them afresh; devices whose `provider` names
  `sandbox-docker`, `sandbox-e2b` or `@local` read as unavailable (their provider is not loaded) and
  are deleted or recreated by their owners. No migration renames rows, catalog items or config, and
  no alias for the old names exists.

### 6.3 Network: aligned with Claude Code

Claude Code: with its sandbox on, an allowlist of domains through a proxy, where a new domain stops
and asks; with it off, an unrestricted network; managed settings can pin either. We have no
sandbox switch, so the two become the two network modes, for every provider (maintainer,
2026-11-21: the open mode stays):

- **Modes**: `open` (the public internet) and `allowlist` (the device's hosts; a new host asks),
  as today. The address-class rules (private, loopback, metadata, NAT64 closed; the fake-IP DoH
  fallback) apply in both modes, which makes `open` narrower than Claude Code with its sandbox off.
  Existing devices, orgs and platform settings keep their mode; nothing migrates.
- **Ceilings as managed settings**: the platform and org ceilings (`devices.network.*`, the org
  device network setting, the egress kill switch) stay as they are and may hold a device to
  `allowlist`.
- **One setting in the kernel for every device**: mode and hosts live in `devices.network_mode` /
  `network_hosts` for every device, edited on the device page's 网络 section by the device's owner
  (and org admins for org devices), clamped to the ceilings. A local device's network is no longer
  kept on the machine; a new local device starts from the org default like a cloud device.
- **A new host asks** (the existing network asks, migration 0114): the conversation's profile
  decides who approves (the person, the review model, or full access auto-approves, recorded),
  as Claude Code's prompt does. The approval offers "this run" or "add to this device's list".
- **Enforcing an allowlist is part of the contract**: a ceiling may require `allowlist`, so a
  provider that cannot enforce one does not load (`device-provider@1` requires
  `network.allowlist: true`); `openPublic` stays optional, as today (a provider without it gets
  `allowlist` under every ceiling). docker and e2b already enforce one (the docker egress proxy; e2b
  `allowOut` + `denyOut 0.0.0.0/0`); the e2b metadata-service residual stays documented as today.
- **"This run" needs per-operation hosts**: the ask offers "this run" only on a provider reporting
  `perOperationHosts` (the local provider). On an instance-boundary provider (docker, e2b) the only
  grant is "add to this device's list", applied through `update` or at the next instance per the
  provider's `limitsApplyAt`, exactly as a list edit on the device page is today; the ask says
  when it takes effect.
- **The machine's own narrowing**: the local provider may still narrow on the machine
  (`capybara-device` per-connection policy, §7.3): the machine intersects the kernel's list with
  it. It never widens. Shown read only under `limits` on the device page.

Decision for review: today only the machine's owner can widen a local device's network, on the
machine; after this, the device's owner widens it on the web, as for cloud devices. The owner is
the same person, and widening is still bounded by org and platform ceilings and recorded; the
machine owner keeps a local narrowing. (Designer's call; listed in §14.)

### 6.4 Connection guides in 新建设备

- New setup-guide place `device-connection` in `SETUP_GUIDE_PLACE_INFO`: audience `member`;
  variables `{{publicUrl}}`, `{{orgId}}`, `{{orgName}}`, `{{pluginName}}`; `::check` rows allowed
  (e.g. "this machine is signed in"). One guide per provider.
- Guides are plain markdown; the existing renderer (`SetupGuideSection`) shows them. (The
  `::shell-action connect-this-machine` directive this section first added was removed on
  2026-11-23 with the shell's device integration, §9.)
- 新建设备: one card per provider on in the org (its `displayName` and `description`), then the
  chosen provider's guide. A provider without `dialIn`: a name field and 新建 (today's cloud flow).
  A dial-in provider: no name field; the dialog waits for the new device (today's 3 s poll of the
  device list) and opens it.
- `device-local`'s guide is today's `LocalSteps` moved to markdown (install, `login --url
  {{publicUrl}}`, start / `service install`). "Connected to another
  platform" and "connected to your other org" disappear: connecting again adds a connection.

### 6.5 Same person, two orgs, one machine

Two devices, one per org, each with its own credential row (they are different `device_id`s, so
`device_machines_active_uq` does not collide). Revoking or deleting one never touches the other.
The kernel has no machine identity across devices and gets none (a shared identity would let one
org learn about the other).

### 6.6 The device page

```
MacBook-Pro.local            device-local · 在线 · v0.2.0 · 最后活跃 …
──────────────────────────────────────────────────────────────────
概览   the provider's description line, its read-only limits, files,
       recent changes
网络   open / allowlist, the hosts (add / remove), within the org ceiling
项目   list, add (provider refusals shown), no hidden count
       重建文件 (only when report().reset) · 删除设备
```

Removed: the 沙箱 settings section with its command lines (`DeviceModeSection`'s
`SANDBOX_COMMANDS`, `LocalSandbox`, widening rows), the 机器 section and its route
`DELETE /orgs/:orgId/devices/:id/machine` (signing in again replaces the machine; deleting the
device revokes it), the 资源 section for cloud (becomes `limits`), `projects.hidden`.

### 6.7 Trust and authority after the move

Today `operation-authority.ts`, `permission-facts.ts`, `permission-runtime-reports.ts`,
`permission-authority-epochs.ts` and `legacy-retirement.ts` branch on `location: "local" |
"cloud"` and `LOCAL_PROVIDER`. After this change (designer's call):

- **A provider is trusted like every extension** (in-process, full trust). `device-local`'s
  `report()` is believed by the kernel exactly as docker's is. **The machine is not trusted**:
  `device-local` validates every hello and frame (today's parsers and the runtime identity / applied
  facts checks move into it) before it reports anything.
- **Reports carry a revision.** `report()` returns `revision` (opaque, changes whenever anything in
  it changes: the local owner changing a ceiling on the machine, a machine replaced, an instance
  rebuilt); the provider calls `ctx.devices.reportChanged(deviceId)` when it changes. The kernel's
  device authority epoch, which today bumps on a local ceiling change, bumps on a changed report
  revision for every provider, invalidating in-flight approvals and grants as today. The epoch
  model stays in the kernel and becomes provider-neutral.
- So step 2 (§11) is a rewrite of the `local` / `cloud` branches into one path driven by the
  report, not a file move; it is the trust-boundary task reviewed alone.

## 7. The local provider (`device-local` + `capybara-device`)

### 7.1 Claude Code alignment (the provider's own rule)

- **Reads**: the whole machine, minus a deny list: secret paths (as today: `~/.ssh`, cloud CLI
  credentials, `~/.netrc`, `~/.gnupg`, browser profiles), this program's state directory, and
  every other connection's state and working directory (§7.2). Claude Code's sandboxed reads are
  the same shape (everything minus denied paths).
- **Writes**: `writeRoots` only (project root and workspace), as Claude Code writes only in the
  working directory. The protected write chains and reserved staging prefix stay.
- **Network**: the kernel's list intersected with the connection's own narrowing, through the
  per-operation proxy, address classes closed (unchanged mechanism).
- **Outside the sandbox**: per approved call, only when the connection's owner ceiling allows it
  (`capybara-device ceiling set --outside-sandbox on`, CLI only); off for a new connection.
- **Project reach** becomes per connection: `machine` (default, the read rule above),
  `paths` (a list of directories: reads and projects only there, plus tool directories; for
  connections that must not see each other's code), or `workspace`. Set on the machine
  (`capybara-device ceiling set --project-reach machine|paths|workspace`,
  `policy add projectPaths <dir>`). The kernel only sees refusals and the description line.

### 7.2 Many connections per machine

**Process model** (designer's call): **one runner and one login service per connection.**
Compared with one runner serving all connections:

| | one runner per connection (chosen) | one runner for all |
|---|---|---|
| crash or upgrade restart | affects one connection | stops all |
| code change | small: state paths and service names become per connection | a multiplexer over sockets, sessions, journals |
| keep-awake | each holds its own assertion; the OS combines them | one holder |
| shared budget | none (none is enforced today in OS mode either) | possible later |

**State layout** (`$XDG_CONFIG_HOME/capybara-device`, mode 0700):

```
machine.json                 machine-wide: { "version": 1 }
run/<hash16>.sock            each connection's control socket (sha256 of the device id; short path)
connections/<deviceId>/      mode 0700, one per connection
  credential.json            url, connectUrl, credential, orgId, deviceId, dir, mode, …
  policy.json                the connection's owner ceiling, narrowing, keepAwake, cpu/memoryMb
  policy.json.lock, commands.log, service.log, pid
```

Working directories stay `~/capybara-device/<deviceId>` (already per device). Docker mode
containers stay `capybara-device-<deviceId>`.

**Commands** (`--connection <deviceId|name|host>`, `-c`): `login --url <url>` always adds a
connection, except when the person picks a device this machine already serves: then that
connection's credential is replaced in place (same directory, same policy). Two connections of
one device on one machine are refused locally. `status` lists all connections (one line each:
host, org name, device name, state); `status -c X --json` one. `logout`, `start`, `stop`, `drain`,
`ceiling`, `policy`, `keep-awake`, `service install|…` take `-c`; with exactly one connection it
is implied; with several and none given they refuse and list them. `service install -c X` writes
the launchd label `top.capybara.device.<deviceId>` (systemd `capybara-device@<deviceId>.service`).

**Isolation**: each runner adds every other connection's `connections/<id>/` and working
directory to its restricted deny list (read and write), re-read when connections are added or
removed. Sandboxed temp directories and the sandboxed `HOME` (`<dir>/home`) are already per
device. `commands.log` is per connection. A directory both connections list as a project is
allowed (the owner's choice); `status` and the device page mark it "also used by another
connection on this machine" without naming it. An escalated call runs as the OS user and can read
everything: when other connections exist, `ceiling set --outside-sandbox on` adds that to its risk
text.

**Unchanged rules**: a device has one active machine; signing in to it from another machine
replaces the first; revocation, deletion and close codes as today.

### 7.3 Per-connection limits

Owner ceiling, network narrowing, project reach, `keepAwake`, `cpu` / `memoryMb` (docker mode:
`--cpus` / `--memory` per container, as today) are per connection, in that connection's
`policy.json`. The deployment may only narrow them, as today. Nothing is machine-wide except the
deny list of other connections and `machine.json`.

### 7.4 Existing machines

No migration (maintainer, 2026-11-21). The new program reads only the `connections/` layout; an old
flat `credential.json` / `policy.json` is ignored and `status` says the machine has no connection.
The owner runs `capybara-device login` again (into a new device, or into their existing one, which
replaces its old credential as any re-login does) and `service install`. The old launchd agent
`top.capybara.device` / systemd unit `capybara-device.service` is not touched by the program; its
`start` finds no connection and exits 0, so its manager leaves it stopped; the owner removes it with
the old program's `service uninstall` before upgrading, as the upgrade note says.

## 8. Resources

- Each connection's runner holds its own keep-awake assertion by its own mode; the machine stays
  awake while any wants it.
- docker mode: per-connection container limits as today.
- OS mode: no CPU / memory enforcement (unchanged; noted in the guide). A per-connection
  concurrency cap is left for later if real use shows contention.

## 9. Desktop and shells don't manage devices

Maintainer decision 2026-11-23: the desktop app and every other native shell no longer connect,
show or manage local devices, and the host a client runs on is not assumed to be a device. Local
devices are the `device-local` plugin's, connected only with the `capybara-device` program
(`login`, `service install -c <device id>`, …), which the device's connection guide describes.
Why: one way to connect a machine, the same on every platform and for servers without a desktop,
and no second control surface (tray rows, keep-awake, pause / resume) to keep in step with the
program. So there is no shell capability for devices (the `device@2` this section first defined is
gone from the SDK, the web and the clients, with no replacement), no `::shell-action` guide
directive, no "this machine" mark or block on the web, and `GET /api/v1/meta` has no
`features.localDevices`; `protocols.device` stays.

## 10. Plugins and packages

- capybara-hq/plugins: `sandbox-docker` → `device-docker`, `sandbox-e2b` → `device-e2b` (new npm
  names `@capybara-hq/plugin-device-*`; the old ones deprecated), each with a short
  `device-connection` guide. New `device-local` (`@capybara-hq/plugin-device-local`): the local
  semantics of §5 and its guide. It is a preinstalled bootstrap entry in
  `packages/kernel/bootstrap.json` that is **on in every org by default and switchable** (scope
  `all`; the super admin may make it `optional` / `named`, an org admin may switch it off), not a
  fixed `builtin` item, whose scope cannot change (designer's call). Today's bootstrap entries are
  either fixed builtins or optional preinstalls off everywhere, so `bootstrap.json` gains a
  `scope` field for preinstalls (default `optional`, as today).
- `@capybara-hq/plugin-sdk`: `device-provider@1`, `DialInChannel`, the device report, the
  `device-connection` guide place. The protocol 4 frame
  types move to a subpath (`@capybara-hq/plugin-sdk/device-protocol`) shared by `device-local` and
  `capybara-device` (builder's call on the exact home).
- `@capybara-hq/device`: §7; the protocol version bumps (the hello carries no ceiling the kernel
  reads; scope without read roots).
- Skill `writing-sandbox-providers` becomes `writing-device-providers` (core and plugins).

## 11. Order of work

1. SDK `device-provider@1` + kernel `DeviceProviders` by device, providers per org, default
   provider; docker / e2b renamed and ported. (Cross-tenant and migration review alone.)
2. Dial-in channel split + `device-local` plugin + bootstrap entry; local semantics leave the
   kernel. (Trust boundary: reviewed alone.)
3. Network setting in the kernel for every device (local included), device page, 新建设备 with
   guides.
4. Local read model (Claude Code alignment, per-connection project reach).
5. Many connections in `capybara-device`. (The `device@2` shell capability and tray rows this step
   also shipped were removed on 2026-11-23, §9.)

Steps 4 and 5 touch only `capybara-device`, `device-local` and the clients, and may run in
parallel once 2 is merged.

## 12. Specs amended

- Desktop client spec §8 and §9: superseded by §9 here (2026-11-23: the desktop manages no
  devices).
- Approval-only profiles design: the local owner ceiling's `network open|allowlist` moves to the
  kernel's device setting (§6.3; the machine keeps a narrowing), and `restrictedProjectReach` is
  replaced by §7.1.
- Project root design: project reach and hidden projects (§6.1).

## 13. Testing

- Kernel: multi-provider resolution with two fake providers on in one org; a provider switched
  off makes its devices unavailable, not demoted; the dial-in channel with a fake dial-in
  provider (replacing `sandbox-fake`'s local paths) in the dual-replica `container` project.
- `capybara-device`: two connections under a temporary `XDG_CONFIG_HOME` (never the real one:
  this Mac's prod connection must not be touched); deny-list tests that a sandboxed read of the
  other connection's working directory and state fails; the flat-layout move.
- Web: the create dialog with two providers; the device page without per-provider sections.

## 14. Decisions and open questions

Decided by the maintainer (2026-11-21): three scenarios all supported (dev + prod, many orgs of a
platform, unrelated groups); limits per connection; a `paths` project reach; one extension point
with plugins `device-docker` / `device-e2b` / `device-local`; approach B; the device page reduced
to overview / network / projects; no `/sandbox` switch; network aligned with Claude Code; the
project directory is the write boundary and the load root; the open network mode stays.

Designer's calls to check:

1. Extension point name `device-provider@1` (avoids the shell's `device@…`).
2. One runner and service per connection (§7.2).
3. The local device's network list moves to the kernel and is widened on the web by the device's
   owner; the machine keeps only a narrowing (§6.3).
4. `devices.defaultProvider` for the person's default device (§6.2).
5. Default project reach of a new connection: `machine` (Claude Code alignment); `paths` for
   connections that must not see each other's code is set by the owner on the machine.
6. (withdrawn: no compatibility, §6.2)
7. `device-local` is on in every org by default but switchable, not a fixed builtin;
   `bootstrap.json` gains a `scope` for preinstalls (§10).
8. Providers are trusted, machines are not; reports carry a revision that drives the
   provider-neutral authority epoch (§6.7).
9. "This run" host grants only on providers with per-operation hosts; allowlist enforcement is
   required of every provider (§6.3).

Withdrawn: removing the `open` network mode (the maintainer kept it, 2026-11-21).

## AGENTS.md rules touched

- **Sandboxes**: "commands run in the device's sandbox under every permission profile (scope:
  project, workspace, tool directories; network: the open public internet or an allowlist …)"
  becomes: the device provider decides how operations are confined and reports it; writes stay in
  the project and workspace; the network (open public internet, or an allowlist with asks) is one
  kernel setting per device under the org and platform ceilings; private ranges, metadata and host
  services stay closed. Command review, per-call
  escalation bounded by the device's report, abort, locking, suspension and destruction remain the
  kernel's. The skill link becomes `writing-device-providers`.
- **Extensions**: `device-provider@1` is a `multi` point; the dial-in channel is a kernel service
  offered on `ctx` to providers that declare `dialIn`; long connections are still held only by the
  gateway role.
- **Plugins and the catalog**: `device-local` is a `builtin: true` bootstrap entry; providers are on
  per org through the existing scope.
- **Repository map / dependency direction**: `packages/device` still imports only `plugin-sdk`
  (now its `device-protocol` subpath).
- **Platform tool**: the removed route `DELETE /orgs/:orgId/devices/:id/machine` loses its operation;
  device creation takes a provider; the device network route accepts local devices (no more
  `device.ceiling_on_machine`).
- **Public API reports**: SDK changes (`device-provider@1`, `DialInChannel`, `DeviceCapabilityV2`,
  guide place) need `pnpm gen:sdk-api` and a changeset bumping `@capybara-hq/plugin-sdk`.
- **Multi-replica**: unchanged rules; the relay and lease keep living in Redis.
- **Language / i18n**: removed and new device copy in zh and en (设备 / 本机 / 平台).
