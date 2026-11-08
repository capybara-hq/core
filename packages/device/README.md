# @capybara-hq/device

`capybara-device` connects a laptop or server to a [Capybara](https://github.com/capybara-hq/core)
deployment as an environment: the platform's agents run commands and read and write files on this
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

`login` shows a code like `BCDF-GHJK`; with `--no-browser` it prints the address (`<url>/device`) and
the code to enter on any signed-in browser, where you pick the org and the environment (a new one or
an existing connected one of yours) after reading what the program can do. Logging in again from
another machine into the same environment replaces the first machine (its credential is revoked).
`stop` ends the running program, `drain` makes it accept no new commands and exit when the running
ones finish. `logout` stops a running program, then forgets the credential (the machine stays
connected on the platform until it is revoked there). Deleting the environment in the web app
revokes the machine and stops the program; the files in the working directory stay on your machine.

The deployment must route `/device/connect` on its public URL to the gateway role (see
[Connected devices](https://github.com/capybara-hq/core/blob/main/docs/deploy/README.md#connected-devices)).
While connecting keeps failing, `start` retries and prints why at most once a minute: the HTTP
status (a 404 usually means that route is missing), the close reason, or the network error.

`start` exits 0, after printing why, when retrying cannot help: the machine was revoked or the
environment deleted, the program is too old for the deployment (426), another login replaced this
connection, or the machine is not logged in. Other failures exit non-zero, so a service (below)
restarts the program after those and leaves it stopped after the terminal ones; fix the cause
(log in again, upgrade), then run `start` or `service install` again.

If the working directory (or its marker `.capybara-device`, or one of `workspace/`, `skills/`,
`tmp/`) is removed, the program never recreates it: operations answer that the files are lost and
the environment page says so. To start afresh, run `capybara-device logout` and then
`capybara-device login` into the same environment: login recreates the directory and the marker,
and the platform rebuilds the environment on its next use.

Commands: `login --url <url> [--no-browser] [--dir <path>] [--mode os|docker]`, `logout`,
`status [--json]`, `start`, `stop`, `drain`, `policy [show|set <key> <value>]` and
`service install|uninstall`.

State lives in `$XDG_CONFIG_HOME/capybara-device` (default `~/.config/capybara-device`):
`credential.json` (mode 0600; the program refuses a file other users can read; it also holds the
deployment's reconnect grace and frame limit: a result larger than the frame limit is answered
with an error instead) and `policy.json` (a file with wrong field types stops `start` with an
error naming it).
The working directory (default `~/capybara-device/<environmentId>`) holds `workspace/`, `skills/`
and `tmp/`.

In OS mode every command runs inside `@anthropic-ai/sandbox-runtime` (macOS Seatbelt, Linux
bubblewrap; Linux needs `bwrap` and `socat`): writes only under `workspace/` and `tmp/`,
`skills/` read only, `~/.ssh`, cloud CLI credentials, `~/.netrc`, `~/.gnupg`, browser profiles and
this program's state directory unreadable. Network is limited to the domains of the local policy
that the environment's egress also allows; with an empty policy (the default) commands reach no
network at all. Only you edit the policy, the platform can never widen it:

```bash
capybara-device policy set allowedDomains registry.npmjs.org,*.github.com
capybara-device policy show   # changes apply at the next start
```

Limits to know: the platform's `Grep` tool assumes GNU grep, so on macOS (BSD grep) in OS mode some
Grep options behave differently or fail. Docker mode (a Linux container) does not have this issue.

Not enforced yet in OS mode: the `cpu` and `memoryMb` ceilings, and `allowCredentials` (commands
get no local credentials at all). Processes a command leaves running are killed with it by tag;
on macOS a child that leaves the command's process group and runs only Apple system binaries
cannot be found again (Linux runs each command in its own pid namespace, which takes every child
down with it).

## Docker mode

`login --mode docker` runs every command with `docker exec` in one container per environment
(`capybara-device-<environmentId>`, started on first use from
`ghcr.io/capybara-hq/capybara-sandbox:<tag>`, the sandbox image of this release). On Linux commands
run as your own uid:gid, so they can write the mounted directories you own (a root user falls back to
the image's `sandbox` user, uid 1000); on macOS as the image's `sandbox` user. `<dir>/workspace`, `<dir>/skills` (read only) and `<dir>/tmp` are mounted
at `/workspace`, `/skills` and `/tmp`; the container has a read-only root file system, a pids limit of 1024, `--memory-swap` equal to
`memoryMb`, `--cap-drop ALL` and `no-new-privileges`. The policy's `cpu` and
`memoryMb` become `--cpus` and `--memory`. The container is reused while its mounts and limits
match and recreated when they change; it stays running (idle) between starts.

Docker mode has no domain allowlist: a command has either no network (`--network none`, when the
local policy or the environment's egress allows no domain) or the default bridge, with the whole
internet. Use OS mode to limit commands to the domains of the local policy.

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
