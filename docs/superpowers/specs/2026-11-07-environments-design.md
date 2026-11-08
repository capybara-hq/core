# Environments: where agents do their work

- Date: 2026-11-07, written against `main` at `76b32e10`.
- Status: draft for review.
- Amends: the architecture design §8.3 (sandbox), the `sandbox@1` contract
  (`packages/plugin-sdk/src/sandbox.ts`), AGENTS.md "Sandboxes", the `writing-sandbox-providers`
  skills (core and `capybara-hq/plugins`), the sandbox-docker and sandbox-e2b plugins, the
  conversation page's composer (`docs/design/spec.md` §6.16.2). Where they disagree, this document
  wins once accepted.
- Markers: **(decided)** is the maintainer's answer in the 2026-11-07 discussion; **(designer's
  call)** is decided here and may be overturned in review. Items without a marker restate current
  code.
- Written in English (AGENTS.md "Language"); UI copy is quoted in Chinese where it was agreed.

## 1. Why

Agents need a place to read and write files and run commands: every builtin sandbox tool (`Bash`,
`Read`, `Write`, `Edit`, `Glob`, `Grep`, `Deliver`) depends on one. Today that place is a sandbox
**per conversation**: created on the first sandbox tool call, shared with the conversation's
sub-agents, suspended after 10 idle minutes and destroyed with its files after 7 inactive days.

The maintainer's acceptance (2026-11-07) found this unworkable for real work:

- Two conversations working on two branches of the same git repository each clone it, install its
  dependencies and fill their caches again, and cannot see each other's work.
- Different agents cannot collaborate in one place; the place belongs to a conversation.
- Files disappear with the instance after a week, so nothing long-lived can be built there.
- A person who already has a capable machine (a laptop, a team server) cannot use it; only the
  deployment's Docker host or E2B can run sandboxes.
- The sandbox images are not published, so "just give it Docker" does not work: a deployment has to
  build them from the plugins repository first.

## 2. Terms

- **Environment** (环境): a named place where agents work, made of **one instance** and **one
  file system**. It is a first-class object with an owner, members and a lifecycle of its own; it
  belongs to neither a conversation nor an agent.
- **Instance**: what runs the commands: a container, a micro-VM or a connected machine. It can be
  stopped, destroyed and recreated without losing the files.
- **File system**: the environment's files (`/workspace`, the read-only `/skills`, `/tmp` as today).
  It lives as long as the environment.
- **Cloud environment** (云端沙箱): an environment whose instance the platform creates on demand
  through a sandbox extension (Docker, E2B; K8s later).
- **Connected environment** (接入设备): an environment whose instance is a machine a person
  connects with the connector program: a laptop, a home server, a team's server.
- **Connector program**: the small command-line program a person installs on a machine to connect
  it (§6). It is not an extension.
- **Owner kind**: **personal** (个人: one person) or **project** (项目: an owner and the members they
  choose). Amended 2026-11-08 (§14): the kernel's second kind is **shared** (an environment with a
  member list); projects are a plugin that uses shared environments.
- **Session**: one conversation's use of an environment. Several sessions may use one environment
  at the same time.

## 3. Goals, non-goals, anti-goals

Goals:

1. A person picks the environment when starting a conversation; several conversations, and several
   agents, can work in the same environment and see the same files **(decided)**.
2. Two sources with the same behaviour for agents: cloud sandboxes and connected devices
   **(decided)**.
3. Two owner kinds: personal and project; a project environment is shared with members chosen by
   its owner **(decided)**.
4. Instances can be destroyed; the file system is kept **(decided)**.
5. "Just give it Docker": a deployment with a Docker endpoint (or E2B credentials) needs nothing
   else; the images are pulled, not built.
6. A security model that holds for both sources (§8), with the environment as the trust boundary.

Non-goals (this document):

- Git workflow inside an environment: worktrees, branch layouts and similar are the git project's
  business and are not enforced or managed by the platform **(decided)**.
- A desktop app or tray UI for the connector program (a command line only in this design).
- Pools of several machines behind one environment, K8s warm pools, memory snapshots.
- Browsing or editing an environment's files from the web UI (the conversation's existing file
  previews stay).

Anti-goals (a failure even if it works):

- A person's credentials ending up readable by another person's agent.
- A connected machine reachable from the internet (any inbound port), or a cloud policy able to
  loosen what the machine's owner allowed locally.
- Losing files silently: an environment's files go only when the environment is deleted.
- A second, lighter kernel or an agent loop on the device: reasoning stays in the cloud kernel
  (desktop direction, 2026-10-19).

## 4. The model

### 4.1 Decided

