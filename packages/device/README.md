# @capybara-hq/device

`capybara-device` connects a laptop or server to a [Capybara](https://github.com/capybara-hq/core)
deployment as a device: the platform's agents run commands and read and write files on this
machine while the program is online, confined by the conversation's permission profile and by this
machine's owner ceiling.

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
`status [--json]`, `start`, `stop`,
`drain [--wait] [--timeout <seconds>]`,
`ceiling show | ceiling set --full-access allow|deny --project-reach workspace|os-user [--yes]`,
`policy [show | set <key> <value> | add|remove <key> <value>]` and
`service install|uninstall|start|stop|restart|status`.
`ceiling set` is the only way to change the owner ceiling (`policy set mode` points there); a
widening prints the risk text and asks for confirmation unless `--yes` is given. The old daily
`mode auto|sandbox` command is gone.

State lives in `$XDG_CONFIG_HOME/capybara-device` (default `~/.config/capybara-device`):
`credential.json` (mode 0600; the program refuses a file other users can read; it also holds the
deployment's reconnect grace and frame limit: a result larger than the frame limit is answered
with an error instead) and `policy.json` (a file with wrong field types stops `start` with an
error naming it; once running, the program re-reads the file when it changes, and a broken edit
is no authority: operations and owner reports are refused with the reason until it is fixed, never
served from a policy read earlier). Changes made with `capybara-device policy` take
`policy.json.lock`, so two writers never lose an update; keys this version does not know are kept.
The working directory (default `~/capybara-device/<deviceId>`) holds `workspace/`, `skills/`
and `tmp/`.

## Permissions

Every operation the deployment sends carries a scope: the conversation's permission profile
(`request-approval` and `approve-for-me` are restricted, `full-access` is Full access), the roots
it may read and write, and its network. The device checks each one against the **owner ceiling**
in `policy.json`, which only you change, on this machine:

- **Full access** `allow|deny`: whether a conversation set to Full access may run here. Full access
  runs as you (in Docker mode, as the container's user): your files, credentials and network; the
  deployment reviews every command, but that review is the boundary, not a sandbox.
- **Project reach** `workspace|os-user`: whether restricted work and project browsing may read
  projects outside the device's `workspace/`.

A new login starts restricted (`deny`, `workspace`). `login` prints the ceiling and how to widen
it; a widening prints the risk text and needs `--yes` or a `y` at the prompt. The organization and
the platform can switch Full access off on their side; the narrowest setting wins.

```bash
capybara-device ceiling show                    # the owner ceiling, network baseline, revision
capybara-device ceiling set --full-access deny --project-reach workspace       # narrow
capybara-device ceiling set --full-access allow --project-reach os-user --yes  # widen
capybara-device policy add allowedDomains files.slack.com
capybara-device policy remove allowedDomains files.slack.com
capybara-device policy show
```

**Restricted work** runs each operation in its own sandbox: macOS uses
`@anthropic-ai/sandbox-runtime` (Seatbelt); Linux and Docker mode use the SDK's restricted Linux
runtime (Landlock plus a seccomp broker). Writes stay in the scope's roots; reads stay in them too,
plus the system and developer tool directories (on macOS `/System`, `/usr`, `/bin`, `/sbin`,
`/private/etc`, Homebrew, Xcode and the Command Line Tools, `/Library/Apple`, `/Library/Frameworks`,
installed JDKs) and the data of the version managers your home uses, read only; other files of the
machine, such as the rest of your home, are not readable. Secret paths (`~/.ssh`, cloud CLI
credentials, `~/.netrc`, `~/.gnupg`, browser profiles, this program's state directory) stay
unreadable even inside those. The network is the owner ceiling's: `open` reaches the public
internet, `allowlist` only hosts in the local `allowedDomains` that the organization's allowlist
also admits (plus a run's or a task's grants, within that allowlist). Either way traffic goes
through the operation's own proxy, which decides each connection on the resolved address and dials
the address it checked: loopback (another program's localhost port), private and LAN, CGNAT, IPv6
ULA, link-local, cloud metadata and NAT64 addresses and this machine's own addresses stay closed,
for names and IP literals alike. A client that ignores the proxy variables (plain `ssh`) does not
connect; a restricted command cannot listen on macOS (a dev server needs an approved call outside
the sandbox). Behind a fake-IP resolver (a router or proxy in OpenClash-style fake-IP mode answers
every name with an address in `198.18.0.0/15`), the proxy re-resolves such a name through
DNS-over-HTTPS (RFC 8484) to Cloudflare (`1.1.1.1`, `1.0.0.1`) and then Google (`8.8.8.8`,
`8.8.4.4`), reached by IP over verified TLS within 5 seconds, and judges the real answer; when that
lookup fails the connection is refused with a reason naming the fake-IP resolver, never dialed to
the fake address. The open network decides on the address, not on where it routes: a router's
public WAN address reached by hairpin NAT, a VPN routing public addresses to an intranet, or an
operator NAT64 prefix are not closed; such a machine should keep the allowlist. Restricted work also
follows one write policy (below). On macOS each restricted command also gets its own empty temporary
directory (`TMPDIR`, `TMP`, `TEMP`), removed when the command ends; `mktemp` without a template
writes to the user's shared temporary directory instead, which stays closed, so give it one (`mktemp
"$TMPDIR/x.XXXXXX"`). On Linux `TMPDIR` is the first write root. When the restricted runtime is
unavailable here, the device reports it to the deployment and refuses restricted work with the
reason; nothing falls back to running unconfined.

A change to the ceiling or the policy applies at the next operation without a restart, and running
work the narrower ceiling no longer allows is stopped. `add` and `remove` work on `allowedDomains`
and `allowCredentials`; every domain must be a lowercase host name (optionally `*.` for
subdomains, never the apex), never an IP address or an internal name.

In OS mode the hello reports your home directory (the base for project paths), and browsing
follows the project reach. The device tracks every process an operation starts and stops it
exactly when the operation ends, is cancelled or its task is stopped; it never kills by guessing.

### Changes from the deployment

The deployment changes the local policy only by narrowing it: it may add or remove
`allowedDomains` (an approval adds an exact host; the device page may add a `*.` wildcard) and
narrow the owner ceiling. It can never widen it. Every host is validated like a local one, and the
change is written under `policy.json.lock`.

### The command log

`commands.log` (next to `policy.json`, mode 0600, rotated to `commands.log.1` at 10 MiB) records
one line per command (exec or background start: tag, account, conversation, `restricted` or
`full`, exit code, the grants' source) and every policy change, from the deployment or the CLI,
refused or failed ones included. It never holds a command's text, its environment or file contents.

```text
{"op":"exec","tag":"t1","actor":{"accountId":"acc_123","conversationId":"conv_1"},"exitCode":0,"isolation":"restricted",...}
{"op":"policy","detail":"policy add files.slack.com by Ada Lovelace (acc_123) via web, approval apr_456",...}
{"op":"policy","detail":"ceiling set fullAccess allow, projectReach os-user by ada via cli",...}
```

Limits to know: the platform's `Grep` tool assumes GNU grep, so on macOS (BSD grep) in OS mode some
Grep options behave differently or fail. In OS mode the `cpu` and `memoryMb` ceilings are not
enforced yet, and `allowCredentials` is ignored (Full access already has your credentials,
restricted work gets none).

### Upgrading from a protocol 2 program

The old program's auto mode ran commands as you, outside any tracking this version has: processes
they left running survive the upgrade. Restart the machine, or kill such leftovers from before the
upgrade yourself; this version never searches for them. In Docker mode the old container is
recreated at the first operation, which ends whatever it still ran.

## Docker mode

`login --mode docker` runs every operation in one container per device
(`capybara-device-<deviceId>`, started on first use from
`ghcr.io/capybara-hq/capybara-sandbox:<tag>`, the sandbox image of this release). On Linux it runs
as your own uid:gid, so it can write the mounted directories you own (a root user falls back to the
image's `sandbox` user, uid 1000); on macOS as the image's `sandbox` user. `<dir>/workspace`,
`<dir>/skills` (read only) and `<dir>/tmp` are mounted at `/workspace`, `/skills` and `/tmp`; the
container has a read-only root file system, a pids limit of 1024, `--cap-drop ALL`,
`no-new-privileges`, and the policy's `cpu` and `memoryMb` as `--cpus`, `--memory` and an equal
`--memory-swap`.

The container is always on Docker's default bridge: Full access has the container's whole network.
Restricted work inside it is confined by the Linux launcher (Landlock, the seccomp broker and the
proxy with the allowlist above), on the container's paths. The hello reports no home directory, and
browsing covers the container's `/workspace` only. The container is reused while its mounts, flags
and format match, and recreated, once no operation holds it, when they differ or when it lost its
bridge; it stays running (idle) between starts.

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

## Operation backend

The program speaks device protocol 3 only. It binds each instance generation the deployment creates
to a verified, sealed runtime and reports restricted support only once a self-check on that runtime
passed (macOS: a write in its root goes through, while a write outside it, reads of a denied secret
and of an ordinary file it was never granted, and a local connection are refused) or the runtime's
probe passed (Linux, Docker); there is no Full fallback for restricted work.

Each restricted operation has its own immutable sandbox-runtime process and proxy lifetime.
Native methods use the SDK's hash-checked Python helper and pinned directory descriptors, with a
private descriptor-identity handshake before dispatch. Full uses the existing OS user directly.
Execution grants arrive separately over authenticated transport; scope hosts cannot manufacture
an owner allowance. Strict fresh owner-policy reads fail closed on missing or malformed policy.

Restricted operations follow one write policy on every platform (`sandbox-write-denies.ts` in
the SDK): no shell, git-global, direnv, npm, editor, agent or hook-manager configuration; inside
any `.git` only git's ordinary internals; no bare-repository lookalike; no `.git` moved away.
As defence in depth, owners are advised to run

    git config --global safe.bareRepository explicit

so git never treats a directory a command prepared (for example inside `.git`) as a repository
unless it is named with `--git-dir`. capybara-device never changes the user's git configuration.

The private supervisor consumes operation IDs durably before launch, records trusted child
identities, bounds output tails to 65,536 bytes and preserves cancellation and unknown outcomes.
A restarted supervisor never signals a recorded PID or relaunches a consumed operation. Cleanup
covers its registered execution groups; it does not discover arbitrary unregistered detached
processes. Its owner-policy watcher runs while it owns live work independently of connection state,
and every successful policy write reconciles live work at once. Journals fail closed when their bounded
capacity is exhausted; terminal results remain subject to their reference retention deadlines.
