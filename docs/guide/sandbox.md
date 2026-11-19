# Devices and sandboxes

Agents run commands and produce files in a **device**: a sandbox with its own files that a person's conversations share. Each member gets a default personal device ("Personal" / 个人设备) in each org, created the first time they need one once a sandbox extension is enabled, and can create more under "设备" / "Devices" in the left navigation (at most `devices.maxPersonal` per org, default 10, the default one included). Devices are personal: only their owner sees and uses them.

- **A conversation works in one device.** It is bound when it is created: the device picked in the composer (before the model), else the person's default; it stays bound, and its sub-agents use the same device. Changing device means a new conversation. Conversations of one device see each other's files. A conversation may also bind one of the device's [projects](#projects).
- **Who may use a device is decided by the conversation's owner**, never by the agent: an org agent used by two people works in each person's own device. Access is checked again on every sandbox tool call; once the device is deleted, or its owner left the org, the conversation's sandbox tools fail (`device.not_found`) instead of switching to another device.
- **Instances are disposable, files are not.** A device's instance is suspended after `sandbox.limits.suspendAfterIdleMinutes` (10) with no command from any of its conversations (files are kept; processes end, so a long-running server does not survive), resumed by the next command, and destroyed after `sandbox.limits.destroyAfterInactiveDays` (7) of disuse; its files stay until the device is deleted, and the next use starts a new instance on them. Deleting a device destroys the instance and the files (in a background job).
- **Lost files** (the provider lost them): the device page offers "Rebuild files" (重建文件), which empties them (`POST /api/v1/orgs/:orgId/devices/:id/files/reset`, done by a background job); the next use starts with an empty workspace.
- **IM conversations** (Slack, Lark) use the person's IM default device: `/device` in a direct message to the bot lists the devices, `/device <name>` picks the one for the next new conversation (after `/new`). Without a choice it is their default device. Anonymous IM guests have no device, so sandbox tools are unavailable to them.
- **Paths in a shared file system**: attachments are placed in the workspace's `attachments/<conversation>/` (the first 12 hex digits of the root conversation's id), and skill files in `skills/<name>@<digest>/`, so conversations and skill versions don't overwrite each other. A local device reports its three roots in its hello; every kernel tool builds paths from them.

The API is `/api/v1/orgs/:orgId/devices` (list, create, rename, delete, reset files; `agents.use`, human users only) and `POST /api/v1/orgs/:orgId/conversations` takes a `deviceId`. A deployment has one sandbox extension (`sandbox@2`): Docker, E2B, or the kernel's own provider for local devices. Each device records its provider; after the super admin switches provider, the old provider's devices show as unavailable until it is back (their files are not migrated).