1. **One instance per environment, shared by its sessions** **(decided)**. A conversation is bound
   to one environment when its first message is sent and stays bound; its sub-agents use the same
   environment (as they share the root's sandbox today). Changing environment means a new
   conversation.
2. **The picker sits before the model picker** in the composer's control row, on the new
   conversation page **(decided)**: 环境 · 模型 · 档位. After the first send the environment is
   shown, read only.
3. **Who may use an environment is decided by the person who starts the conversation**, never by
   the agent: their own personal environments and the project environments they are a member of.
   An org agent used by two people works in each person's environment.
4. **Any machine may join a project environment** **(decided)**: the platform cannot tell a
   dedicated server from someone's laptop and does not try. It guarantees the security of the two
   ways (cloud and connected) and states the trade-offs (§8.5) where people decide.
5. **No isolation mode is mandatory for a connected environment** **(decided)**: Docker or the OS
   sandbox, the environment shows which (§7.3).
6. **Instances are disposable, files are not** **(decided)**: suspension and destruction act on the
   instance; the files stay until the environment is deleted.

### 4.2 Designer's calls

7. **A default personal environment.** Each person gets one personal cloud environment named
   「个人环境」 / "Personal", created on first need when a cloud sandbox extension is enabled. It is
   the picker's default until the person has used another one; then the last used environment is
   the default.
8. **IM channel conversations** use the person's IM default environment (the IM message carries
   no picker): the environment chosen with `/env <name>` in a direct message, else their default
   personal environment. `/env <name>` applies to the next new thread (after `/new`); `/env` alone
   lists the environments the person may use. Anonymous IM senders (no linked account) get no
   environment, and their sandbox tools are unavailable.
9. **No compatibility with per-conversation sandboxes** **(decided)**: nothing has been released
   (AGENTS.md "Before 0.1.0"), so phase 1 replaces them outright. Kernel code stops using the
   `sandboxes` table; a one-off cleanup job destroys every instance and file system it lists
   (`destroyByName` and `destroyFileSystemByName` on `cap-<conversationId>`) and deletes the row.
   The table itself is dropped by a later migration, after the cleanup has run everywhere (the
   expand-then-contract rule of the writing-migrations skill). Existing conversations get the
   owner's default environment on their next sandbox tool call.
10. **Instance lifetime follows all sessions.** An environment's instance is suspended after
    `sandbox.limits.suspendAfterIdleMinutes` (10) with no command from any session, and resumed on
    the next one. `maxRunningMinutes` stays as the backstop. `destroyAfterInactiveDays` now destroys
    only the **instance** of a cloud environment (its files stay); a deleted environment destroys
    both.
11. **Suspension ends the instance's processes** (as today); an environment says so in its detail
    page, so nobody expects a long-running server to survive 10 idle minutes. Keeping processes is
    the optional "memory retained" capability of §8.3 of the architecture design.
