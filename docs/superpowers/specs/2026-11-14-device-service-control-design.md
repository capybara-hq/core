# Device service control: `capybara-device service start|stop|restart|status`

Status: proposed, 2026-11-14. Area: `packages/device` (the CLI), docs of the local agent.

## The problem

The agent can be installed as a login service (`capybara-device service install`, launchd on macOS
and a systemd user unit on Linux), but the service can then only be installed, uninstalled and
looked at. Everything else goes wrong quietly:

- `capybara-device stop` sends `SIGTERM` to the running program; `KeepAlive` (launchd) and
  `Restart=on-failure` (systemd) bring it straight back. The command prints a success line and
  nothing stops.
- After `npm i -g @capybara-hq/device@<new>`, nothing in the CLI makes the running service load the
  new code. On 2026-11-14 a machine kept a `0.1.0-rc.7` daemon after the package became `rc.9`: it
  did not report the auto-mode policy, so the kernel failed closed to sandbox and the device page
  showed 沙箱 while `capybara-device mode` already said `auto`. The fix was a `launchctl kickstart`,
  which the CLI never mentions.
- `service status` answers "loaded, running (pid n)" without saying which version is running, so a
  stale daemon looks healthy.

## What this adds

`capybara-device service start|stop|restart|status` on both platforms, one meaning per verb, and the
top-level `start` / `stop` stop pretending when a service is installed.

| Verb | launchd (macOS) | systemd `--user` (Linux) |
|---|---|---|
| `install` | write the plist, `bootstrap` it (today) | write the unit, `daemon-reload`, `enable`, `restart` (today) |
| `uninstall` | `bootout`, remove the plist (today) | `disable --now`, remove the unit, `daemon-reload` (today) |
| `start` | `bootstrap` the plist when the service is not loaded; nothing when it is | `start`; nothing when active |
| `stop` | `bootout` (the plist stays); running commands end | `stop` |
| `restart` | `kickstart -k` (the plist must be loaded; `bootstrap` when it is not) | `restart` |
| `status` | see below | see below |

Rules that keep the verbs honest:

- **start / restart when nothing is installed** print the install line and exit 1. `service start`
  never writes a plist; only `install` does.
- **stop unloads, it does not signal.** A signal would be undone by `KeepAlive`; `bootout` is the
  only way to keep it stopped until `service start` or the next login. Running commands end with
  it. `capybara-device drain` is not a graceful prelude under a service — the program exits when
  drained and the service manager starts it again — so `service stop` is the whole stop today; a
  later change may have it drain first.
- **restart is the upgrade path**: it reloads the program from the installed `bin`, so a newer
  package takes effect. The line names the versions it moved from and to when they differ.
- Every verb is idempotent: `start` on a running service, `stop` on a stopped one, `restart` on an
  unloaded but installed one all succeed with one line and change nothing else.

## `service status`

Three facts, in this order, and a fourth only when it matters:

```
capybara-device service is loaded; running (pid 48945, 0.1.0-rc.9).
installed 0.1.0-rc.9.
```

- Not installed: `capybara-device service is not installed. Install it: capybara-device service install` — exit 1.
- Installed, not running: `capybara-device service is installed, but nothing is running. Start it: capybara-device service start` — exit 1.
- Running, same version: two lines, exit 0, no third line.
- Running, older than the installed package: exit 0 (it *is* running) and a third line:
  `installed 0.1.0-rc.9 — restart it: capybara-device service restart`.
- A pid file from a program older than this change carries no version: `running (pid n, version unknown)`
  and the restart line, one branch that reads a bare number as unknown.

**How the running version is known.** `start` writes the pid file as JSON —
`{ "pid": n, "version": "0.1.0-rc.9", "startedAt": "<iso>" }` — instead of a bare number, and
`readRunningPid` gains `readRunning` (pid + version) beside it. The version compared against is the
CLI's own `PROGRAM_VERSION` (the installed package), never a version fetched from anywhere.

## Top-level `start` and `stop` while a service is installed

Both look at the service file (`~/Library/LaunchAgents/top.capybara.device.plist`,
`~/.config/systemd/user/capybara-device.service`):

- `capybara-device stop` → `capybara-device runs as a login service on this machine. Stop it with: capybara-device service stop`
  (exit 1). Sending `SIGTERM` into `KeepAlive` is the bug this removes.
- `capybara-device start` runs as before — a stopped service may legitimately be served in the
  foreground — but prints one line first: `capybara-device runs as a login service on this machine.
  Restart it with: capybara-device service restart`. It must keep working when the service manager
  itself invokes it (the plist and unit run exactly `node <bin> start`).
- No service file: today's behaviour, unchanged (`stop` signals the running pid; `start` runs in the
  foreground).

## What does not change

- The service files (`plist` / unit contents), their labels and paths.
- `install` / `uninstall` semantics and output, except that `install`'s final line points at
  `service status` for the version check.
- The device protocol, the kernel and the web.

## Tests (`packages/device/test`)

Unit, with `ServiceDeps.run` recording calls and `platform` injected — no real launchctl/systemctl:

- `start` on macOS: the install hint and exit 1 when the plist is missing; already-running line
  when loaded; `bootstrap` once when installed but unloaded.
- `stop`: `bootout` and no `kill` of the recorded pid; the plist is left in place.
- `restart`: `kickstart -k` when loaded, `bootstrap` when not.
- `status`: the four shapes above, the version-mismatch line, and the bare-number pid file.
- Linux: `start` / `stop` / `restart` map to `systemctl --user start|stop|restart`; `is-active`
  gates `start`; a failed `restart` reports the unit's state.
- Top-level `stop` with a service file present: the refusal line and exit 1 (and no signal);
  `start` with one prints its line and still runs. Without the file, the existing tests pass.
- `writePid` / `readRunning`: JSON round trip; a bare number reads as `{ pid, version: undefined }`.

## Docs

`packages/device/README.md` and the local-agent section of the sandbox skill gain the verbs, the
upgrade line (`service restart` after a package upgrade) and the status output.

## Out of scope

- Self-update of the program or the package.
- `service logs` (the `service.log` path stays documented, not a verb).
- Any change to how the kernel learns a machine's policy.
