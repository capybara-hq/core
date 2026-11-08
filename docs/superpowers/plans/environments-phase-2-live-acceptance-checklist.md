# Environments phase 2: live acceptance checklist

Run on a deployment with this branch's kernel (gateway role reachable over `wss://` at
`/device/connect`, through web's forwarding (`CAPYBARA_WEB_GATEWAY_URL`) or a proxy route, see
docs/deploy/README.md) and the `@capybara-hq/device` build from the same
commit. Gates before calling phase 2 done: the maintainer's macOS machine and one Linux machine.

## macOS, OS mode

- [ ] `capybara-device login --url <deployment>` opens the browser; `/device` shows the code and the
      machine; confirming with a new environment connects it (the environment shows online).
- [ ] A conversation on the environment runs `Bash` and `Write`; the model is told the real
      directories (the `environment_paths` line) and uses them, not `/workspace`.
- [ ] Reading `~/.ssh`, `~/.npmrc` or `~/Library/Keychains` from `Bash` is refused; writing outside
      the working directory is refused.
- [ ] With an empty policy, `curl` fails; after
      `capybara-device policy set allowedDomains registry.npmjs.org` and a restart, npm's registry is
      reachable and another domain is not (policy change narrows or widens only the local side; the
      environment's egress setting still caps it). Then remove the domain again
      (`capybara-device policy set allowedDomains ""`), restart, and confirm npm's registry is
      refused again.

## Linux, `--no-browser`

- [ ] `login --no-browser` prints the address and code; approving in a browser on another machine
      finishes the login; `bwrap` and `socat` are installed first (sandbox-runtime needs them).
- [ ] The same conversation checks as on macOS pass (real paths, `Bash`, `Write`, denied reads).

## Network loss

- [ ] Wi-Fi off for 30 s in the middle of a long `Bash` command: after it returns the result is
      delivered to the conversation (no duplicate run).
- [ ] Wi-Fi off for 3 min: the environment shows offline, calls answer `environment.offline`, the
      command is killed when the program is back online (or finished and its result discarded after
      the grace).

## Revocation and replacement

- [ ] Revoking the machine from the web closes the program's connection (it logs the revocation and
      stops).
- [ ] Deleting the environment: the program stops and the files in the working directory stay.
- [ ] Logging a second machine into the same environment replaces the first: the first is revoked and
      disconnected, the second is online.

## Files lost

- [ ] Stop the program, delete the environment's working directory by hand, start it again: the
      environment page shows 文件已丢失 with the guidance and no 重建文件, and a tool call answers
      files lost. Run `capybara-device logout`, then `capybara-device login` into the same
      environment: the directory is recreated, the next conversation call works (a new
      `environment_paths` line), and the page no longer says 文件已丢失.

## Docker mode

- [ ] On a machine with Docker, `login --mode docker`: the container `capybara-device-<environmentId>`
      starts on first use, commands run as uid 1000 with the working directory at `/workspace`,
      the root file system is read-only, and with an `egress: none` environment the container has no
      network.

## Service

- [ ] `capybara-device service install`, reboot the machine (Linux: `loginctl enable-linger`): the
      program is connected again without a manual start.

## Follow-ups (not blocking phase 2)

- Grep in the kernel assumes GNU grep; macOS devices in OS mode have BSD grep (options differ).
- `/skills` wording in the skill-invocation text and the Claude Code tool map still names a fixed
  directory; it should use the instance's skills root.
- Device-only deployments' eval replays: a replay needs a connected machine or recorded results only.
- Linux bubblewrap tests need `bwrap` and `socat` in CI.
- A request frame sent on a socket that is dying can be lost: the gateway marked it taken, the
  program never saw it, and the call waits out its timeout. The program could list the request ids
  it knows right after `hello`, so the gateway re-sends or fails the others at once.
- Migration 0094 builds its index without `CONCURRENTLY` (a lock on a large table during the
  migration); fine before 0.1.0, revisit for later index migrations on big tables.