A local device connects to `<http.publicUrl>/device/connect`, which a replica with the `gateway` role serves (the web app forwards the WebSocket upgrade there when roles are split, `CAPYBARA_WEB_GATEWAY_URL`). See [Connected devices](../deploy/README.md#connected-devices) for the route, the proxy and the certificate.

## The sandbox and permission profiles

Every command runs in the **device's sandbox**, under every permission profile. The sandbox is a
setting of the device, not of the conversation:

- **Scope**: the project root (or the workspace), scratch and the detected tool directories. Writes
  stay inside the scope; protected paths (`~/.ssh`, `~/.aws`, cloud CLI configs, `.netrc`, `.npmrc`,
  browser profiles, Keychains, the device's own state, shell startup files, `.git/hooks`, launch
  agents, systemd user units, autostart and the crontab spool) stay closed even inside it.
- **Network**: the **open** public internet (the default) or an **allowlist**. Private and LAN
  ranges, CGNAT, link-local and cloud metadata addresses, loopback (another program's localhost
  port), the host's own addresses and the Docker and kernel sockets are always closed in the
  sandbox. Connections go through the operation's proxy, which judges the resolved address, so
  HTTP(S)- and SOCKS-aware tools work on any port; a tool that ignores proxy variables (plain
  `ssh`) does not connect (`GIT_SSH_COMMAND` with a SOCKS `ProxyCommand` does). Behind a router
  that answers every name with a fake `198.18.0.0/15` address (fake-IP mode), the proxy looks the
  name up over DNS-over-HTTPS (Cloudflare, then Google, at IP addresses) and refuses the connection
  when that fails.
- **Environment**: a minimal one (`PATH`, `LANG`, `HOME` set to the working root, a private temp
  directory, the tool homes, the proxy variables). Commands never see the device program's
  environment or its tokens.
- **Running outside the sandbox**: one `Bash` call may ask to run outside it (`sandbox:
  "escalated"` with a justification). It runs as the device's owner with the owner's files and
  network, and is the only way to reach private addresses, local services, the sockets and the
  protected paths. Whether any call may do this is the device's **outside-sandbox** setting.

A **permission profile** (picked per conversation in the composer) only chooses who approves a
**crossing** of that sandbox:

| Request | Request approval | Approve for me (default) | Full access |
|---|---|---|---|
| Work inside the scope and the network | Runs | Runs | Runs |
| A directory outside the scope | Asks you | Review model | Approved automatically, recorded |
| A new host while the network is an allowlist | Asks you | Review model | Approved automatically within the network ceiling, recorded |
| Running one call outside the sandbox | Asks you | Review model | Approved automatically within the outside-sandbox setting, recorded; the review model when the command touches credentials, or when a sub-agent asks |
| A sensitive command (`sudo`, credential reads, force pushes, …) | Asks you | Review model | Runs, recorded |
| A fixed deny (deny rules, platform and org denies, protected paths) | Denied | Denied | Denied |

Full access never removes the sandbox. Every automatic approval writes a grant, a
`permission_reviewed` event in the conversation and an audit entry
(`permission.crossing_auto_granted`). An unsure or unavailable review model asks you. Choosing
Full access takes a short confirmation bound to the device and its ceilings: switching device or
widening a ceiling returns the conversation to Approve for me until you confirm again (a narrowing
keeps it). Scheduled tasks run as Request approval with every ask refused, and never escalate.

**Cloud devices**: the container or microVM is the sandbox. Its whole file system is the scope and
its network, which the sandbox extension enforces, is the sandbox network. There are no directory
crossings and nothing runs outside it; the profiles differ only in sensitive-command consent. A new
host cannot be granted per call there: add it to the device's or the org's list.

Who sets the sandbox (each layer can only narrow the one above):

- **Super admin**: `devices.outsideSandbox` (`CAPYBARA_DEVICES__OUTSIDE_SANDBOX`, `allowed` by
  default, or `off`), `devices.network.default` and `devices.network.ceiling` (`open` by default,
  or `allowlist`), the host list `sandbox.limits.allowHosts` and the kill switch
  `sandbox.limits.egress: none`. They can be set in the startup config (environment, file or Nacos,
  which wins) or in the admin console. The old keys `devices.autoMode` and `devices.fullAccess` are
  refused at startup with a conversion message (see [Upgrading](../deploy/upgrade.md)).
- **Org admin**: the org settings `outsideSandbox` (follow the platform, or off) and
  `deviceNetwork` (`default`, `ceiling`, and the host list as a delta over the platform's:
  `base`, `extraHosts`, `excludedHosts`). Only a person widens them in the web, never an API token
  or the Platform tool. An org that needs egress control sets `deviceNetwork.ceiling: allowlist`.
- **Device owner (local)**: the owner ceiling on the machine, `capybara-device ceiling set
  [--outside-sandbox on|off] [--network open|allowlist] [--project-reach workspace|os-user]`, and
  the owner's allowlist (`capybara-device policy add allowedDomains <host>`). With the allowlist
  network the owner's list is the machine's ceiling: a per-call host grant counts only where it
  covers the host. A new install starts with outside-sandbox off and the open network. The device
  page can narrow a local device (allowlist, remove hosts, outside-sandbox off) but never widen it.
- **Device (cloud)**: follows its org's network; its own choice (`network_mode`, `network_hosts`)
  only narrows, never adds a host.

A crossing beyond a ceiling is unavailable under every profile, with an error naming who can
change it (the device owner on the machine, an org admin, or the super admin). If the device
cannot enforce its sandbox (no OS sandbox on a local machine), every profile refuses every command
with a clear reason instead of running unsandboxed.

## Command review

Under every profile, every `Bash` command (foreground and background launches) and every kernel
file-tool write outside the workspace passes a **command review** before it reaches the device. It
is a kernel step, not an extension hook, so it runs for every device, and it fails closed: a
review error, timeout or unreadable answer is a question, never an allow.

- **Stage 1, the rules**: a pure function over the parsed command (shell words, pipes,
  redirections, `&&` / `;` chains, `bash -c` / `sh -c` / `eval` unwrapped one level) and the
  run's facts (working directory, workspace root, attended or not). Each rule answers allow,
  ask, deny or unsure; the strictest wins. Deleting outside the workspace, sending a secret away,
  force-pushing a protected branch and similar are deny or ask.
- **Stage 2, the classifier**: a model call (purpose `review`, `sandbox.review.*`) decides what the
  rules cannot. The model sees the command and the last person messages only, bounded by
  `sandbox.review.messageTokens`.
- **Outcomes**: **deny** does not run the command and tells the model why and to do the work another
  way; **ask** shows a card (run once, or allow this kind for the conversation) and resumes the run
  with the person's decision; **allow** runs it. 「本会话允许同类」 remembers the rule that hit for
  the conversation, not the exact command text, and allows a later line only when everything it
  asks about was granted; a deny rule is never grantable, credential prints, links to secrets,
  dynamic paths and `sudo` are asked every time, and a classifier-decided ask has no rule to
  remember, so its card offers once only. Inline interpreter code (`python -c`), fetched packages
  (`npx some-tool`) and scripts the agent itself wrote are reviewed as code the rules cannot read. An unattended run
  (a scheduled task) never waits: an ask is refused with a note the model reads, and the run
  continues. Existing `ctx.hooks` policy hooks run after the review, so an org's policy extension
  can add rules.

The decision is recorded on the tool result (`review`) for the conversation page. It is display
only: request building and replays read the recorded tool result and never review again.

## Projects

A **project** is a name and a directory on a device: a repository checkout, or any directory the
agent should work in. A conversation may bind one project; the agent then reads the project's
`AGENTS.md` and its `.agents/skills/` at the start of every run and works inside the project's
directory. A conversation without a project is in **free mode** (自由模式), exactly as before.

- **Where they are kept**: the kernel keeps a device's projects (table `device_projects`, at most
  100 per device), the same for a local machine and a cloud device. Only the device's owner sees and
  changes them.
