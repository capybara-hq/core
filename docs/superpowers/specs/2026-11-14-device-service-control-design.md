# Device service control: `capybara-device service start|stop|restart|status`

Status: proposed, 2026-11-14; revised 2026-11-15 by the auto-mode hardening (DV2–DV5 of
`2026-11-15-auto-mode-hardening-design.md` §4: exit codes and `KeepAlive`, `stop` under a service,
verified pid files, `status` shapes). Area: `packages/device` (the CLI), docs of the local agent.

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
| `start` | `bootstrap` the plist when the service is not loaded; `kickstart` when it is loaded but its program exited; nothing when it runs | `start`; nothing when active |
| `stop` | `bootout` (the plist stays); running commands end; fails while still loaded | `stop`; fails while still active |
| `restart` | `kickstart -k` (the plist must be loaded; `bootstrap` when it is not); fails when the program does not come back | `restart`; same check |
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
- **start / restart wait for the program** (up to 10 s) until the service manager names a running
  pid (a new one for `restart`) and otherwise fail, pointing at `service.log`. `service start`
  refuses while a program started in a terminal runs: `Stop it first: capybara-device stop`.
- **Exit codes decide restarts (2026-11-15).** The program exits 0 only for a deliberate stop
  (logout, a revoked credential, a deleted device, a newer connection of this device, `stop`,
  `drain`, not logged in) and non-zero for every exit the service must recover from (a crash, an
  invalid start, 426 — the deployment needs a newer program, which an upgrade in place recovers).
  The plist uses `KeepAlive { SuccessfulExit: false }` with `ThrottleInterval` 30; systemd keeps
  `Restart=on-failure`. #264 had made `KeepAlive` unconditional; a kernel restart never needed it,
  because connection failures (1001 shutdown, 1011, 4001, 4409, refused connections, 5xx) reconnect
  inside the program and never exit.
- Every verb is idempotent: `start` on a running service, `stop` on a stopped one, `restart` on an
  unloaded but installed one all succeed with one line and change nothing else.

## `service status`

Four shapes (revised 2026-11-15), from what the service manager says (launchd `print` and its
`pid = n` line; systemd `is-active` and `MainPID`), never from the pid file alone:

```
capybara-device service is loaded; running (pid 48945, 0.1.0-rc.9).
```

- Not installed: `capybara-device service is not installed. Install it: capybara-device service install` — exit 1.
- Installed, not loaded: `… is installed but not loaded. Start it: capybara-device service start` — exit 1.
- Loaded, not running (it exited, possibly crash-looping): names `service.log` in the state
  directory and `capybara-device service restart` — exit 1.
- Running: the manager's pid and the version from the pid file (when it names the same pid), exit 0;
  when the package at the service file's `bin` path is a different version, a second line:
  `installed 0.1.0-rc.9 — restart it: capybara-device service restart`.
- A pid file from a program older than this change carries no version: `running (pid n, version unknown)`
  and the restart line, one branch that reads a bare number as unknown.

**How the running version is known.** `start` writes the pid file as JSON —
`{ "pid": n, "version": "0.1.0-rc.9", "startedAt": "<iso>" }` — instead of a bare number, and
`readRunningPid` gains `readRunning` (pid + version) beside it. The version compared against is the
`package.json` of the package at the service file's `bin` path — what a restart would run — not the
invoking CLI's own version (revised 2026-11-15), never a version fetched from anywhere.

**A pid file is verified (2026-11-15).** `readRunning` trusts a pid only when it is alive, `ps`
shows a command line containing `capybara-device`, and the process did not start after the file's
`startedAt` (a reused pid did); otherwise the file is stale. `stop`, `drain`, `logout` and `start`'s
already-running check never act on an unverified pid.

## Top-level `start` and `stop` while a service is installed

Both look at the service file (`~/Library/LaunchAgents/top.capybara.device.plist`,
`~/.config/systemd/user/capybara-device.service`):

- `capybara-device stop` → `capybara-device runs as a login service on this machine. Stop it with: capybara-device service stop`
  (exit 1), only when the service manager reports the service loaded (launchd) or active (systemd)
  **and** its pid is the running program's (revised 2026-11-15). A program started in a terminal
  next to an installed service is signalled as before.
- `capybara-device start` runs as before — a stopped service may legitimately be served in the
  foreground — but prints one line first: `capybara-device runs as a login service on this machine.
  Restart it with: capybara-device service restart`, only when the service manager did not start it
  (launchd sets `XPC_SERVICE_NAME` to the label; systemd sets `INVOCATION_ID`, and `SYSTEMD_EXEC_PID`
  names this process). It must keep working when the service manager itself invokes it (the plist
  and unit run exactly `node <bin> start`).
- No service file: today's behaviour, unchanged (`stop` signals the running pid; `start` runs in the
  foreground).

## What does not change

- The service files' labels and paths (the plist's `KeepAlive` changed on 2026-11-15, above).
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
