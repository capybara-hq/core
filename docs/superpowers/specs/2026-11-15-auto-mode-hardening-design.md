# Auto mode hardening: P0 command review, P1 correctness

Status: accepted 2026-11-15 (D1–D4 as recommended). Areas: `packages/kernel` (command review, settings, devices, platform
ops, config), `packages/device`, `apps/web` (device page), `capybara-hq/plugins`
(`sandbox-docker`, `sandbox-e2b`).

## Why

Auto mode (spec `2026-11-13-auto-mode-design.md`, core #265, #285, plugins #92, #93) reached `main`
and was released in `0.1.0-rc.30` / device `rc.10`. A review of the delivery on 2026-11-15 (five
independent reviewers, each finding reproduced against `main`) found the plumbing sound — the
review fails closed, approvals are owner-only and transactional, the event log carries everything
the model sees, sandbox mode never runs unsandboxed, the Docker egress proxy holds against DNS
rebinding and address-encoding tricks — but:

- **P0**: the command review's rule stage allows destructive and exfiltrating commands through
  routes that are not spelling tricks (interpreter one-liners, symlinks, `mv`), and session grants
  allow more than the person approved, including in unattended runs.
- **P1**: several places disagree about the effective mode or network, one approval silently
  closes an org's cloud network, the device reports a capped mode as the owner's choice, the
  device's service and pid handling has dead ends, and a cloud device's narrowing is one click
  and permanent.

This spec fixes those. Design-system process gaps, loading shapes, weakened tests, compatibility
layers and duplicated derivations are the follow-up "A" and are out of scope here (§7).

## 1. Decisions (accepted 2026-11-15: the recommendation in bold)

- **D1 E2B and the open network.** `sandbox-e2b` refuses `open-public` because the Firecracker
  metadata service (MMDS, `169.254.169.254`) cannot be blocked — but its own live checks show MMDS
  answers under every E2B policy, allowlist included, so the refusal removes no exposure and makes
  auto mode unusable on E2B. **Map `open-public` to internet access plus `denyOut` of the private,
  loopback and link-local ranges; document MMDS as a residual E2B exposure in both modes.**
  (Alternative: send all E2B egress through a Capybara proxy — larger, later.)
- **D2 A cloud device back to auto.** Today a cloud device narrowed to sandbox can never return:
  nothing clears `devices.mode`, while spec §4.3 gives the owner "auto / sandbox". Widening is a
  person's act. **Allow `PATCH /devices/:id { mode: null }` (follow the org and the platform) from
  a person in a web session; never from a token, the Platform tool or an agent.**
- **D3 Sandbox on the default open network.** With the default `cloudNetwork: open`, a cloud device
  in sandbox mode keeps the open network, so the switch changes nothing visible. **Keep the
  semantics (spec §4.3 defines `cloudNetwork` as the sandbox-mode network) and make the page say
  what the device will reach: the 沙箱 card names the org's actual network.** Changing the default
  is a separate product decision.
- **D4 Interpreters.** `python -c`, `node -e`, `perl -e`, `ruby -e`, `deno eval`, `npx <pkg>` and an
  interpreter run on a file the run itself just wrote are `allow.dev` today. **Inline code and
  stdin to an interpreter, `npx`/`pnpm dlx`/`uvx` of a package, and running a file written by a
  `Write`/`Edit` call of the same conversation become `unsure` (classifier, else ask). Running
  project scripts (`npm test`, `pnpm build`, `python manage.py …` on a file the conversation did
  not write) stays allow.**

## 2. P0 — the command review

All in `packages/kernel/src/sandbox/review/**` and the review service; no protocol change.

**R1 Interpreters (D4).** New rule `unsure.interpreter` for `-c` / `-e` / `--eval` / `eval`
/ a heredoc or pipe into `python|node|perl|ruby|php|deno|bun|osascript|sh|bash|zsh`, and for
`npx|pnpm dlx|yarn dlx|bunx|uvx|pipx run` (a package that is a development tool the table already
allows stays allowed — `npx tsc`; one that is itself a script runner is judged as one — `npx tsx
x.ts`; accepted 2026-11-15), and for `<interpreter> <file>`
or `./<file>` when `<file>` is in the run facts' `writtenPaths`: the workspace-relative paths that
`Write`/`Edit` calls of this conversation wrote (read once per review from the conversation's
tool calls; bounded to the last 200). `DEV_PROGRAMS` no longer covers these forms. The commandline
too-long text no longer advises writing a script file.

**R2 Destroying targets, any program.** `deny.root-delete` becomes `deny.root-destroy` and covers
every write program, not only `rm -rf`: `rm -r`, `mv`, `chmod -R`, `chown -R`, `cp`/`rsync` over,
`truncate`, `shred`, `find … -delete` whose target is `/`, `~`, `$HOME`, the workspace root or a
parent of it. The `isDangerousDelete` skip in `ask.outside-write` goes.

**R3 Links.** `ln` (symbolic or hard) whose **target** is outside the workspace and tmp is
`ask.outside-link`; a target that is a secret path or a persistence location (§R5) is
`ask.credential-link` (not grantable). The link's own location keeps today's rule.

**R4 Every hit counts.** An `ask` outcome is allowed by session grants only when **every** `ask`
hit's id is granted and **no** `unsure` hit remains; otherwise the remaining ungranted hits decide
(ask, or the classifier for a remaining `unsure`). `decidingHit` stays for the reason text only.

**R5 Grant classes the person can reason about.** `ask.rc-files` splits into `ask.shell-config`
(shell rc files, `~/.gitconfig` and `git config --global`), `ask.persistence` (crontab, launch
agents and daemons, systemd user units, git hooks) and `ask.ssh` (writes under `~/.ssh`,
`ssh-keygen`, `authorized_keys`); credential files other than SSH become `ask.secret-file`. Not
grantable for the session (always asked once): `ask.credential-print`, `ask.secret-file`,
`ask.credential-link`, `ask.dynamic-arg`, `ask.sudo`. The card's
「本会话允许同类」 is shown only for grantable ids (it already is, via `isSessionGrantableRule`,
which gains the list).

**R6 Unattended runs use no grants.** `ReviewService` consults session grants only when the run is
attended; an unattended `ask` is the existing immediate deny. The facts' `attended` is the one
source for both.

**R7 `gh api` writes.** `gh api` with `-X/--method` other than `GET`/`HEAD`, or with `-f`/`-F`
fields (which make it a POST), is `ask.remote-write` (grantable); `DELETE` on `repos/*` is
`ask.remote-destroy`.

**R8 Too long to review.** A command whose classifier input had to be cut is `ask`, whatever the
classifier answers. A command over the 32 KiB ceiling is denied before review with an actionable
message ("Split the command; long inline scripts are reviewed as unsure").

**R9 Secret paths (spec change).** Add `~/.npmrc`, `~/.pypirc`, `~/.vault-token`,
`~/.terraform.d/credentials.tfrc.json`, `~/.config/op/**` and shell history files
(`~/.*_history`, `~/.local/share/fish/fish_history`) to the secret list of spec §5.2.

**Tests.** Besides corpus lines for each route above, a new **guarantee test**
(`review-guarantees.test.ts`): for a table of acts (delete the home directory, read a private key
and send it, overwrite a shell rc file) × spellings (shell, `bash -c`, interpreter inline, written
script, symlink, `mv`, `xargs`, env-prefixed), assert the outcome is never `allow`, and that a
grant for one id never allows a command with another ungranted id. The ordered-hit corpus stays,
but the guarantee test is the authority. Grant and unattended behaviour get service tests
(`review.service`) and one pipeline test for a scheduled run in a conversation with a grant.

Spec `2026-11-13-auto-mode-design.md` §5.2 and §5.4 are updated in the same change (R1, R2, R3, R5,
R9; the grant rule of R4 and R6).

## 3. P1 — kernel

**K1 Approving a network request keeps the org's network mode.** `RequestsService.approveNetwork`
writes `cloudNetwork: { mode: current?.mode ?? deployment.mode, allowHosts }`; approving adds hosts
to the list that caps local sandbox devices without turning an open cloud network into an
allowlist. The test that asserted the flip is corrected.

**K2 One derivation for what the model is told.** `platform.me` (and any other inline derivation)
calls `effectiveDevicePolicy`; a sandbox-mode device on the open network is reported as open. A
test pins `platform.me` against `effectiveDevicePolicy` for each mode × network.

**K3 Removed config fails loudly.** Startup fails with a clear error when the loaded config (file,
Nacos or env) still carries `sandbox.tiers` or the removed egress values, naming
`devices.autoMode` / `cloudNetwork` as the replacement — a silently ignored security key reads as
a widening. The `devices.autoMode` description and `sandboxConfigWarnings` stop assuming "auto off
⇒ allowlist": the warning fires whenever any org can be on the open network while the provider
refuses it; `docs/config.md` is regenerated.

**K4 A cloud device back to auto (D2).** `PATCH /devices/:id` accepts `mode: null`; the controller
refuses it for a token (`device.mode_requires_session`), the Platform operation keeps `sandbox`
only, and an audit row records the widening. The DTO and the shared schema change together
(platform parity).

**K5 The open-network refusal text.** `sandboxOpenNetworkRefused` names what an admin can do now
(switch the org's cloud network to an allowlist, or use a provider that offers the open network)
and drops the removed `openEgress` setting.

**K6 Migration 0130 (record only).** 0130 mapped `{max: "open", allowUnsandboxed: false}` to
`autoMode: allowed` and a missing `max` to `off`. The source keys are deleted, so no later
migration can recover the intent; there are no production users before 0.1.0. The upgrade notes
(`docs/deploy/upgrade.md`) tell an operator who used `allowUnsandboxed: false` to set the org's auto
mode off after upgrading. No code change.

## 4. P1 — the device program

**DV1 Report the owner's choice.** `policySummary` reports `policy.mode`, never the mode cut by the
last exec's ceiling; the kernel already takes min(allowed, reported). Effect: when an org later
allows auto, the device page and the review facts follow at once instead of at the next command.
The exec path keeps applying the ceiling it receives.

**DV2 `stop` under a service.** The top-level `stop` refuses only when the service manager reports
the service loaded (launchd) or active (systemd) **and** the running pid is the service's;
otherwise it signals the running program as before. `service start` refuses while a foreground
program runs ("stop it first"). `start` prints the service hint only when it was not started by the
service manager (launchd sets `XPC_SERVICE_NAME`; systemd sets `INVOCATION_ID`).

**DV3 Terminal exits stay down on macOS.** A terminal exit (logout, a revoked credential, `drain`,
not logged in) exits 0; every other exit is non-zero. The plist uses `KeepAlive { SuccessfulExit:
false }` with the existing `ThrottleInterval`. Before changing it, the plan confirms which exits
#264 ("keep the login service running across kernel restarts") relied on being restarted, and makes
those non-zero. systemd keeps `Restart=on-failure`, which already behaves this way.

**DV4 A pid file names this program.** `readRunning` trusts a pid only when the process's command
line (`ps -o command= -p <pid>`) contains the `capybara-device` bin and its start time is not later
than the file's `startedAt`; otherwise the file is stale. `stop`/`drain` never signal an unverified
pid.

**DV5 `service status` says what is true.** Four shapes: not installed; installed and not loaded;
loaded but not running (crash-looping) — pointing at `service.log` and `service restart`; running
(pid, version) plus the restart line when the running version differs from **the package at the
service file's bin path** (read from its `package.json`), not from the invoking CLI. `stop` and
`restart` report a failure when the service is still loaded or did not come back.

**DV6 No host file access without a fresh decision.** In `exec/switch.ts`, when the OS sandbox is
unavailable and the local policy is auto, a file operation with no fresh exec decision is refused
(as sandbox mode refuses), instead of being served by `HostFiles("auto")`.

**DV7 Small fixes.** `login` checks sandbox availability before writing a sandbox policy and words
the line for `--mode docker`; `service.ts` uses `hasLoginService` instead of its own check; the pid
parser is shared.

## 5. P1 — the device page

**W1 Narrowing a cloud device asks first.** Choosing 沙箱 on a cloud device in auto opens a
confirmation dialog naming the effect (the network it will reach per D3, whether running processes
end, and how to switch back per D2) before the `PATCH`; the local device keeps applying through the
machine. With D2, the 自动 card of a sandbox cloud device is enabled for the owner and also
confirms.

**W2 The unavailable card says why.** A card that cannot be chosen is disabled and carries its
reason (spec §6.3 option cards); the section description no longer repeats the cards.

## 6. P1 — plugins

**PL1 E2B open network (D1).** `networkOf` maps `open-public` to internet access with `denyOut`
of `10/8`, `172.16/12`, `192.168/16`, `127/8`, `169.254/16`, `100.64/10`, `fc00::/7`,
`fe80::/10` and `::1/128`. README and manifest state the residual: E2B serves MMDS inside the VM
whatever `denyOut` says. The live test gains the open-network items.

**PL2 More denied addresses in Docker.** The proxy's deny list adds `168.63.129.16/32` (Azure
WireServer) and accepts a deployment-configured `deniedCidrs` (the deployment's own public or
corporate addresses, spec §4.2); the README drops "neither mode can reach the host" in favour of
what is enforced.

**PL3 `refuseOpenNetwork` on resume.** A resumed or auto-started instance whose labels say
open-public while `refuseOpenNetwork` is set answers `gone`, so the kernel recreates it under the
current rule; allowlist → open-public is a `recreate` too, keeping labels truthful.

**PL4 Housekeeping.** Remove `.superpowers-p1-report.md` from the plugins repo root.

## 7. Out of scope (follow-up "A")

The DetailPage band form's design process (states, reference and catalog blocks, size table,
head-rhythm, compare, the lost column gap, skeleton tokens), loading shapes that do not match their
pages, the weakened device tests and `hostInvalid`, the compatibility layers before 0.1.0 (legacy
isolation summaries, `tier:` grants, the attribution fallback defaults), the duplicated mode
derivations and program tables, stale comments and repeated copy, the `CommandApproval` variant's
missing spec.

## 8. Delivery

Four PRs, P0 first and alone (trust boundary: reviewed alone on the most capable model):

1. `fix(kernel): harden the command review` — §2, spec §5 update. Patch changeset `kernel`.
2. `fix: auto mode correctness` — §3, §5, the shared schema. Patch changesets `kernel`, `capybara`.
3. `fix(device): honest service control and mode reports` — §4. Patch changeset `device`.
4. plugins: `fix(sandbox-e2b|sandbox-docker): …` — §6.

Each PR states its tests; release after 1–3 merge (version PR), then plugins and the bootstrap pin.
The B acceptance on a real machine follows on the released versions.