- **Adding one**: on the device page's 设置 view, the 项目 section (the 概览 view lists them
  read-only). The form takes the directory **relative to the device's base**, shown as a fixed
  prefix, and an optional name (default: the directory's name; 1-64 characters, not `.` or `..`, no
  `/` or control characters, no leading or trailing spaces, unique on the device). The base follows
  the device's project reach: the owner's home directory for a local device whose owner ceiling
  allows `os-user` reach (reported by `capybara-device` when it connects), else the device's
  workspace, and always the workspace on a cloud device. The device is asked whether
  the directory exists and can be read before it is saved, so a typo fails at the form. The
  directory need not hold `.git` or `AGENTS.md` yet. A directory that holds the owner's home (`/`,
  `/home`, `/Users` in any case, an ancestor of the home) is refused as too broad; the home itself is
  allowed. Removing a project only drops it from the list: its files stay, and conversations bound to
  it continue in free mode.
- **Suggestions**: the add dialog lists candidates from one scan on the device: the base and the
  directories up to two levels below it that hold `.git` or `AGENTS.md` (hidden directories,
  `node_modules` and symbolic links skipped; at most 50, at most 500 directories read).
- **What the reach allows**: a device offers what it can read within its project reach. With
  `workspace` reach, and on a cloud device, that is only the workspace; with `os-user` reach on a
  local device, any directory the owner can read outside the protected paths. A project the
  current reach cannot read is hidden (the section says how many), not deleted, and comes back when
  the reach does. The device enforces its ceiling on every access anyway, so a saved path grants
  nothing by itself.
