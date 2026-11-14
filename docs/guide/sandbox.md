# Devices and sandboxes

Agents run commands and produce files in a **device**: a sandbox with its own files that a person's conversations share. Each member gets a default personal device ("Personal" / 个人设备) in each org, created the first time they need one once a sandbox extension is enabled, and can create more under "设备" / "Devices" in the left navigation (at most `devices.maxPersonal` per org, default 10, the default one included). Devices are personal: only their owner sees and uses them.

- **A conversation works in one device.** It is bound when it is created: the device picked in the composer (before the model), else the person's default; it stays bound, and its sub-agents use the same device. Changing device means a new conversation. Conversations of one device see each other's files.
- **Who may use a device is decided by the conversation's owner**, never by the agent: an org agent used by two people works in each person's own device. Access is checked again on every sandbox tool call; once the device is deleted, or its owner left the org, the conversation's sandbox tools fail (`device.not_found`) instead of switching to another device.
- **Instances are disposable, files are not.** A device's instance is suspended after `sandbox.limits.suspendAfterIdleMinutes` (10) with no command from any of its conversations (files are kept; processes end, so a long-running server does not survive), resumed by the next command, and destroyed after `sandbox.limits.destroyAfterInactiveDays` (7) of disuse; its files stay until the device is deleted, and the next use starts a new instance on them. Deleting a device destroys the instance and the files (in a background job).
- **Lost files** (the provider lost them): the device page offers "Rebuild files" (重建文件), which empties them (`POST /api/v1/orgs/:orgId/devices/:id/files/reset`, done by a background job); the next use starts with an empty workspace.
- **IM conversations** (Slack, Lark) use the person's IM default device: `/device` in a direct message to the bot lists the devices, `/device <name>` picks the one for the next new conversation (after `/new`). Without a choice it is their default device. Anonymous IM guests have no device, so sandbox tools are unavailable to them.
- **Paths in a shared file system**: attachments are placed in the workspace's `attachments/<conversation>/` (the first 12 hex digits of the root conversation's id), and skill files in `skills/<name>@<digest>/`, so conversations and skill versions don't overwrite each other. A local device reports its three roots in its hello; every kernel tool builds paths from them.

The API is `/api/v1/orgs/:orgId/devices` (list, create, rename, delete, reset files; `agents.use`, human users only) and `POST /api/v1/orgs/:orgId/conversations` takes a `deviceId`. A deployment has one sandbox extension (`sandbox@2`): Docker, E2B, or the kernel's own provider for local devices. Each device records its provider; after the super admin switches provider, the old provider's devices show as unavailable until it is back (their files are not migrated).

