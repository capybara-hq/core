# @capybara-hq/device

`capybara-device` connects a laptop or server to a [Capybara](https://github.com/capybara-hq/core)
deployment as a device: the platform's agents run commands and read and write files on this
machine, inside a sandbox, while the program is online.

Runs on macOS and Linux. Native Windows is refused: use WSL (then it is a Linux machine) or Docker
mode inside WSL. Node 22.12 or newer.

```bash
npm i -g @capybara-hq/device
capybara-device login --url https://capybara.example.com   # approve in the browser
capybara-device login --url https://capybara.example.com --no-browser   # headless: prints a code
capybara-device start      # connect and serve commands (runs in the foreground)
capybara-device status [--json]
capybara-device logout
```

`login` shows a code like `BCDF-GHJK`; with `--no-browser` it prints the address (`<url>/devices/link`) and
the code to enter on any signed-in browser, where you pick the org and the device (a new one or
an existing connected one of yours) after reading what the program can do. Logging in again from
another machine into the same device replaces the first machine (its credential is revoked).
`stop` ends the running program, `drain` makes it accept no new commands and exit when the running
ones finish. `logout` stops a running program, then forgets the credential (the machine stays
connected on the platform until it is revoked there). Deleting the device in the web app
revokes the machine and stops the program; the files in the working directory stay on your machine.

The deployment must route `/device/connect` on its public URL to the gateway role (see
[Connected devices](https://github.com/capybara-hq/core/blob/main/docs/deploy/README.md#connected-devices)).
While connecting keeps failing, `start` retries and prints why at most once a minute: the HTTP
status (a 404 usually means that route is missing), the close reason, or the network error.

`start` exits 0, after printing why, when retrying cannot help: the machine was revoked or the
device deleted, the program is too old for the deployment (426), another login replaced this
connection, or the machine is not logged in. Other failures exit non-zero, so a service (below)
restarts the program after those and leaves it stopped after the terminal ones; fix the cause
(log in again, upgrade), then run `start` or `service install` again.

If the working directory (or its marker `.capybara-device`, or one of `workspace/`, `skills/`,
`tmp/`) is removed, the program never recreates it: operations answer that the files are lost and
the device page says so. To start afresh, run `capybara-device logout` and then
`capybara-device login` into the same device: login recreates the directory and the marker,
and the platform rebuilds the device on its next use.

Commands: `login --url <url> [--no-browser] [--dir <path>] [--mode os|docker]`, `logout`,
`status [--json]`, `start`, `stop`, `drain`,
`policy [show | set <key> <value> [--yes] | add|remove <key> <value>]` and
`service install|uninstall`.

State lives in `$XDG_CONFIG_HOME/capybara-device` (default `~/.config/capybara-device`):
`credential.json` (mode 0600; the program refuses a file other users can read; it also holds the
deployment's reconnect grace and frame limit: a result larger than the frame limit is answered
with an error instead) and `policy.json` (a file with wrong field types stops `start` with an
error naming it; once running, the program re-reads the file when it changes, and a broken edit
keeps the last valid policy and logs one error). Changes made with `capybara-device policy` take
`policy.json.lock`, so two writers never lose an update; keys this version does not know are kept.
The working directory (default `~/capybara-device/<deviceId>`) holds `workspace/`, `skills/`
and `tmp/`.

In OS mode every command runs inside `@anthropic-ai/sandbox-runtime` (macOS Seatbelt, Linux
bubblewrap; Linux needs `bwrap` and `socat`): writes only under `workspace/` and `tmp/`,
`skills/` read only, `~/.ssh`, cloud CLI credentials, `~/.netrc`, `~/.gnupg`, browser profiles and
this program's state directory unreadable. What else a command may do depends on the device's
[sandbox tier](#sandbox-tiers): at `strict`, network only to the domains of the local policy that
the device's egress also allows (with an empty list, no network at all); at `dev` (the default of
every organization unless changed) also the common package registries and local servers; at
`open` anything the organization allows. You edit the policy locally; the deployment can change it
only as described in [Changes from the deployment](#changes-from-the-deployment):

```bash
capybara-device policy set allowedDomains registry.npmjs.org,*.github.com
capybara-device policy add allowedDomains files.slack.com
capybara-device policy remove allowedDomains files.slack.com
capybara-device policy show
```

Changes apply at the next command; a running program does not need a restart. `add` and `remove`
work on `allowedDomains` and `allowCredentials`; every domain must be a lowercase host name
(optionally `*.` for subdomains, never the apex), never an IP address or an internal name.

When a command is refused a domain, the program says why. Clients that print the proxy's answer
show a reason such as `capybara: files.slack.com is not in this device's allowed domains`, and
after the command its stderr ends with a trailer naming each refused host (at most 20) and who can
lift it:

```text
[capybara-device] Network access was blocked:
- files.slack.com:443: not in this device's allowed domains. Only the device owner can allow it (capybara-device policy add allowedDomains files.slack.com, or the device page).
- api.foo.com:443: not in the organization's network allowlist. Only an organization admin can add it.
- 10.0.0.5:22: a private or local address; commands can never reach it.
```

The trailer is part of the command's output, so the agent reads it too. It comes after the
output the deployment asked for (`maxOutputBytes`), so stderr can exceed that cap by the trailer's
lines (at most 21).

In OS mode each command's result also carries the refused hosts and their layers, so the
deployment can ask the device owner on the spot (the device announces this in its hello, together
with a summary of its local policy: the chosen and effective `tier`, `isolation`, what `localhost`
and `unixSockets` give on this machine, `allowedDomains` and `remoteGrants`).

### Sandbox tiers

`tier` in `policy.json` is `strict`, `dev` or `open`; without it (the default) the device follows
the organization's default tier, which is `dev` unless an admin changed it. The deployment sends
the organization's ceiling with every command, and the device runs the command at its own tier cut
to that ceiling: a device set to `open` in an organization that allows at most `dev` runs at
`dev`.

| | `strict` | `dev` | `open` |
|---|---|---|---|
| Network | `allowedDomains` within the organization's list | also the dev hosts (npm, PyPI, GitHub, crates.io, Go, Maven / Gradle, Docker Hub, Playwright) | anything the organization allows |
| Local servers (macOS) | no | yes, unless a local proxy is detected | same as `dev` |
| Unix sockets (macOS) | no | under `workspace/`, `tmp/` and the socket directory | same as `dev` |
| Package caches | none | `<dir>/cache/` | same as `dev` |

In every tier commands keep `HOME` = `workspace/`, writes stay inside the device directory (plus
the socket directory), the secret paths stay unreadable, and the network proxy refuses loopback,
private addresses and internal names as destinations. Local servers are a separate permission:
at `dev` and `open` on macOS a command may listen on and connect to this machine's localhost
directly (below), never through the proxy.

The tier sets what the device adds to its own list; the organization's ceiling only cuts. So a
device at `strict` under a `dev` ceiling still reaches a dev host (say `registry.npmjs.org`) when
its owner listed it in `allowedDomains`: `strict` means "only what I listed", not "less than the
organization's strict list".

```bash
capybara-device policy set tier dev            # or strict
capybara-device policy set tier open --yes     # anything the organization allows
capybara-device policy set tier default        # follow the organization's default again
capybara-device policy show                    # what the tier gives on this machine
```

`set tier open` prints the risk and changes nothing without a confirmation: `--yes`, or, on a
terminal, an answer of `y` at the prompt (without a terminal and without `--yes` it exits with
status 2): at `open` a command can upload files to any outside site the organization allows, and
prompt injection can make an agent do that. Turn it on only on your own development machine, with
agents and material you trust. Lower tiers are always accepted. When the organization allows any
host too, the program lets a command reach any public host only while a command started that way
is running (the sandbox runtime cannot list "any host" per command, so it is allowed process-wide
meanwhile; a lower tier takes effect at once). The device's owner can also raise the tier on the
device page, behind the same risk text, while `remoteGrants` is `owner`.

An older `policy.json` with `network` is read without it (the device follows the organization's
default) and loses the key at the next change; `start` says so at each start while it held
`network: open`. Any `capybara-device policy set` writes the file again and so clears the notice.

#### Local servers, sockets and caches at `dev` and `open`

- **Local servers (macOS).** Commands may listen on local ports (a dev server, a browser's
  debugging port) and connect to this machine's localhost. That also reaches any local proxy that
  forwards past the network allowlist (Clash and the like) or Docker's TCP API, so the program
  looks for one when it starts and whenever `policy.json` changes: the system proxy
  (`scutil --proxy`), `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` pointing at loopback in its own
  environment, and a listener on 127.0.0.1 or ::1 ports 7890, 7891, 7897, 1080, 1087, 8118, 9050,
  9150, 2375 or 2376. When it finds one, commands get no localhost and `policy show` says why. A
  proxy set up only through a PAC file (automatic proxy configuration) or on another port is not
  found: if you run one, keep `localhost auto` and consider tier `strict`. To allow localhost
  despite a detected proxy: `capybara-device policy set localhost allow` (back with
  `localhost auto`).
- **Local servers (Linux).** The sandbox has its own network namespace: a server listens and
  answers inside the command (and its children), never reachable from the host's browser.
- **Unix sockets (macOS).** Allowed under `workspace/`, `tmp/` and a short socket directory
  `/private/tmp/cap-<8 hex>` (mode 0700, made at start), never anywhere else (Docker's socket stays
  out of reach). `TMPDIR` and `MAC_CHROMIUM_TMPDIR` point at the socket directory, so a headless
  Chromium's socket path stays under the 104-byte limit (`chromium-headless-shell` with
  `--single-process`; full Chrome needs the patched sandbox runtime, see below).
- **The sandbox runtime patch is not in published installs yet.** This repository patches
  `@anthropic-ai/sandbox-runtime` (`patches/@anthropic-ai__sandbox-runtime@*.patch`, applied by pnpm
  in the workspace) so the macOS profile lets full Chrome read the `hw.product` and
  `kern.hv_vmm_present` sysctls it needs to start headless. The package is built with plain `tsc`
  and depends on the runtime from npm, so `npm i -g @capybara-hq/device` installs the unpatched
  runtime: there, full Chrome (and Puppeteer's or Playwright's default `chrome` / `chromium`
  headless mode) fails to start in the macOS sandbox. Everything else works the same:
  `chromium-headless-shell` with `--single-process`, local servers, unix sockets, package caches,
  the network rules, Linux (the patch is macOS only), Docker mode and running without a sandbox.
- **Unix sockets (Linux).** Blocked: the sandbox runtime can only allow every socket there,
  including the host daemons' (Docker, D-Bus, ssh-agent). Allowing them with the daemons' sockets
  masked is planned after a spike that proves them unreachable; it has not been done yet. Use
  Docker mode for browsers on Linux.
- **Package caches.** `XDG_CACHE_HOME`, `npm_config_cache`, `npm_config_store_dir` (pnpm),
  `PIP_CACHE_DIR`, `UV_CACHE_DIR`, `CARGO_HOME`, `GOMODCACHE`, `GOCACHE`, `GRADLE_USER_HOME`,
  `MAVEN_OPTS` (`-Dmaven.repo.local`), `PLAYWRIGHT_BROWSERS_PATH` and `COREPACK_HOME` point at
  folders of `<dir>/cache/`, kept across commands. Your own `~/.npm`, `~/.cache` and pnpm store stay
  read only, so a sandboxed command cannot poison your own builds. A command that sets one of
  these variables itself keeps its value.

### Running without a sandbox

`isolation` in `policy.json` is `sandbox` (default) or `none`. With `none` and tier `open`, in OS
mode, commands run directly on this computer as you: your real `HOME`, `PATH`, environment,
caches, credentials (SSH keys, cloud accounts, keychain), Docker and any network, like a coding
agent with its sandbox off. They still start in `workspace/`, and the platform's file tools still
stay inside the device's directories. Such commands can also read this program's own credential
(`credential.json`): if you suspect misuse, run `capybara-device logout` and log in again, which
revokes it. Prompt injection can make an agent delete files or send your credentials away: turn it
on only on your own development machine, with agents and material you fully trust.

```bash
capybara-device policy set tier open --yes        # first: an explicit local tier open
capybara-device policy set isolation none --yes
capybara-device policy set isolation sandbox      # back to the sandbox
```

It is set only on this machine: `set isolation none` is refused unless `tier` is set to `open` in
`policy.json` (following the organization's default is not enough), prints the risk and needs
`--yes` or a `y` at the prompt, and the device refuses it from the deployment whatever `remoteGrants` says (turning it
back to `sandbox` from the deployment is accepted). A Docker-mode device refuses it. The platform
or the organization may refuse to use a device that runs without a sandbox; its owner then turns
the sandbox back on.

### Changes from the deployment

`remoteGrants` in `policy.json` decides whether the deployment may widen this device's network
policy on the device owner's decision (an approval answered in a signed-in web or IM session, or
the device page):

- `owner` (default): the device accepts the `policy` operation's additions to `allowedDomains`
  (an approval adds an exact host; the device page may add a `*.` wildcard) and a higher `tier`,
  and adds a run's or a scheduled task's granted hosts to a command's list. Grants are exact hosts
  and never go beyond the organization's egress.
- `off`: the device refuses every widening from the deployment (additions, a higher `tier`, run and
  task grants) with "This device does not accept network changes from the deployment; allow it
  locally: capybara-device policy add allowedDomains <host>".

`isolation: none` is never accepted from the deployment. Narrowing (removing hosts, a lower
`tier`, `isolation: sandbox`) is always accepted. Every host is validated like
a local one, the change is written under `policy.json.lock`, and it applies at the next command.
`remoteGrants` itself is set only locally: `capybara-device policy set remoteGrants owner|off`
(or in `policy.json`). Each change from the deployment is
recorded in the local command log (`commands.log`, next to `policy.json`) with who decided it,
and so is a refused attempt and the grants a command was given:

```text
{"op":"policy","detail":"policy add files.slack.com by Ada Lovelace (acc_123) via web, approval apr_456",...}
{"op":"policy","detail":"policy refused tier open by Ada Lovelace (acc_123) via web",...}
{"op":"exec","detail":"grants run run_789 by acc_123: files.slack.com",...}
```

Docker mode has no per-domain allowlist (a container has either no network or the whole
internet), so a Docker-mode device refuses every widening from the deployment ("This device runs
commands in Docker mode, which cannot limit network access per domain; switch the device to OS mode
to allow single domains."), reports no refused hosts and ignores grants; narrowing still applies.
`capybara-device policy add allowedDomains` on a Docker-mode device warns that any allowed domain
opens the whole internet.

Limit to know: commands of one device run as the same user, and the sandbox runtime ties a
command's list (including its run grants) to the proxy credentials it hands that command. Another
command running at the same time on the same device could reuse them, so a run's grants may be
usable by a concurrent command of another run on that device: same owner, same device.

Limits to know: the platform's `Grep` tool assumes GNU grep, so on macOS (BSD grep) in OS mode some
Grep options behave differently or fail. Docker mode (a Linux container) does not have this issue.

Not enforced yet in OS mode: the `cpu` and `memoryMb` ceilings, and `allowCredentials` (commands
get no local credentials at all). Processes a command leaves running are killed with it by tag;
on macOS a child that leaves the command's process group and runs only Apple system binaries
cannot be found again (Linux runs each command in its own pid namespace, which takes every child
down with it).

## Docker mode

`login --mode docker` runs every command with `docker exec` in one container per device
(`capybara-device-<deviceId>`, started on first use from
`ghcr.io/capybara-hq/capybara-sandbox:<tag>`, the sandbox image of this release). On Linux commands
run as your own uid:gid, so they can write the mounted directories you own (a root user falls back to
the image's `sandbox` user, uid 1000); on macOS as the image's `sandbox` user. `<dir>/workspace`, `<dir>/skills` (read only) and `<dir>/tmp` are mounted
at `/workspace`, `/skills` and `/tmp`; the container has a read-only root file system, a pids limit of 1024, `--memory-swap` equal to
`memoryMb`, `--cap-drop ALL` and `no-new-privileges`. The policy's `cpu` and
`memoryMb` become `--cpus` and `--memory`; at tier `dev` and `open` `/dev/shm` grows to a quarter
of `memoryMb` (at most 1 GiB; 1 GiB without a ceiling) for browsers. The container is reused while
its mounts and flags match and recreated when they change (at the next command that finds it
idle); it stays running (idle) between starts. Commands always have the container's own localhost
and unix sockets; `isolation none` is refused.

Docker mode has no domain allowlist: a command has either no network (`--network none`) or the
default bridge, with the whole internet and this machine's network. It gets the bridge only when
the local `allowedDomains` holds a domain the device's egress allows, or the tier is `open` and the
organization allows any host (under an organization allowlist, `open` counts only the explicit
local domains, like the lower tiers); the dev hosts of tier `dev` do not open it. Use OS mode to limit
commands to single domains.

## Running at login

`capybara-device service install` makes the program start at login: on macOS a launchd agent
(`~/Library/LaunchAgents/top.capybara.device.plist`, log `service.log` in the state directory), on
Linux a systemd user unit (`~/.config/systemd/user/capybara-device.service`). Both restart the
program when it exits non-zero (systemd after 5 s) and leave it stopped after a terminal exit (code
0, see above); once the cause is fixed, `service install` again starts it. A user unit runs only
while you have a session, so run `loginctl enable-linger $USER` to start it at boot and keep it
running after you log out. `service.log` is emptied into `service.log.1` at 10 MiB when the program
starts. The service runs `node <bin> start` with the `PATH` of the shell that installed it (so
`docker` is found). `service uninstall` reverses it.