- **Requirements**: a local device needs a `capybara-device` that supports projects (it announces
  it when it connects; the section asks you to update an older one). A cloud device needs a sandbox
  extension that implements the project calls; with one that does not, its conversations stay in
  free mode.

**Binding.** The project is picked in the composer when the conversation is created (see
[the conversation page](conversation-ui.md)) and never changes: switching projects means a new
conversation. Only the device's owner binds a project of it. Sub-agents and scheduled runs of the
conversation use its project.

**What the agent reads.** At the start of every run, before the first model call, the kernel reads
the project's `AGENTS.md` (up to 64 KiB, cut with a marker beyond) and the name and description of
each skill under `.agents/skills/` (at most 100), and records them in the conversation log; skill
bodies are read only when used. A run records a new snapshot only when something changed, so an
edited `AGENTS.md` reaches the next run. The project's instructions come after the agent's own,
which win on a direct conflict; its skills are listed as `project:<name>` (see [Skills](skills.md)).
A bound conversation starts its device at run start, since the files must be read before the model
answers. A project that was removed, is outside the device's current reach, whose directory is gone
or cannot be read, or whose device does not support projects never fails a run: the conversation
continues in free mode and its header says why.

**The working directory.** In a bound conversation the project's root is the working directory:
`Bash` runs there (a background command too), `Glob` and `Grep` search there by default, and a
relative `Read` / `Write` / `Edit` path resolves against it. In free mode, or when the project
cannot be used, the working directory is the device's workspace. A root above the owner's home, or
one outside the workspace under `workspace` reach, is never used as the working directory.

**How the review treats a project.** For the command review the project root takes the place of the
workspace: a write inside the project is an ordinary write, a write outside it asks as a write outside
the workspace would. Home-level sensitive paths are judged by where they really are, against the
owner's home (the home the machine reported, else the one the device's workspace lies under; never
the project root) and in any letter case: shell rc files, `~/.ssh`, `~/.gitconfig`, launch agents,
`crontab`, systemd units, `PATH` shim directories such as `~/.local/bin`, the device's own directory
and the secret paths ask (or deny) even when the project is the home directory itself. A path the
review judged is resolved against the working root it was reviewed with, and the approval card shows
it that way.

The API is `/api/v1/orgs/:orgId/devices/:id/projects` (list, add `{ path, name? }`, remove by name,
`/candidates`; owner only, with the Platform operations `devices.list-projects`,
`devices.add-project`, `devices.remove-project`, `devices.project-candidates`), and
`POST /api/v1/orgs/:orgId/conversations` takes `project` (a project name of the conversation's
device).

## Sandbox networks (org settings)

`deviceNetwork` is the org's sandbox network for local and cloud devices alike.

- **open** (the default): any public host on any port. Closed: private ranges (`10/8`, `172.16/12`,
  `192.168/16`, CGNAT `100.64/10`, `fc00::/7`), link-local and cloud metadata (`169.254/16`,
  `fe80::/10`, `fd00:ec2::254`, Azure's `168.63.129.16`), loopback and the host's own addresses,
  multicast, broadcast and NAT64. A cloud device's sandbox extension enforces this outside the
  container (Docker: its egress proxy; E2B: its network filter); a local device's proxy does.
- **allowlist**: only the org's hosts (the platform's `sandbox.limits.allowHosts`, by default npm,
  PyPI and GitHub's clone, archive, raw and release download addresses, minus the org's
  `excludedHosts` plus its `extraHosts`), plus per-call host grants. The closed ranges stay closed
  for an allowed name too. It does not stop data sent to an allowed host (`git push` to github.com,
  publishing to npm).