12. **"The person who starts the conversation"** (§4.1 item 3) is the conversation's owner account
    (`conversations.account_id`). A background wake continues the same conversation, so it uses
    the same environment. In an IM group thread every sender already has a conversation of their
    own (`channel_threads` is unique per account), so each works in their own environment. The
    kernel has no scheduled triggers yet; when they arrive, a triggered conversation is owned by the
    trigger's creator. Access is
    checked when the conversation is bound and again every time the kernel acquires the instance
    for a tool call (a cheap lookup next to the lease); losing access (removed from a project,
    left the org, environment deleted) fails sandbox tools with `environment.forbidden` /
    `environment.not_found` **(designer's call)**.
13. **One cloud provider per deployment.** The `sandbox` extension point stays single-select, as
    today (`SandboxProviders.current()`, `packages/kernel/src/sandbox/providers.ts`): a deployment
    runs Docker or E2B, never both, so the 新建环境 dialog has no provider field. Connected
    environments are not an extension: the kernel's own device transport (§6.3) implements the same
    operations. Each environment records its provider; when the super admin switches provider, the
    environments of the old one show 「不可用」 until it is back (their files are not migrated);
    deleting such an environment still works while the old plugin is loaded (`lookup(plugin)`)
    **(designer's call)**.

## 5. Cloud environments

### 5.1 The contract

The `sandbox@1` contract assumes one instance owns its files (`create` makes both, `destroy` drops
both). Environments need the files to outlive the instance, so the contract becomes
**`sandbox@2`** **(designer's call)**. It **replaces** `@1` with no overlap **(decided: no
compatibility before 0.1.0)**: the core PR changes the SDK and the kernel, the plugins repository
moves sandbox-docker and sandbox-e2b in lockstep, and a kernel refuses a provider still on `@1`.

- `createFileSystem({ name, limits, signal }) -> FileSystemHandle` and
  `destroyFileSystem(fs, signal)`: the environment's files on their own. `name` is
  `cap-env-<environmentId>`. `destroyFileSystemByName(name, signal)` removes the file system made
  under that name when the kernel has no handle (a crash mid-create, the cleanup of §4.2 item 9).
- `create({ name, image?, limits, fileSystem, signal }) -> SandboxHandle`: an instance attached to
  that file system; `destroy(h)` and `destroyByName(name)` drop the instance only. Without
  `image` the provider uses its own published image (§5.4). When the file system is gone, `create`
  throws `FileSystemGoneError` (new in the SDK, duck-typed like `SandboxGoneError`) instead of
  silently making an empty one: a Docker provider checks the volumes exist before mounting them,
  because Docker would otherwise create empty ones.
- `resume` / `suspend` / `exec` / `readFile` / `writeFile` / `stat` / `killAll` / `killTagged` as
  in `@1`.
- **`concurrentExec` and `killTagged` are required** in `@2` **(designer's call)**: several
  sessions share one instance, so one-call-at-a-time would serialize every conversation of the
  environment. Taking over from a crashed holder kills only that holder's tags (`killTagged`);
  `killAll` is used only when nobody can hold the instance (just resumed from `suspended`, or under
  the exclusive lease), never while another session may be running commands. The single-holder
  code path of `SandboxService` and `leases.ts` goes away.
- **`exec` carries its actor** **(designer's call)**: `actor: { accountId, conversationId }`.
  Phase 1 only records it (audit, attribution); phase 3 uses it for per-actor credentials (§8.2),
  so the contract does not change again.
- Declared capabilities: `sessionIsolation: boolean` (§7.2). Every `@2` provider keeps files for
  the life of the environment (§5.3 for E2B), so there is no retention declaration.

The kernel's `SandboxService` keeps owning locks, leases, suspension and destruction; the lock key
becomes the environment id instead of the conversation id. The sub-agent sharing rules
(`sandbox.maxConcurrentCommands`, shared and exclusive leases, `killTagged`) apply to all sessions
of the environment. A per-session fair share of the concurrent commands comes with the phase 3
quotas: a personal environment's sessions all belong to one person.

The SDK's extension point table gains the majors the kernel accepts (`sandbox`: `[2]`); the kernel
refuses to load an extension that provides an unsupported major, with an error naming the plugin
and the major to upgrade to. Today a stale provider loads and the sandbox silently becomes
unavailable.

### 5.2 Docker

The file system is a Docker volume (today's workspace and skills volumes, named by environment);
the instance is a container that mounts it. `destroy` removes the container and keeps the volume.
Files live until the environment is deleted.

### 5.3 E2B

E2B has no volume separate from a micro-VM. The provider maps one environment to one E2B sandbox
and keeps the files by **pausing** it with the file system only (`keepMemory: false`), resuming on
the next use. The operations map as follows **(designer's call)**:

| `sandbox@2` | E2B |
|---|---|
| `createFileSystem` | create the sandbox, then pause it; the file system handle is the E2B sandbox id |
| `create` (instance) | resume (`connect`) that sandbox; the instance handle carries the same id |
| `suspend`, `destroy` (instance) | pause |
| `destroyFileSystem` | kill the sandbox |
| inactivity destruction | nothing to do (already paused) |

**Retention.** E2B's current documentation states that paused sandboxes have no time to live and
are never removed by E2B ([persistence](https://e2b.dev/docs/sandbox/persistence),
[lifetime FAQ](https://docs.e2b.dev/faq/sandbox-lifetime)); an older beta page said 30 days. The
implementation re-checks this against the live API (a paused sandbox resumed after more than 30
days, recorded in the plugin's live tests). **No export to object storage in phase 1**
**(decided)**; packing `/workspace` into object storage stays the later enhancement of the
architecture design §8.3 ("recovery not tied to a node"). A paused sandbox that is nevertheless
gone surfaces as `SandboxGoneError` from `resume`, and the environment shows its files as lost
(`environment.files_lost`), never a silent empty workspace (§3 anti-goals).

**Template.** The provider creates from a template. When the plugin's `template` setting is empty
it builds one on first use from its own published image
(`ghcr.io/capybara-hq/capybara-sandbox:<plugin version>`; the two sandbox plugins share one version
through a changesets fixed group) with E2B's template build API (the calls
`Template().fromImage(...)` makes in the `e2b` SDK, amd64), aliased after that tag, and reuses it
until the tag changes **(designer's call)**, so E2B credentials alone are enough (§3 goal 5).
`create`'s `image` cannot reach E2B, because the template is fixed at `createFileSystem`; a custom
image needs a custom `template`. The alias must be non-public and owned by the team: the plugin
refuses a public or foreign alias. The provider keeps its hand-written REST client (its README
explains why it does not use the `e2b` package).

**Limits on E2B** are fixed when the E2B sandbox is created, that is at `createFileSystem`. If E2B
cannot change a paused sandbox's network rules, a later change of the org's egress setting reaches
an existing E2B environment only when it is recreated; the provider README and the environment
page say so.

### 5.4 Images are published

The sandbox image and the egress proxy image are built and pushed by the plugins repository's
release workflow to `ghcr.io/capybara-hq/capybara-sandbox` and
`ghcr.io/capybara-hq/capybara-sandbox-egress`, multi-arch (amd64 and arm64), tagged with the
sandbox-docker plugin's version **(designer's call)**, by a workflow file of its own (the release
workflow's job list is pinned by a check). The kernel setting `sandbox.image` loses its default:
unset, the kernel passes no `image` and each provider uses the image published with its own
version, so the kernel never has to know a plugin's version. The plugin's `egressProxyImage`
defaults to the egress tag of its own version. The provider already pulls a missing image
(`/images/create`, allowed by the socket proxy). The compose files keep their two build services
only as the offline route (a deployment without registry access), behind a profile of its own.

## 6. Connected environments

### 6.1 The connector program

A separate, small npm package (not the server CLI, which depends on the whole kernel):
`@capybara-hq/device`, binary `capybara-device` **(decided)**. Commands:

| Command | Does |
|---|---|
| `capybara-device login --url <deployment>` | Authorizes this machine for the signed-in person (§6.2); creates or joins their personal connected environment |
| `capybara-device register --url <deployment> --code <code>` | Joins the environment a code was issued for (a project's, or one created on the web) |
| `capybara-device start` | Connects and serves until stopped (foreground) |
| `capybara-device service install` / `uninstall` | Runs `start` as a service: launchd (macOS), systemd (Linux) |
| `capybara-device status` | Connection, environment, mode, policy, running commands |
| `capybara-device drain` | Accepts no new command, waits for running ones, then stops (maintenance) |
| `capybara-device stop`, `logout` | Disconnects; `logout` also forgets the machine's credential |
| `capybara-device policy` | Shows and edits the local policy file (§6.4) |

### 6.2 Authorization

- **With a browser at hand** (a laptop): `login` opens the deployment's authorization page, the
  person confirms, the machine receives a **device credential** scoped to "run commands for this
  environment", revocable from the environment's page.
- **Without one** (a server): `login` prints a URL and a short code to confirm on another device
  (the device authorization grant), or the person uses a one-time registration code issued on the
  web (`register --code`). A project environment's admin issues codes from its page; registering a
  machine never makes its operator a member.
- The authorization page states what will happen: who may run commands on this machine (the person,
  or the project's members and their agents), what the machine sends to the cloud (command output
  and file contents the agents read become part of conversations and are sent to models), and how
  to disconnect.

### 6.3 Transport

- The program dials out over WebSocket (TLS) to the deployment; there is never an inbound port.
  The connection is held by the `gateway` role, spread across gateway replicas the way channel long
  connections are (lease per environment, renewed; reconnect on loss).
- The kernel sends the `sandbox@2` operations over it (exec, read, write, stat, kill by tag, kill
  all); the device answers. A connected environment is therefore one more sandbox provider to
  `SandboxService`; agents' tools and policies do not change.
- **Relay across replicas** **(designer's call)**: the caller (an API or worker replica) and the
  gateway replica holding the socket are usually different processes, and a reconnect may land on
  another gateway replica. Requests and results go through Redis (a request stream per
  environment read by whichever gateway replica holds its lease; results stored under the request
  id with a TTL of `env.reconnectGraceSeconds` plus the command timeout), so a result produced
  during a disconnect is delivered after the reconnect. `exec` returns its result whole, like
  `ExecResult` today; streaming output is not part of this design.
- The protocol is versioned; an incompatible program is refused with a message to upgrade it.
- **Disconnects**: a running command keeps running on the device; when the program reconnects
  within `env.reconnectGraceSeconds` (default 120) its result is delivered; otherwise the tool call
  fails with `environment.offline` and the command is killed when the program comes back
  **(designer's call)**.
- **Offline**: the picker marks the environment offline and refuses a send to it; a conversation
  bound to it fails its sandbox tools with `environment.offline` (no automatic switch).

### 6.4 Execution on the device

- **OS sandbox mode** (default when Docker is absent): every command runs inside
  `@anthropic-ai/sandbox-runtime` (Apache-2.0, the sandbox behind Claude Code), pinned to an exact
  version: macOS Seatbelt, Linux bubblewrap. Writes are confined to the environment's directory
  (chosen at login, default `~/capybara-device/<environment>`), reads of known secret paths (`~/.ssh`,
  cloud CLI credentials, browser profiles) are denied, network goes through the runtime's proxy
  with the environment's allowlist.
- **Docker mode** (chosen at login when Docker is present, or later): the instance is a container
  on the device, the environment's directory mounted as `/workspace`, the published image pulled.
- **Windows**: Docker mode or WSL (the OS sandbox inside WSL) in the first version; native Windows
  sandboxing later.
- **The local policy file** (owned by the machine's user): the environment directory, allowed
  domains, which local credentials (if any) commands may use (none by default), CPU and memory
  ceilings. The cloud can only tighten it. An operation outside it is **refused, never prompted**
  in the first version (nobody may be at the machine) **(designer's call)**.
- **No local confirmation UI** in the first version; a desktop helper is a non-goal (§3).

## 7. Sessions inside an environment

### 7.1 Shared by default

All sessions share the instance and the file system. Two conversations can iterate on one
repository in one directory or in two; the platform does not decide (§3).

### 7.2 Session isolation (an enhancement)

Where the instance allows it, each session's commands run inside a light per-session sandbox in the
same instance (a PID namespace through bubblewrap / sandbox-runtime): files stay shared, but a
session sees and can kill only its own processes and cannot read another session's process
environment. A provider declares `sessionIsolation`; the connector program reports it for its mode:

| Instance | Session isolation |
|---|---|
| E2B (micro-VM, own kernel) | Supported |
| Connected Linux machine | Supported |
| Docker container | Not supported **(decided)**: it would need user namespaces inside the container and a looser seccomp profile, which weakens the container boundary for every session; people who need isolation pick E2B or a connected Linux machine |
| Connected macOS (Seatbelt) | Files and network only; processes are not isolated |

### 7.3 Shown, not hidden

The environment's detail page and the picker show its source, its mode and whether sessions are
isolated (「会话之间隔离进程」 / 「会话之间不隔离进程」), so people choose knowingly.

### 7.4 Per-session paths in a shared file system

Two kernel features assume one conversation owns the file system today. In an environment
**(designer's call)**:

- **Attachments** go to `/workspace/attachments/<conversation>/<name>` (`<conversation>` is the
  first 12 hex digits of the root conversation's UUID, hyphens removed), instead of
  `/workspace/attachments/<name>`
  (`ATTACHMENTS_DIR`, `packages/kernel/src/tools/builtins/sandbox/common.ts`); the copy marker is
  kept per conversation as today.
- **Skill files** go to `/skills/<name>@<digest12>/` (the first 12 hex digits of the sha256 of the
  version's manifest file list, sorted by path, as `path size sha256` lines), with markers at
  `/skills/.capybara/<name>@<digest12>.json` (`packages/kernel/src/tools/builtins/skill-load.ts`),
  so two agents using different versions of one skill (an org-owned skill, a SkillWrite draft) do
  not overwrite each other. `/skills` stays read-only to commands.

Both paths are model-visible (tool results and the Skill tool description). They change only for
new tool calls; recorded events keep the old paths, and tool definitions are replayed from the
snapshot by their recorded spec hash, so no `DriftReason` is needed (replay-evals skill). The plan
runs the zero-drift fixture tests before and after.

## 8. Security

### 8.1 The environment is the trust boundary

Everyone who can use an environment, people and their agents, is equally trusted **with its
files**: an agent of member A can write something that member B's agent later runs. This cannot be
removed while files are shared, so it is stated where people decide: creating a project
environment, adding a member, connecting a machine to a project. **Everything else is separated by
person**: credentials, processes (where §7.2 applies), network rules, attribution.

### 8.2 Threats and measures

| Threat | Measure |
|---|---|
| Reading another person's credentials | Credentials never enter the file system or an environment variable of the instance. A command carries its actor (person, agent, conversation); git credentials come from a kernel-backed credential helper and HTTP credentials are substituted at the egress proxy for that actor's request only; the instance sees placeholders |
| Interfering with another session's processes | Session isolation where supported (§7.2); elsewhere shown as not isolated (§7.3) |
| Persistence and poisoning (startup files, git hooks, shared caches) | Project environments protect a configurable path list from agent writes (default: shell startup files and `.git/hooks`); caches hold package manager content stores only; the admin may relax the list **(designer's call)** |
| Not knowing who did what | Every command is recorded with its actor and output, viewable per environment (`environment.command` audit rows); the connector program keeps a local log too |
| Removed members | Removal ends their running commands in the environment and refuses their sessions from then on |
| One session starving the others | Environment quotas (CPU, memory, disk) plus a per-session fair share of concurrent commands |
| Exfiltration | Egress allowlist per environment; project environments start from the deployment default and only the environment admin widens it |
| A compromised cloud or a misled agent acting on a device | The local policy (§6.4) bounds every command and cannot be loosened remotely; the machine's user can `stop` at any time |
| A root user on a connected machine | Sees everything on it, including credentials in transit through its egress proxy: stated on the authorization page; projects must trust the machine's operator |

### 8.3 Project defaults are stricter

A project environment starts with the protected paths of §8.2, the deployment's egress allowlist
and an option for its admin to require confirmation for `Bash` in it (off by default)
**(designer's call)**. Personal environments keep today's defaults.

### 8.4 Limits and egress: the org sets the ceiling

Today the effective limits and egress come from deployment config plus the org settings
`sandboxLimitOverrides` and `sandboxEgress` (`effectiveSandboxEgress`), with the plugin's
`allowOpenEgress` gating open egress. Environments keep that as the **ceiling**
**(designer's call)**:

- An environment's `limits` and `policy` may only tighten the org's effective settings, never
  widen them. A personal environment's owner may tighten them; a project environment's admin may
  widen its egress back up to the org's ceiling (§8.2 "Exfiltration") but not beyond it.
- Phase 1 environments use the org's effective settings unchanged; editing them per environment
  arrives with the environment page's policy section.
- A changed policy that the provider bakes in at `create` (Docker puts egress in container labels
  and the proxy environment) recreates the instance on its next use; the files stay (§4.1 item 6).

### 8.5 Joining a project with a personal machine

Allowed (§4.1 item 4). The machine's owner is told that the project's members' agents will run
commands on it within the local policy; members see in the picker that the environment is a
person's connected machine and its isolation level.

## 9. UI

- **Environments page** (环境, workspace navigation after 连接器) **(designer's call)**: cards
  (`ListPage variant="cards"`) with name, source (云端沙箱 / 接入设备), owner kind, state (运行中 /
  已暂停 / 在线 / 离线), members, isolation; actions 新建环境, and per card 设置, 成员 (projects),
  删除.
- **新建环境**: a dialog. Cloud: name, owner kind, members (project) → ready at once. Connected: a
  short guide: install command, then `login` or the shown `register --code`, waiting for the machine
  to appear online.
- **Environment page**: summary (source, mode, isolation, limits), members (projects),
  machines (connected: name, OS, program version, last seen, revoke), policy (egress, protected
  paths, confirmation option), activity (commands with actor), delete (files included, typed
  confirmation).
- **Composer**: the environment picker before the model picker on the new conversation page (§4.1
  item 2), offline environments marked and not selectable for sending; on a conversation the
  environment is shown read only in the properties panel.

## 10. Kernel sketch (for the plan)

- Tables: `environments` (id, org_id, name, owner_kind, owner_account_id, source, provider,
  file_system handle, instance handle, status, limits, policy, created/updated), `environment_members`
  (environment_id, account_id, role admin|member), `environment_machines` (connected: id,
  environment_id, credential hash, name, os, program_version, mode, session_isolation, last_seen,
  revoked_at), `conversations.environment_id`. The instance state the `sandboxes` table holds
  today (status, generation, handles) moves to an `environment_instances` table keyed by
  environment, which also holds the file system handle; `environment_defaults` records the IM
  default of §4.2 item 8; `sandboxes` is dropped later (§4.2 item 9). `environment_members` and
  `environment_machines` arrive with the phases that use them.
- Routes under `orgs/:orgId/environments` (list, create, get, patch, delete, members, machines,
  registration codes, activity) and the device authorization endpoints; `@OrgAction` gates per
  role.
- Errors: `environment.not_found`, `environment.offline`, `environment.forbidden`,
  `environment.unavailable` (its provider is not loaded, §4.2 item 13), `environment.files_lost`
  (§5.3), `environment.program_outdated`.
- Queues: the existing sandbox maintenance sweep keyed by environment; the one-off cleanup of
  per-conversation sandboxes (§4.2 item 9).

## 11. Phases

1. **Environments and personal cloud environments**: the environment object, `sandbox@2` with
   Docker and E2B (replacing `@1`), the default personal environment, the picker, persistent
   files, per-session paths (§7.4), published images and the E2B template built from them, the
   cleanup of per-conversation sandboxes.
2. **Connected personal environments**: the connector program, device authorization, the gateway
   transport, OS sandbox and Docker modes, the local policy.
3. **Project environments**: members and roles, registration codes, connected project machines,
   per-actor credential injection, audit, quotas, protected paths, session isolation where
   supported. Split on 2026-11-08 (§14) into kernel shared environments plus a project plugin.

Each phase is its own implementation plan; phase 1 needs a core PR for the contract before the
plugins move (AGENTS.md "a contract change needs a PR in core first").

## 12. Resolved questions

Answered by the maintainer on 2026-11-07:

1. The connector program is `@capybara-hq/device` / `capybara-device` (§6.1).
2. E2B: no object storage export in phase 1; current E2B documentation keeps paused sandboxes
   indefinitely, re-checked at implementation (§5.3).
3. Docker containers do not get session isolation; the container profile is not loosened (§7.2).
4. No compatibility with per-conversation sandboxes or `sandbox@1` (§4.2 item 9, §5.1).

Left for the phase 3 design: where per-actor credentials come from (connector OAuth credentials, a
per-person secret store, or another source) and which hosts and headers the egress proxy
substitutes (§8.2). `sandbox@2` already carries the actor (§5.1), so this needs no contract change.

## 13. Phase 2 design (2026-11-08)

Detail for §6, decided when planning phase 2. All items are designer's calls unless marked.

### 13.1 Model-visible paths are the instance's real paths (decided)

The OS sandbox cannot present `/workspace` (macOS needs root to create it, and
`@anthropic-ai/sandbox-runtime` restricts access but does not remap paths). The maintainer chose to
tell the model the real paths (2026-11-08):

- `SandboxHandle` gains optional `roots: { workspace, skills, tmp }` (absolute paths in the
  instance). Absent means `SANDBOX_ROOTS`, so cloud providers do not change.
- The kernel's sandbox tools, attachment copies, skill files and background tasks build paths from
  the held instance's roots, never from constants. Tool descriptions say "the workspace directory"
  instead of naming `/workspace`.
- Every conversation's first sandbox tool call records an `environment_paths` event (the three
  roots) in the event log, rendered to the model as a system line, and so does the first call after
  the roots change (including a change back to the defaults). It is in the log, so it needs no
  `DriftReason`; tool descriptions are replayed from their recorded spec hash (replay-evals skill).
  Migration 0094 adds a partial index on `conversation_events` (`type = 'environment_paths'`) so the
  latest event is read without scanning the log.
- Tool descriptions never name `/workspace` (or any other root). Path checks that do not depend on
  the roots (non-empty, absolute, no traversal) run before the call enters the instance, through
  `validateSandboxPathShape`; checks against the roots run with the held instance's roots.

### 13.2 Machines and credentials

- One machine per connected environment in phase 2 (pools are a non-goal, §3). A new `login` for
  the same environment replaces the machine: the old credential is revoked.
- Table `environment_machines` (§10) holds the machine: credential hash, name, OS, arch, program
  version, mode (`os` | `docker`), roots, `session_isolation` (false in phase 2: process isolation
  on Linux comes with phase 3, §7.2), last seen, revoked.
- The device credential is `cap_dev_` plus 32 random bytes (base64url); only its sha256 is stored.
  It is accepted only by the device connection route, never by `/api`.
- The kernel provider name of connected environments is `@device` (a name no plugin can take),
  stored in `environments.provider` and `environment_instances.provider`. `environments.source`
  gains `device`.
- The `@device` `SandboxHandle` is created with the org's effective limits and carries them; a
  handle without limits answers `SandboxGoneError`, so the kernel rebuilds the instance. Each exec
  uses the org's current effective limits (looked up per exec), not the ones the handle carries.
- A replacement login rebuilds the instance (R23): issuing the new credential resets the
  environment's `environment_instances` row in the same transaction (no handle, files ready), so
  the next use creates a fresh instance; and `resume` answers gone (the kernel rebuilds) when the
  active machine's `hello` roots differ from the handle's. A new `environment_paths` event follows
  (§13.1).

### 13.3 Authorization

The shape of RFC 8628 for both cases (browser or not):

- `POST /api/v1/device/authorize` (public) with the machine's name, OS, arch, program version →
  `deviceCode` (`cap_dvc_…`, secret), `userCode` (8 characters from `BCDFGHJKLMNPQRSTVWXZ`, shown as
  `XXXX-XXXX`), `verificationUri` (`<web>/device`), `verificationUriComplete`, `interval` 5,
  `expiresIn` 600. Held in Redis with that TTL.
- The web page `/device` (signed in) shows the code and the machine, asks the person to pick the org
  and either an existing connected environment of theirs or a new one (default name: the machine's
  name), shows the disclosure of §6.2, and confirms. Confirming creates the environment if needed,
  the machine row and the credential, and parks the credential for the poll (once, `GETDEL`).
- `POST /api/v1/device/token` (public) with `deviceCode` answers `device.authorization_pending`,
  `device.slow_down` (polling faster than the interval; the interval grows by 5 s),
  `device.expired`, `device.denied`, or the credential with the org id, environment id and the
  connection URL.
- `register --code` belongs to phase 3 (project machines).

### 13.4 Transport

- Route `GET /device/connect` (WebSocket, served by the `gateway` role on the kernel HTTP port,
  outside `/api`), `Authorization: Bearer cap_dev_…`, header `X-Capybara-Device-Protocol: 1`. A
  revoked or unknown credential gets 401; an unsupported protocol gets 426 with
  `environment.program_outdated` before the upgrade.
- One lease per environment (`capk:device-lease:<environmentId>`, LockService `hold`, the channel
  supervisor's TTL and renewal). **The newest connection wins**: a second connection publishes a
  takeover on the bus; the holder closes its socket and releases; the new one claims within 5 s.
  Takeover compares no clocks: a holder yields to any takeover, and a claimer retries for 5 s, then
  closes with 4409.
- The route is a real WebSocket upgrade only: an upgrade to any other path gets 404, and a plain
  HTTP request to `/device/connect` is not an upgrade. Revocation is by machine: on
  `device.revoked.<environmentId>` the gateway closes the socket only if the payload's `machineId`
  is that socket's machine (a replacement login publishes it without a stop frame). `connectUrl` is
  built on `http.publicUrl`, so the deployment's proxy must route `/device/connect` on that origin
  to the `gateway` role (docs/deploy/README.md).
- The web server forwards `/device/connect` (R28): `apps/web/server.mjs` pipes WebSocket upgrades
  on exactly that path to a gateway replica (`CAPYBARA_WEB_GATEWAY_URL`; compose sets
  `http://gateway:8080` on a `devices` network holding web and gateway), with the original request
  line and headers; other upgrade paths are refused, and unset it answers 404 with a log line. An
  external proxy may route the path to the gateway replicas directly instead.
- Frame limit (R26): the token response also carries `maxFrameBytes`
  (`environments.device.maxFrameBytes`), stored in `credential.json`; the program answers an
  `error` result instead of sending a larger frame, and the `@device` provider clamps `readFile`'s
  `maxBytes` so the base64 bytes and the envelope fit (Deliver then reports the file as too large).
- Prompt failure on revoke or delete (R27): a waiting relay call that sees the lease gone checks
  whether the machine and environment are still active, and fails at once with
  `environment.forbidden` (machine revoked) or `environment.not_found` (environment deleted)
  instead of waiting out the grace.
- Frames are JSON. Device → kernel: `hello` (protocol, program version, OS, arch, mode, roots,
  session isolation), `res` (`id`, `ok`, `result` or `error: { kind: "gone" | "fs_gone" | "policy" |
  "error", message }`). Kernel → device: `req` (`id`, `op`, `args`, `deadlineMs`), `cancel` (`id`).
  Bytes travel base64. WebSocket ping every 20 s.
- **Relay**: the caller pushes the request onto `capk:device-req:<environmentId>` (a Redis list
  with a TTL) and publishes `device.req.<environmentId>`; the holder drains the list on the nudge
  and on every connect. The holder stores the result under `capk:device-res:<requestId>` (TTL
  `environments.device.reconnectGraceSeconds` + the command timeout) and publishes
  `device.res.<requestId>`; the caller subscribes before it sends and reads the key once after
  subscribing (the run-abort pattern). The caller waits within its own tool call.
- The gateway accepts a `res` only for a request id it took for that environment (it records
  `capk:device-taken:<id>` when it forwards the request), so a connected machine cannot write results
  for requests of other environments.
- No holder at send time → `environment.offline` at once. A holder lost mid-command → the caller
  waits until the command's deadline plus the grace; the program keeps results of commands that
  finished while disconnected for the grace and sends them after reconnecting. When the caller gives
  up (grace exceeded or aborted), a request still in the queue is removed from it; only a request the
  machine already took gets a `cancel`, delivered on the next connect. The program treats a cancel
  for an unknown or not-yet-started request as "never start it".
- `stop` (the program's stop on environment deletion) is fire-and-forget: it is pushed and nudged
  only while a holder is live, and never awaited.

### 13.5 Instance lifecycle on a machine

- `createFileSystem` returns the environment id and touches nothing; the program creates the
  environment directory on first use. A directory that existed and is gone answers `fs_gone`
  (`environment.files_lost`).
- `create` and `resume` need the machine online; `suspend` and `destroy` do nothing (the machine is
  not the platform's to stop); idle suspension and inactivity destruction never act on `@device`.
  `destroy` and `destroyFileSystem` (and the by-name variants) are offline-safe no-ops: a stop is
  relayed only when the machine is online. The one sweep that does include `@device` rows is the
  gone-sweep (org or environment deleted); machine authentication also requires the org not deleted.
- Deleting a connected environment revokes the machine and tells the program to stop; the files on
  the machine stay where they are (they are the machine owner's). The delete dialog says so.
- Files lost (R24): `fs_gone` from any operation on a held instance marks its files lost and
  answers `environment.files_lost`, as on create. Recovery is local: the machine owner runs
  `capybara-device logout`, then `capybara-device login` into the same environment, which recreates
  the directory and its marker (and rebuilds the instance, §13.2); the environment page says so.
  Resetting files (the API and the Platform operation) is refused for connected environments with
  an actionable error, the web hides 重建文件 for them, and `destroyFileSystem` /
  `destroyFileSystemByName` are no-ops (the stop on deletion comes from revoking the machine).

### 13.6 The program

- Package `packages/device` (`@capybara-hq/device`, binary `capybara-device`), Node ≥ 22.12 (the
  floor of `@anthropic-ai/sandbox-runtime`), depends only on `@capybara-hq/plugin-sdk` (the
  protocol types live there, `device-protocol.ts`), `ws` and `@anthropic-ai/sandbox-runtime`
  pinned to an exact version. A dependency check keeps it off the kernel.
- State in `~/.config/capybara-device/` (`XDG_CONFIG_HOME` honoured): `credential.json` (0600),
  `policy.json`, a local command log.
- OS mode: each command runs through sandbox-runtime with writes allowed only under the
  environment directory, reads denied for `~/.ssh`, `~/.aws`, `~/.config/gcloud`, `~/.azure`,
  `~/.kube`, `~/.docker/config.json`, `~/.netrc`, `~/.gnupg` and the browser profile directories,
  and network allowed for the intersection of the policy's domains and the environment's egress.
  The denied list (`DENIED_SECRET_PATHS` in `packages/device/src/policy.ts`) also covers
  `~/.config/gh`, `~/.git-credentials`, `~/.npmrc`, `~/.pypirc`, `~/Library/Keychains`,
  `~/Library/Cookies`, `~/Library/Safari` and the Chrome, Firefox, Brave, Edge and Arc profile
  directories (macOS and Linux locations).
  File operations (Read, Write, Edit, Glob, Grep helpers) also run inside the sandbox, in a helper
  process, never as host-side path operations; the request's environment is applied inside the
  sandbox only, not to the program.
  Limits: `cpu`, `memoryMb` and `allowCredentials` are not enforced in OS mode (commands get no
  local credentials). Processes a command leaves behind are found by an environment marker; on
  macOS a child that leaves the process group and runs only Apple system binaries (which drop the
  marker) cannot be found again. Linux runs each command in its own pid namespace.
- Docker mode: the published image, the environment directory mounted at `/workspace`, default
  roots. The container has a read-only root file system, `--pids-limit 1024`, `--memory-swap`
  equal to `--memory`, `--cap-drop ALL`, `no-new-privileges` and runs as uid 1000. Docker mode has
  no domain allowlist: a command has the full default bridge or no network at all.
- Native Windows is refused with a message pointing at WSL or Docker.
- Terminal exits (R25): the program exits 0 after a clear message on conditions a restart cannot
  fix (401, 426, close 4002 replaced, close 4003 revoked, a `stop` operation, not logged in), so
  launchd (`SuccessfulExit=false`) and systemd (`Restart=on-failure`) do not restart it; transient
  failures stay non-zero. While connection attempts keep failing (a non-101 answer, close 4400) it
  prints the HTTP status or close reason, at most once a minute.

## 14. Projects as a plugin (2026-11-08, decided)

- The kernel does not know projects. Its second owner kind is **shared**: an environment with a
  member list, and the kernel decides access only from that list (the check stays next to the
  lease, §4.2 item 12; a plugin is never asked at tool-call time).
- The SDK gains `ctx.environments` for extensions: create a shared environment, change its member
  list, read its state. An environment created by an extension belongs to that extension.
- A **project plugin** (in `capybara-hq/plugins`) owns projects: members and roles, invitations,
  registration codes, quotas, protected-path settings and its pages; it syncs project members into
  its environments' member lists.
- Phase 3 is therefore two designs: kernel shared environments with `ctx.environments`, and the
  project plugin. Phase 1's `owner_kind` CHECK lists only `personal`, so nothing is renamed.

