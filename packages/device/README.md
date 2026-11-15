# @capybara-hq/device

`capybara-device` connects a laptop or server to a [Capybara](https://github.com/capybara-hq/core)
deployment as a device: the platform's agents run commands and read and write files on this
machine, in auto mode (as you, with every command reviewed by the deployment) or inside an OS
sandbox, while the program is online.

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
ones finish (`drain --wait [--timeout <seconds>]` returns only once it has exited, at most 600 s by
default). Both signal only a pid the pid file names **and** `ps` shows to be `capybara-device`,
started before the file was written; a stale file (a reused pid) is never signalled. When the login
service runs the program, `stop` refuses and points at `service stop`; `drain` exits 0, which the
service leaves stopped until `service start`. `logout` stops a
running program, then forgets the credential (the machine stays
connected on the platform until it is revoked there). Deleting the device in the web app
revokes the machine and stops the program; the files in the working directory stay on your machine.

The deployment must route `/device/connect` on its public URL to the gateway role (see
[Connected devices](https://github.com/capybara-hq/core/blob/main/docs/deploy/README.md#connected-devices)).
While connecting keeps failing, `start` retries with exponential backoff (capped at 60 s, with
jitter) and never gives up: a failure different from the last one is printed at once, the same one
at most once a minute. The message is the HTTP status (a 404 usually means that route is missing),
the close reason, or the network error.

`start` exits 0 only for a deliberate stop: the machine was revoked or the device deleted, another
connection of this device replaced this one, `stop` / `drain` / `logout`, or the machine is not
logged in. The login service (below) leaves such an exit stopped. Every exit it must recover from is
non-zero, and the service restarts it: a crash, an invalid start (`Cannot start: …`), or a
deployment that needs a newer program (426: upgrade the package in place and the next restart runs
the new one). A failing connection never ends the program: it reconnects with backoff, so a kernel
restart needs no service restart. After logging in again, start the installed service with
`capybara-device service restart`; `capybara-device service status` shows what is true now.

If the working directory (or its marker `.capybara-device`, or one of `workspace/`, `skills/`,
`tmp/`) is removed, the program never recreates it: operations answer that the files are lost and
the device page says so. To start afresh, run `capybara-device logout` and then
`capybara-device login` into the same device: login recreates the directory and the marker,
and the platform rebuilds the device on its next use.

Commands: `login --url <url> [--no-browser] [--dir <path>] [--mode os|docker]`, `logout`,
`status [--json]` (it prints the command mode too), `start`, `stop`,
`drain [--wait] [--timeout <seconds>]`, `mode [auto|sandbox] [--yes]`,
`policy [show | set <key> <value> [--yes] | add|remove <key> <value>]` and
`service install|uninstall|start|stop|restart|status`.
`mode` is the only way to switch the command mode (`policy set mode` points there); `mode auto`
prints the risk text and asks for confirmation unless `--yes` is given.

State lives in `$XDG_CONFIG_HOME/capybara-device` (default `~/.config/capybara-device`):
`credential.json` (mode 0600; the program refuses a file other users can read; it also holds the
deployment's reconnect grace and frame limit: a result larger than the frame limit is answered
with an error instead) and `policy.json` (a file with wrong field types stops `start` with an
error naming it; once running, the program re-reads the file when it changes, and a broken edit
keeps the last valid policy and logs one error). Changes made with `capybara-device policy` take
`policy.json.lock`, so two writers never lose an update; keys this version does not know are kept.
The working directory (default `~/capybara-device/<deviceId>`) holds `workspace/`, `skills/`
and `tmp/`.

In OS mode a device runs every command in one of two modes (`mode` in `policy.json`; switch it
with `capybara-device mode`):

- **auto** (the default of a new login): commands run directly on this computer as you — your real
  `HOME`, `PATH`, environment, caches, credentials (SSH keys, `gh`, cloud CLIs), Docker and any
  network. It is what a coding agent without an OS sandbox has, and what Claude Code calls auto
  mode. The deployment reviews every command before it runs and blocks, or asks about, the
  dangerous ones (deleting outside the workspace, sending a secret away, force-pushing a protected
  branch). The platform's file tools reach any absolute path on the machine.
- **sandbox**: today's strict `@anthropic-ai/sandbox-runtime` profile (macOS Seatbelt, Linux
  bubblewrap; Linux needs `bwrap` and `socat`). Writes only under `workspace/` and `tmp/`,
  `skills/` read only, `HOME` = the workspace, `~/.ssh`, cloud CLI credentials, `~/.netrc`,
  `~/.gnupg`, browser profiles and this program's state directory unreadable, no local binding or
  unix sockets, and network only to the domains of the local policy that the organization's
  allowlist also admits (with an empty list, no network at all). Commands keep their package
  caches in the workspace like any other file.

If the OS sandbox is unavailable on the machine (an unsupported platform or missing dependencies,
such as `bwrap` / `socat` on Linux), the device still starts and serves: auto mode works, and every
sandbox-mode command is refused with the reason and how to fix it (`capybara-device mode auto`, or
install the dependencies and restart). `capybara-device mode sandbox` is refused on such a machine
and the policy stays in auto; nothing ever runs unsandboxed by falling back. File operations
(read, write, stat) there follow only a fresh command decision (the latest command, within a
minute): without one they are refused, never served on the host. `login` into an organization that
forbids auto mode checks the OS sandbox first: when it is unavailable, no sandbox policy is written
and the login line says what to install (or to log in with `--mode docker`).

```bash
capybara-device mode                            # print the current mode
capybara-device mode sandbox                    # switch to the sandbox
capybara-device mode auto                       # prints the risk text and asks; or add --yes
capybara-device policy add allowedDomains files.slack.com      # sandbox mode
capybara-device policy remove allowedDomains files.slack.com
capybara-device policy show
```

A change applies at the next command; a running program does not need a restart. Turning the
sandbox back on stops the commands still running in auto mode. Auto mode is set only on the
machine: the deployment may narrow a device to `sandbox` but never turn auto mode on. An
organization can allow or forbid auto mode; when it forbids it, this device runs in the sandbox
and its summary says so, and the device's own `mode sandbox` always wins. `add` and `remove` work
on `allowedDomains` and `allowCredentials`; every domain must be a lowercase host name (optionally
`*.` for subdomains, never the apex), never an IP address or an internal name. They apply in
sandbox mode only.

A command ends with everything it started: once it returns (or times out, or is stopped), the
program kills what it left running, such as `server &` or `nohup …`, because inside the sandbox no
later command may signal another command's processes. Its process group goes at once, and a process
that left the group (`setsid`) is found by the marker every process of the command carries. On
macOS only a background task launch (`Bash` with `run_in_background`, whose command starts with the
line `# capybara: background task launch`) keeps what it starts. On Linux the sandbox's pid
namespace already ends every process with its command. In Docker mode and without a sandbox, a
later command can stop what an earlier one left, so nothing is killed.

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
with a summary of its local policy: the owner's `mode`, never cut by an exec's ceiling (the
deployment applies its own), and the sandbox-mode `allowedDomains`).

### Sandbox mode details

In sandbox mode commands keep `HOME` = `workspace/`, writes stay inside the device directory, the
secret paths stay unreadable, and the network proxy refuses loopback, private addresses and
internal names as destinations. The device's `allowedDomains` are intersected with the
organization's allowlist; a host either list refuses is reported as described above.

Version managers (asdf, nvm, pyenv, mise, …) find their data under the real home, read only, so
their shims work with `HOME` = the workspace. Git can read a repository, but `.git/config` and
`.git/hooks` stay unwritable: a hook or `core.sshCommand` a command wrote would run when you later
run git there. When you want git to write (init, clone, remotes) or commands to use your
credentials, use auto mode.

### The auto mode risk

In auto mode agent commands have your full capability. The deployment reviews every command and
blocks or asks about the dangerous ones, but that review is the boundary, not an OS sandbox: prompt
injection can still make an agent attempt to delete files or send your credentials away. Commands
can also read this program's own credential (`credential.json`): if you suspect misuse, run
`capybara-device logout` and log in again, which revokes it. Keep auto mode to your own development
machine, with agents and material you trust; `capybara-device mode sandbox` turns the sandbox back
on.

### Changes from the deployment

The deployment changes the local policy only by narrowing it: it may add or remove
`allowedDomains` (an approval adds an exact host; the device page may add a `*.` wildcard) and set
`mode: "sandbox"`. It can never set `mode: "auto"` — that is `capybara-device mode auto` on the
machine, with its risk text and confirmation. Every host is validated like a local one, the change
is written under `policy.json.lock`, and it applies at the next command. Each change from the
deployment is recorded in the local command log (`commands.log`, next to `policy.json`) with who
decided it, and so is a refused attempt and the grants a command was given:

```text
{"op":"policy","detail":"policy add files.slack.com by Ada Lovelace (acc_123) via web, approval apr_456",...}
{"op":"policy","detail":"policy refused mode auto by Ada Lovelace (acc_123) via web",...}
{"op":"exec","detail":"grants run run_789 by acc_123: files.slack.com",...}
```

A run's or a scheduled task's network grants apply in sandbox mode only, within the organization's
allowlist; auto mode has the machine's own network, so grants do nothing there.

Limit to know: commands of one device run as the same user, and the sandbox runtime ties a
command's list (including its run grants) to the proxy credentials it hands that command. Another
command running at the same time on the same device could reuse them, so a run's grants may be
usable by a concurrent command of another run on that device: same owner, same device.

Limits to know: the platform's `Grep` tool assumes GNU grep, so on macOS (BSD grep) in OS mode some
Grep options behave differently or fail. Docker mode (a Linux container) does not have this issue.

Not enforced yet in OS mode: the `cpu` and `memoryMb` ceilings. In auto mode commands already see
the owner's credentials, so `allowCredentials` has nothing to add; in sandbox mode they get none.
Processes a command leaves running are killed when it ends; on macOS a child that leaves the
command's process group and runs only Apple system binaries cannot be found by its marker
(`ps -E` hides their environment), so it survives (Linux runs each command in its own pid
namespace, which takes every child down with it).

## Docker mode

`login --mode docker` runs every command with `docker exec` in one container per device
(`capybara-device-<deviceId>`, started on first use from
`ghcr.io/capybara-hq/capybara-sandbox:<tag>`, the sandbox image of this release). On Linux commands
run as your own uid:gid, so they can write the mounted directories you own (a root user falls back to
the image's `sandbox` user, uid 1000); on macOS as the image's `sandbox` user. `<dir>/workspace`, `<dir>/skills` (read only) and `<dir>/tmp` are mounted
at `/workspace`, `/skills` and `/tmp`; the container has a read-only root file system, a pids limit of 1024, `--memory-swap` equal to
`memoryMb`, `--cap-drop ALL` and `no-new-privileges`. The policy's `cpu` and
`memoryMb` become `--cpus` and `--memory`. The container is reused while its mounts and flags
match and recreated when they change (at the next command that finds it idle); it stays running
(idle) between starts. Commands always have the container's own localhost and unix sockets.

Docker mode has no per-domain network filter, so the mode alone decides:

- **auto**: the container runs on Docker's default bridge (the whole internet and this machine's
  network), and the platform's file tools reach any absolute path in the container.
- **sandbox**: the container has no network at all, and file operations stay in the mounted roots.

The network is switched between the two without recreating the container (a container disconnected
from every network has no network, the same as `--network none`). Use OS mode's sandbox when you
need to allow single domains.

## Running at login

`capybara-device service install` makes the program start at login: on macOS a launchd agent
(`~/Library/LaunchAgents/top.capybara.device.plist`, log `service.log` in the state directory), on
Linux a systemd user unit (`~/.config/systemd/user/capybara-device.service`). Both restart the
program only when it exits non-zero: the macOS agent uses `KeepAlive { SuccessfulExit: false }`, at
most every 30 s (`ThrottleInterval`); systemd `Restart=on-failure`, after 5 s. Exit 0 is a deliberate
stop and stays stopped.

`service start|stop|restart` control it without knowing launchctl or systemctl. `stop` unloads the
service (the plist or unit stays) rather than signalling the program; running commands end with
it, and it reports a failure when the service is still loaded afterwards. `start` and `restart`
wait (up to 10 s) until the service manager runs the program and report a failure, pointing at
`service.log`, when it does not come back; `service start` refuses while a program started in a
terminal runs ("stop it first"). On macOS a loaded agent whose program exited is started again with
`launchctl kickstart`. `restart` reloads the program from the installed `bin`, so it is **the way to
apply a package upgrade**: `npm i -g @capybara-hq/device@latest && capybara-device service restart`.
The top-level `stop` refuses only when the service manager runs the program it would signal (launchd
has the agent loaded, or systemd the unit active, and its pid is the pid file's) and points at
`service stop`; a program started in a terminal is signalled as before. `start` in a terminal says
how to restart the installed service; started by the service manager (launchd sets
`XPC_SERVICE_NAME`, systemd `INVOCATION_ID`) it prints no such hint.

`capybara-device service status` says one of four things: not installed; installed but not loaded
(`service start`); loaded but the program is not running, i.e. it exited (the reason is at the end of
`service.log`; fix it, then `service restart`); or running, with the service manager's pid and the
program's **version**. When the package at the service file's `bin` path (its `package.json`) is a
different version from the running program, it adds the restart command: an upgrade the service has
not picked up yet. The pid file records the version (`{pid, version, startedAt}`); one written by an
older program reads as "version unknown". A user unit runs only
while you have a session, so run `loginctl enable-linger $USER` to start it at boot and keep it
running after you log out. `service.log` is emptied into `service.log.1` at 10 MiB when the program
starts. The service runs `node <bin> start` with the `PATH` of the shell that installed it (so
`docker` is found). `service uninstall` reverses it. On macOS, installing again first boots the old
agent out and waits (up to 10 s) until launchd has let it go, because `launchctl bootout` returns
before that; a `bootstrap` that still fails with error 5 (Input/output error) is retried a few
times. On Linux, installing again restarts the unit so the new file applies.