A local device connects to `<http.publicUrl>/device/connect`, which a replica with the `gateway` role serves (the web app forwards the WebSocket upgrade there when roles are split, `CAPYBARA_WEB_GATEWAY_URL`). See [Connected devices](../deploy/README.md#connected-devices) for the route, the proxy and the certificate.

## Modes

Every device runs commands in one of two modes. A mode says what it **guarantees**; the kind of
device says what that means in practice. Commands are reviewed in both modes (below).

- **Auto** (the default of a new local device, when the deployment and the org allow it): commands
  run with the environment's own capability and no additional restriction. On a local device that
  is the owner's machine: the real `HOME`, `PATH`, environment, caches, keychain and credentials
  (SSH keys, `gh`, cloud CLIs), and the machine's network. The kernel's file tools (`Read`,
  `Write`, `Edit`) reach any absolute path on the machine; a write outside the workspace passes
  review. On a cloud device the container is the boundary: commands run as the container user with
  the image's tools, and the network is the open public network (below).
- **Sandbox**: writes are limited to the workspace and temporary files, reads are limited to the
  workspace, and the network is limited to an allowlist. On a local device this is the
  `@anthropic-ai/sandbox-runtime` profile (macOS Seatbelt, Linux bubblewrap): `HOME` is the
  workspace, the secret paths stay unreadable, there is no local binding or unix sockets, and the
  proxy refuses loopback, private and internal addresses. On a cloud device the container already
  gives the write and read limits, so the mode's only additional guarantee over auto is the
  network: the allowlist instead of the open public network.

Who chooses what:

- **Super admin**: `devices.autoMode` is `allowed` (the default) or `off`; it can be set in the
  startup config (environment, file or Nacos, which wins) or in the admin console.
- **Org admin**: the org setting `autoMode` follows the platform, may turn it off, and may turn it
  back on only while the platform allows it. The org setting `cloudNetwork` is the cloud device's
  sandbox-mode network (below).
- **Device owner (local)**: `capybara-device mode auto|sandbox` on the machine. A new login starts
  in auto mode when the org allows it, and `login` prints one line saying so and how to switch.
- **Device owner (cloud)**: the device page switches between auto and sandbox; sandbox only
  narrows the network. From the web a local device can be switched to sandbox too (the kernel sends
  the change to the machine), but never to auto: turning auto mode on is a decision at the machine.
  A device that reports auto mode while the org forbids it is refused with
  `device.auto_mode_not_allowed`.

When auto mode is off for the org, local devices run in sandbox mode, and cloud devices keep the
container and follow the org's `cloudNetwork`. A cloud device's mode is a label over its network:
auto is the open public network, sandbox is the org's cloud network. If the OS sandbox is
unavailable on a local machine, sandbox mode refuses every command with a clear reason
(`sandbox.unavailable`) instead of running unsandboxed; getting the work done there means
switching the machine to auto mode.

## Command review

In both modes, every `Bash` command (foreground and background launches) and every kernel
file-tool write outside the workspace passes a **command review** before it reaches the device. It
is a kernel step, not an extension hook, so it runs for every device, and it fails closed: a
review error, timeout or unreadable answer is a question, never an allow.

- **Stage 1, the rules**: a pure function over the parsed command (shell words, pipes,
  redirections, `&&` / `;` chains, `bash -c` / `sh -c` / `eval` unwrapped one level) and the
  run's facts (working directory, workspace root, mode, attended or not). Each rule answers allow,
  ask, deny or unsure; the strictest wins. Deleting outside the workspace, sending a secret away,
  force-pushing a protected branch and similar are deny or ask.
- **Stage 2, the classifier**: a model call (purpose `review`, `sandbox.review.*`) decides what the
  rules cannot. The model sees the command and the last person messages only, bounded by
  `sandbox.review.messageTokens`.
- **Outcomes**: **deny** does not run the command and tells the model why and to do the work another
  way; **ask** shows a card (run once, or allow this kind for the conversation) and resumes the run
  with the person's decision; **allow** runs it. 「本会话允许同类」 remembers the rule that hit for
  the conversation, not the exact command text; a deny rule is never grantable and a
  classifier-decided ask has no rule to remember, so its card offers once only. An unattended run
  (a scheduled task) never waits: an ask is refused with a note the model reads, and the run
  continues. Existing `ctx.hooks` policy hooks run after the review, so an org's policy extension
  can add rules.

The decision is recorded on the tool result (`review`) for the conversation page. It is display
only: request building and replays read the recorded tool result and never review again.

## Cloud networks (org settings)

`cloudNetwork` is the network of a cloud device in **sandbox** mode; it has no effect in auto mode,
which is always the open public network.

- **open** (the default): the container reaches any public host on any port. Refused: the host's
  loopback, private ranges (`10/8`, `172.16/12`, `192.168/16`, `fc00::/7`), link-local and cloud
  metadata (`169.254/16`, `fe80::/10`), and the deployment's own internal addresses. The sandbox
  extension enforces this outside the container (Docker: its egress proxy or network policy; E2B:
  its network filter).
- **allowlist**: only `cloudNetwork.allowHosts` (defaulting to `sandbox.limits.allowHosts`:
  npm, PyPI and GitHub's clone, archive, raw and release download addresses) over HTTP(S). It
  blocks the internal network and every other host; it does not stop data sent to an allowed host
  (`git push` to github.com, publishing to npm).
- **Local devices**: the same host list is the ceiling a local device in sandbox mode reaches (the
  device intersects it with its own list), so narrowing the org's list limits local sandbox devices
  too, not only cloud devices.
- **The platform kill switch**: `sandbox.limits.egress: none` forces every cloud device to an empty
  allowlist and every local device's sandbox mode to no network; auto mode on a local device uses
  the machine's own network, which the kernel cannot cut.
- An org admin changes the org's network in the organization settings; widening it (or adding a
  host) needs a person there, never an API token or the Platform tool
  (`org.sandbox_egress_not_allowed`). A member's network request from a conversation asks the org
  admins to add hosts; approving it merges them into the org's `cloudNetwork` as an allowlist.
- A provider that cannot give the open public network refuses with
  `sandbox.open_network_refused`: an org admin can switch the org to an allowlist, or a super admin
  can allow the open network in the sandbox extension's settings. Changes to the network and to
  resource limits reach only instances created (or recreated) afterward.

Once you add the builtin tools `Bash` / `Read` / `Write` / `Edit` / `Glob` / `Grep` / `Deliver` to
an agent, it can use the conversation's device (not included by default). **The sandbox isolates
the host and the internal network, not data**: in sandbox mode the allowlist blocks internal and
unknown hosts but not data sent to an allowed one; in auto mode the command review is the boundary
and the environment's network is open. Attachments, the files of the device's other conversations
and any data the agent can read may flow out. For orgs that handle sensitive data, admins should
change `sandboxToolPolicy` to `ask` in org settings (write, execute and deliver need approval) and
/ or tighten the cloud network; a local device in auto mode keeps the machine's own network.
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
- **Network**: in auto mode the container reaches the open public network; in sandbox mode the extension enforces the org's `cloudNetwork` through its egress proxy, refusing private, loopback, link-local and metadata addresses by resolved IP. The extension's own settings decide how the open network is served (through the proxy by default, or directly on the bridge for trusted deployments); a provider set to refuse it answers `sandbox.open_network_refused`. The proxy that refuses internal addresses is the enforcement for sandbox mode too: a host on the allowlist is reached through it.
- **Long commands need a relaxed runtime limit**: a single command may run for at most `sandbox.limits.maxCommandSeconds` (default 7200 seconds), but a command is also stopped shortly before its run reaches `runtime.maxRunSeconds` (default 900 seconds) (the result tells the model it was due to the run time limit). When an agent needs to run long commands, raise `runtime.maxRunSeconds` to at least `maxCommandSeconds`; when this isn't satisfied, the kernel logs a warn at startup.

For config options, the socket proxy and the image, see [the sandbox-docker README](https://github.com/capybara-hq/plugins/blob/main/plugins/sandbox-docker/README.md).

## E2B

The other implementation is `@capybara-hq/plugin-sandbox-e2b` (an alternative to Docker): one E2B sandbox per device (E2B cloud or self-hosted), whose files are kept by pausing it; suspension uses E2B's pause and resuming uses connect, pausing automatically on schedule instead of deleting. The template is built from the same [`image/Dockerfile` of sandbox-docker](https://github.com/capybara-hq/plugins/blob/main/plugins/sandbox-docker/image/Dockerfile):

```bash
pnpm capybara extensions install npm:@capybara-hq/plugin-sandbox-e2b --yes   # then approve and enable it
export CAPYBARA_EXTENSION_CONFIG='{"sandbox-e2b":{"apiKey":"e2b_…","template":"capybara-sandbox"}}'
```

- **Template**: build it from the Dockerfile with E2B's Template SDK (`Template().fromDockerfile(...)`, with `cpuCount: 1` and `memoryMB: 2048` matching the kernel defaults), and put the template name into `template`; rebuild the template after changing the Dockerfile. E2B's CPU, memory and disk are determined by the template, so these three `sandbox.limits` settings have no effect on it, and the kernel config `sandbox.image` isn't used either.
- **Network is weaker than Docker**: E2B's domain allowlist only looks at the Host header on port 80 and the SNI on port 443, and doesn't check the destination IP. In sandbox mode it maps the org's `cloudNetwork` to its `allowOut` / `denyOut` (so a sandbox may still reach arbitrary addresses through an allowlisted domain); when an allowlist is used, E2B also lets DNS to 8.8.8.8 through. In auto mode the sandbox gets the open public network through E2B's network filter, which refuses private and metadata addresses. Use Docker for deployments with strict network requirements.
- **Self-hosted E2B**: block internal-network and cloud-metadata addresses yourself at E2B's network layer; for versions that don't support domain allowlists, set `domainAllowlist: false` (an allowlist degrades to no network).
- On the Hobby plan, the sandbox timeout is at most 1 hour, so set `sandbox.limits.maxCommandSeconds` below 3480.
- The sandbox CPU / memory overrides a super admin sets for an org in the admin console have no effect on E2B (the spec is determined by the template) and apply only to the Docker implementation.

For template build steps, self-hosting (`apiUrl` / `domain`), and the limits of network and resource settings, see [the sandbox-e2b README](https://github.com/capybara-hq/plugins/blob/main/plugins/sandbox-e2b/README.md).