- **Ceiling and default**: `deviceNetwork.ceiling: allowlist` keeps every device of the org on the
  allowlist, and makes the org's list the hard limit for per-call host grants under every profile
  (an org admin adds a host beyond it). `deviceNetwork.default` is the mode a device follows when it
  chooses nothing narrower. Neither may be above the platform's `devices.network.ceiling`
  (`org.network_not_allowed`). Under `sandbox.limits.orgHosts: within`, grants and extras stay
  within the platform's list.
- **Device lists only narrow**: a local owner's allowlist and a cloud device's own hosts are
  intersected with the org's hosts; they never add one.
- **The platform kill switch**: `sandbox.limits.egress: none` closes every sandbox network. A call
  running outside the sandbox uses the machine's own network, which the kernel cannot cut (the
  outside-sandbox setting bounds it).
- An org admin changes the org's network in the organization settings; widening it (opening the
  network or adding a host) needs a person there, never an API token or the Platform tool
  (`org.network_not_allowed`, `org.sandbox_egress_not_allowed`). Narrowing to the allowlist stops
  running work that used the open network. A member's network request from a conversation asks the
  org admins to add hosts.
- A provider that cannot give the open public network refuses with
  `sandbox.open_network_refused`: an org admin can switch the org to an allowlist, or a super admin
  can allow the open network in the sandbox extension's settings. Changes to hosts and to resource
  limits reach only instances created (or recreated) afterward.

Once you add the builtin tools `Bash` / `Read` / `Write` / `Edit` / `Glob` / `Grep` / `Deliver` to
an agent, it can use the conversation's device (not included by default). **The sandbox isolates
the host and the internal network, not data**: the open network and the allowlist close internal
addresses but not data sent to a reachable host, so what a command can send is what the sandbox can
read (the project, the workspace, the readable tool directories; never the protected paths or the
device's tokens). Attachments, the files of the device's other conversations and any data the agent
can read may flow out. For orgs that handle sensitive data, admins should set
`deviceNetwork.ceiling: allowlist`, turn `outsideSandbox` off, and / or change `sandboxToolPolicy` to
`ask` in org settings (write, execute and deliver need approval).
Delivered files appear in the "Artifacts" tab on the right of the conversation page. For the
lifetime and resource settings see `sandbox.*` and `devices.*` in `docs/config.md`; to write sandbox
extensions, see [.agents/skills/writing-sandbox-providers](../../.agents/skills/writing-sandbox-providers/SKILL.md).

## Docker

The Docker implementation is `@capybara-hq/plugin-sandbox-docker`: one container per device (runc, or gVisor's runsc), its files on volumes, suspended when idle and destroyed after long disuse. The extension reaches Docker only through the socket proxy (`docker/sandbox-proxy`) and doesn't mount `docker.sock` itself. Locally:

```bash
docker compose -f docker/compose.dev.yaml --profile sandbox up -d   # builds the sandbox and egress proxy images from capybara-hq/plugins (git + GitHub), starts the socket proxy (127.0.0.1:2375)
pnpm capybara extensions install npm:@capybara-hq/plugin-sandbox-docker --yes   # then approve and enable it
export CAPYBARA_EXTENSION_CONFIG='{"sandbox-docker":{"endpoint":"tcp://127.0.0.1:2375"}}'
```

Production deployment:

- **Images**: the sandbox image and the egress proxy image are published with each sandbox-docker version (`ghcr.io/capybara-hq/capybara-sandbox` and `ghcr.io/capybara-hq/capybara-sandbox-egress`, amd64 and arm64, tagged with the plugin's version). The kernel setting `sandbox.image` has no default: unset, each extension uses the image published with its own version, and pulls it when it is missing. **Pre-pull the images on every Docker node** (a pull on first use may run past that tool call's time limit). For a deployment without registry access, build them from `capybara-hq/plugins` (`plugins/sandbox-docker/image` and `plugins/sandbox-docker/egress-proxy`, at the commit `marketplace.commit` of `packages/kernel/bootstrap.json` names), push them to your own registry, and set `sandbox.image` and the extension's `egressProxyImage`. To use gVisor, first register `runsc` in the daemon and add `"runtime":"runsc"` to the extension config.
- **Where the socket proxy lives**: anyone who can reach the proxy can almost fully control Docker. `127.0.0.1:2375` is for local development only; in production, **never publish it on any host address (including 127.0.0.1)**; put it only on an internal network the kernel is on (set `endpoint` to `tcp://sandbox-proxy:2375`), and don't attach sandboxes to that network.
- **Network**: the container is the sandbox (`boundary: "instance"`), and its network is the device's sandbox network: the open public network or the allowlist, enforced by the extension's egress proxy, which refuses private, loopback, link-local and metadata addresses by resolved IP. The extension's own settings decide how the open network is served (through the proxy by default, or directly on the bridge for trusted deployments); a provider set to refuse it answers `sandbox.open_network_refused`. The extension must report permission support version 2 and be upgraded together with the kernel (see [Upgrading](../deploy/upgrade.md)).
- **Long commands need a relaxed runtime limit**: a single command may run for at most `sandbox.limits.maxCommandSeconds` (default 7200 seconds), but a command is also stopped shortly before its run reaches `runtime.maxRunSeconds` (default 900 seconds) (the result tells the model it was due to the run time limit). When an agent needs to run long commands, raise `runtime.maxRunSeconds` to at least `maxCommandSeconds`; when this isn't satisfied, the kernel logs a warn at startup.

For config options, the socket proxy and the image, see [the sandbox-docker README](https://github.com/capybara-hq/plugins/blob/main/plugins/sandbox-docker/README.md).

## E2B

The other implementation is `@capybara-hq/plugin-sandbox-e2b` (an alternative to Docker): one E2B sandbox per device (E2B cloud or self-hosted), whose files are kept by pausing it; suspension uses E2B's pause and resuming uses connect, pausing automatically on schedule instead of deleting. The template is built from the same [`image/Dockerfile` of sandbox-docker](https://github.com/capybara-hq/plugins/blob/main/plugins/sandbox-docker/image/Dockerfile):

```bash
pnpm capybara extensions install npm:@capybara-hq/plugin-sandbox-e2b --yes   # then approve and enable it
export CAPYBARA_EXTENSION_CONFIG='{"sandbox-e2b":{"apiKey":"e2b_…","template":"capybara-sandbox"}}'
```

- **Template**: build it from the Dockerfile with E2B's Template SDK (`Template().fromDockerfile(...)`, with `cpuCount: 1` and `memoryMB: 2048` matching the kernel defaults), and put the template name into `template`; rebuild the template after changing the Dockerfile. E2B's CPU, memory and disk are determined by the template, so these three `sandbox.limits` settings have no effect on it, and the kernel config `sandbox.image` isn't used either.
- **Network is weaker than Docker**: E2B's domain allowlist only looks at the Host header on port 80 and the SNI on port 443, and doesn't check the destination IP. With the allowlist network it maps the hosts to its `allowOut` / `denyOut` (so a sandbox may still reach arbitrary addresses through an allowlisted domain), and also lets DNS to 8.8.8.8 through. With the open network the sandbox gets the public internet through E2B's network filter, which refuses private and metadata addresses. Use Docker for deployments with strict network requirements.
- **Self-hosted E2B**: block internal-network and cloud-metadata addresses yourself at E2B's network layer; for versions that don't support domain allowlists, set `domainAllowlist: false` (an allowlist degrades to no network).
- On the Hobby plan, the sandbox timeout is at most 1 hour, so set `sandbox.limits.maxCommandSeconds` below 3480.
- The sandbox CPU / memory overrides a super admin sets for an org in the admin console have no effect on E2B (the spec is determined by the template) and apply only to the Docker implementation.

For template build steps, self-hosting (`apiUrl` / `domain`), and the limits of network and resource settings, see [the sandbox-e2b README](https://github.com/capybara-hq/plugins/blob/main/plugins/sandbox-e2b/README.md).
