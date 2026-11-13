# Auto mode: capable devices, guarded by command review

- Date: 2026-11-13.
- Status: reviewed by the maintainer 2026-11-13; the four questions are answered in §11.
  The direction is the maintainer's (acceptance 2026-11-13), marked **(decided)**; calls made here
  are marked **(designer's call)**.
- Amends: the sandbox tiers spec `2026-11-12-sandbox-dev-tiers-design.md` (tiers, unsandboxed
  mode, the settings of §4.1), the network ask-to-allow spec `2026-11-12-network-ask-to-allow-design.md`,
  the environments spec `2026-11-07-environments-design.md` (§8.4 limits and egress), and in
  `capybara-hq/plugins`: `sandbox-docker` (egress) and `sandbox-e2b`.
- Relation to the sandbox git credentials spec `2026-11-12-sandbox-git-credentials-design.md` and
  its gateway (core#198, another line): no longer needed for the default path (§6); it stays an
  option for orgs that manage credentials centrally. That line is not changed by this spec.

## 1. Why

The maintainer, 2026-11-13, after a day of acceptance on a local macOS device and a cloud Docker
device:

> 现在如果让 agent 具备开发能力成本太高了。需要这里设置那里设置。我选了开发模式也很难完成一个
> 开发任务。…… 有没有什么可以兼顾安全和能力不被限制的方案吗？Claude Code 也是沙箱，他就什么都
> 可以，他连桌面都能读写，本质我们的 capybara-device 就是充当的 Claude Code，他就是在本地，应该
> 具有相同的能力啊（当然是说 Auto 模式）。docker 同理，已经在 docker 里了，还限制的那么死吗？

What acceptance hit, each one a setting or a dead end:

- Local servers were off because a listener on `127.0.0.1:2375` was detected (`localhost: auto`);
  turning them on is a CLI command on the machine.
- A background task lost its network right after launch (fixed in core#253, a bug, but it shows
  how many moving parts the network layer has).
- Cloning `capybara-hq/core` failed: sandbox-runtime's fixed list of protected files (`.mcp.json`,
  `.gitmodules`, `.vscode/`, `.idea/`, `.claude/commands`, `.claude/agents`, shell rc files) may
  not be written at any tier, so any repository that carries one cannot be checked out.
- `git push` / `gh` need credentials the sandbox withholds; the git gateway that would supply them
  is a separate project.
- Settings a person has to understand: device tier (4 choices), isolation, `localhost`,
  `remoteGrants`, the device's domain list, the org's `sandboxTier` and `sandboxEgress`, the
  platform's `sandbox.tiers.*` and `sandbox.limits.*`.

The root cause is where the safety lives. Today one layer, the OS sandbox around each command, is
asked to stop every harmful outcome. Since it cannot tell a harmful `rm` or upload from a normal
one, it has to forbid whole classes of capability, and each capability development needs comes back
as a knob. Claude Code's auto mode puts the safety in a second place: commands run with the user's
full capability, and each **action** is reviewed (rules, then a classifier) before it runs; the
sandbox is an optional extra. This spec moves Capybara to that model.

## 2. Goals, non-goals, anti-goals

Goals:

- A personal local device does what Claude Code in auto mode does on the same machine, out of the
  box: read and write any of the person's files, use their credentials (`~/.ssh`, `gh`, git
  credential helpers, cloud CLIs), run servers, browsers, Docker, any network.
- A cloud Docker device is as capable inside its container: no sandbox inside the container, open
  public network, `gh auth login` by device code.
- One review layer in the kernel that sees every command before it runs and blocks or asks about
  the dangerous ones (deleting outside the work, sending secrets away, force pushes to protected
  branches, disabling security tools), with a reason the model and the person can read.
- Settings a person can explain in one sentence: a device is **自动** or **沙箱**; an org allows
  auto mode or not; a cloud device's network is **开放（挡内网）** or **白名单**.

Non-goals:

- Making auto mode safe against a person who wants to harm their own machine. The owner controls
  the machine; this is about mistakes and prompt injection.
- Replacing org governance: tool policies, approvals, disabled tools and model purposes stay.
- Project (shared) devices: they keep the sandbox (§4.4) until a later spec.
- Linux OS-mode sandbox fixes (bwrap pid namespace, background tasks surviving their launch):
  the sandbox mode keeps today's Linux behaviour.

Anti-goals (would make this a failure even if it works):

- A review that interrupts normal development: if a typical session asks the person more than a
  handful of times, the rules are wrong.
- A review the agent can talk its way past: the classifier never sees the agent's own justification
  as instructions (§5.3).
- Special-casing one model's habits (the maintainer's standing rule: no targeted fixes for model
  behaviour).
- A second vocabulary next to the old one: the old knobs go (pre-0.1.0, no compatibility layers).

## 3. Terms

- **Auto mode** (自动): commands run without an OS sandbox, as the device owner on a local device
  or as the container user on a cloud device; every command passes command review.
- **Sandbox mode** (沙箱): today's `strict` tier behaviour (sandbox-runtime around each command,
  allowlisted network); command review still runs.
- **Command review**: the kernel step between the model's `Bash` call and the device exec that
  decides **allow**, **ask** or **deny** (§5).
- **Attended run**: a run started by a person's message in the web or an IM channel while that
  person is the conversation's owner; the device owner chatting in IM is attended, so an **ask**
  waits for a card in the IM thread **(decided 2026-11-13)**. **Unattended**: scheduled task runs,
  sub-agent runs whose root is unattended, runs started by anyone other than the device owner.

## 4. Modes per environment

**The two modes are defined by guarantees, not mechanisms (2026-11-14).** Auto: commands run with
the environment's own capability and no additional restriction, guarded by command review (§5).
Sandbox: writes limited to the workspace and temporary files, reads limited to the workspace, and
the network limited to an allowlist. The same words are interpreted by the environment: auto on a
local device reaches the whole machine; auto on a cloud device reaches one container. One logic is
not one risk profile; a description of a mode says what it guarantees, and the environment says what
that means.

### 4.1 Local device

| | Auto (default) | Sandbox |
|---|---|---|
| Process | `bash -c` as the owner, real `HOME`, `PATH`, env, keychain (today's `isolation: none`) | sandbox-runtime, today's `strict` profile |
| Files | everything the owner can touch | workspace, tmp, caches |
| Network | the machine's | the device allowlist |
| Credentials | the owner's (`~/.ssh`, `gh`, helpers, cloud CLIs) | none |
| Review | yes | yes |

- **Default is auto (decided).** A new local device is in auto mode when its org allows it (§4.3);
  `capybara-device login` prints one line saying so and how to switch.
- The owner switches on the machine: `capybara-device mode auto|sandbox`. From the web the owner
  may switch to sandbox (narrowing) but never to auto: turning auto on is a decision made at the
  machine, as unsandboxed mode is today **(designer's call: keeps "the platform can't widen the
  machine" rule of the tiers spec §5.4)**.
- **If the OS sandbox is unavailable** on the machine, sandbox mode refuses the command with a clear
  error (`sandbox.unavailable`); it never runs unsandboxed silently. Getting the work done then means
  switching the device to auto, a decision at the machine **(2026-11-14)**.
- The working directory stays the device's `workspace/`; commands may `cd` anywhere. The workspace
  root is supplied per run, not hardcoded: today the device's workspace, and a project root once
  projects land (2026-11-14).
- The kernel's
  file tools (`Read`, `Write`, `Edit`) are widened to absolute paths anywhere in auto mode, the way
  Claude Code's are **(decided 2026-11-13)**, still passing review for writes outside the workspace
  (§5.2).

### 4.2 Cloud device (sandbox-docker, sandbox-e2b)

- **No sandbox inside the container (decided).** The container is the boundary; commands run as the
  container user with the image's tools.
- **Network in auto mode: 开放（挡内网） (decided).** Any public host on any port; refused: loopback
  of the host, private ranges (`10/8`, `172.16/12`, `192.168/16`, `fc00::/7`), link-local and cloud
  metadata (`169.254/16`, `fe80::/10`), the deployment's own internal addresses. Enforced outside the
  container (Docker: the egress proxy / network policy the provider already runs; E2B: its network
  filter) **(designer's call: keep enforcement where it is today, change only the default list)**.
- **Sandbox mode on a cloud device is the same container with the allowlist network** (the container
  already gives the write and read limits, since those are the environment's). Its only additional
  guarantee over auto is the network. **白名单** is therefore sandbox mode's network, the org's host
  list as `sandboxEgress: allowlist` today.
- Command review runs the same way as on local devices.

### 4.3 Who may choose what

| Who | Setting | Values | Default |
|---|---|---|---|
| Super admin | `devices.autoMode` (deployment config) | `allowed` / `off` | `allowed` |
| Org admin | org setting `autoMode` | `allowed` / `off` (only when the platform allows) | follow the platform |
| Org admin | org setting `cloudNetwork` (the cloud device's **sandbox-mode** network) | `open` / `allowlist` + hosts | `open` |
| Device owner (local) | `capybara-device mode` | `auto` / `sandbox` | `auto` |
| Device owner (cloud) | device page | auto / sandbox (sandbox only narrows the network) | auto when allowed, else sandbox |

When auto mode is off for the org, local devices run in sandbox mode and the kernel refuses a
device that reports auto (`device.auto_mode_not_allowed`, as `device.unsandboxed_not_allowed` today);
cloud devices keep the container but the network becomes the allowlist.

### 4.4 What goes away

Removed (pre-0.1.0, no compatibility): the tiers `strict` / `dev` / `open` as user-facing choices,
`isolation`, `localhost`, `remoteGrants`, the device's own domain list and the network
ask-to-allow flow for auto-mode devices, the org's `sandboxTier`, the platform's `sandbox.tiers.*`.
Sandbox mode keeps the network ask-to-allow flow (it is the only way to widen it).
A device in auto mode has no network settings at all: on a local device the machine's network is a
fact, and a cloud auto device is 开放（挡内网）. The device network page exists in sandbox mode only.
`sandbox.limits.allowHosts` becomes the default host list of 白名单 and of sandbox mode.
Sandbox mode is today's `strict` profile only: the `dev` tier goes away as well **(decided
2026-11-13)**; a person who wants to develop without the OS sandbox uses auto mode, which covers
that need and is the default.
The migration of stored settings: a device whose local policy says `isolation: none` or tier
`open` becomes auto; anything else becomes sandbox; org and platform settings map `max: open`
→ `autoMode: allowed`, anything lower → `off`, and `sandboxEgress: allowlist` → `cloudNetwork:
allowlist` with its hosts **(designer's call)**.

## 5. Command review

### 5.1 Where it runs

In the kernel, in the sandbox tool pipeline, after argument validation and before the device exec,
for `Bash` (foreground and background launches) and for file tool writes outside the workspace.
It is a kernel step, not an extension hook: it must run for every device and fail closed. The
existing policy hooks (`ctx.hooks`, fail closed) still run after it, so an org's policy extension
can add rules **(designer's call)**.

### 5.2 Stage 1: rules

A pure function over the parsed command (shell words, pipes, redirections, `&&` / `;` chains,
`bash -c` / `sh -c` / `eval` unwrapped one level) and the run's facts (cwd, workspace root, mode,
attended or not). Each rule returns **allow**, **ask**, **deny** or **unsure**; the strictest wins.

- **Allow** (the bulk of development): reading anything except the secret paths below; builds,
  tests, linters, formatters, package managers (`npm`, `pnpm`, `pip`, `uv`, `cargo`, `go`, …),
  `git` except the cases below, `gh` reads and `gh pr create/edit/comment`, `curl`/`wget` GETs that
  write to stdout or the workspace, starting servers, browsers, `docker`/`docker compose` without
  `--privileged` or host mounts outside the workspace, writes and deletes inside the workspace and
  tmp.
- **Ask**: deleting or overwriting outside the workspace and tmp; `git push --force` /
  `--force-with-lease` to a default or protected branch, deleting remote branches or tags,
  `gh repo delete`, `gh release delete`; changing shell rc files, `~/.ssh`, `~/.gitconfig`, git
  hooks, launch agents, crontab; `sudo`; installing global packages; `docker` with `--privileged` or
  host mounts outside the workspace; `kill` of processes the device did not start.
- **Deny**: sending the contents of a secret path anywhere (a secret path read piped or attached
  to a network command); `rm -rf` of `/`, `~` or a parent of the workspace; disabling or editing
  Capybara's own device files; turning off the OS firewall or security tools.
- **Secret paths**: `~/.ssh/*` (private keys), `~/.aws`, `~/.config/gcloud`, `~/.azure`,
  `~/.kube/config`, `~/.docker/config.json`, `~/.netrc`, `~/.git-credentials`, `~/.config/gh/hosts.yml`,
  macOS keychain dumps (`security find-*-password -w`, `dump-keychain`), `.env*` files outside the
  workspace. Reading them for use by their own tool is allowed (`git push` reads `~/.ssh` itself);
  printing or copying them is **ask**, sending them is **deny**.
- **Wrappers**: a command is unwrapped before matching — `timeout`, `nice`, `nohup`, `stdbuf`,
  `command`, `builtin`, `noglob` and a bare `xargs`; `watch`, `setsid`, `flock`, `ionice` and a
  `find` with `-exec`, `-delete` or `-fprint` are never allowed by prefix **(2026-11-14)**.
- **Unsure**: anything the parser cannot read with confidence (heredocs that build scripts, long
  pipelines into an interpreter, obfuscation such as base64 into `sh`), and commands no rule covers.

The rule set lives in one module with a table-driven test of a few hundred command lines taken from
real sessions (the acceptance conversations of 2026-11-12/13 are the first corpus) **(designer's
call)**.

### 5.3 Stage 2: the classifier

For **unsure** only. One model call with purpose `review` (a new model purpose, configured like the
others; absent = no classifier). Input: the command, the cwd, the mode, the last person messages of
the root conversation (what the person asked for), and the rule hits. Never the agent's reasoning
or text, which a prompt injection controls **(designer's call, the same split as Claude Code's
auto mode)**. Output: `allow` / `ask` / `deny` and a one-sentence reason. Bounded: 1,500 input tokens
of messages, a 10 s timeout; a timeout, an error or an unparseable answer is **ask**.

Without a `review` model the classifier step is skipped and **unsure** becomes **ask**.

### 5.4 Outcomes

Deny rules apply in auto and sandbox mode alike; no org policy, tool policy or approval turns a
**deny** into an allow **(2026-11-14)**.

What an organization can and cannot do with its own tool policy (verified in
`packages/kernel/src/tools/policy.ts`, 2026-11-14): it can switch an extension's tools off
(unavailable), set a default **deny** for a connector's tools, forbid builtin tools in unattended
runs (`forbiddenTools`), and raise the side-effecting sandbox tools to **ask**
(`sandboxToolPolicy`). In an attended run it has no lever to deny a builtin tool: the person's
presence is the approval. So the org's ceiling over builtin tools is partial rather than absent —
describe it that way, and never say the org can govern nothing.

- **Allow**: the command runs. Nothing is shown; the decision is in the tool call's record.
- **Ask**, attended run: the run waits on an approval card in the conversation (the existing
  approval flow, kind `command`): the command, the reason, 允许一次 / 本会话允许同类 / 拒绝.
  本会话允许同类 records the rule hit (not the exact text) for the rest of the conversation
  **(decided 2026-11-13)**.
- **Ask**, unattended run: treated as **deny** at once, no waiting **(decided)**. The model gets
  the reason and "No one can approve this now; do the work another way or leave it for the person."
- **Deny**: the tool call fails with the reason (model-visible, English, actionable); the person
  sees it in the tool row.

Every decision is recorded on the tool call (`review: { decision, by: rule|classifier|person,
reason }`), visible in the trajectory, and counted in usage for the classifier calls.

### 5.5 Replay

The review result is part of the tool result the model sees, recorded in the log, so replays use
the recorded result and never re-run the review. A new model-visible text (deny and ask-unattended
messages) needs a `DriftReason` only if it changes how existing recorded calls render; it does not,
since it is new content in new results **(to confirm in the plan with the zero-drift tests)**.

## 6. Credentials

- **Local auto mode**: the owner's own credentials, untouched (decided): `git push`, `gh pr create`,
  `npm publish` work as in the owner's terminal, reviewed by §5.
- **Cloud**: `gh`'s own login (decided). The agent runs `gh auth login --web` (device code) in the
  container; the kernel recognises the device-code prompt in the output and shows it to the person
  as a card (open the URL, the code, a copy button); the token stays in the container's persistent
  file system, under the device owner's account only. `gh auth setup-git` makes `git push` use it.
  Recognising the prompt is a small parser for `gh`'s fixed output; other CLIs' device flows can be
  added the same way later **(designer's call)**.
- The git gateway (core#198) is not needed for these paths.

## 7. Contract and protocol changes (outline; the plan details them)

- `@capybara-hq/plugin-sdk`: `SandboxLimits` loses `tier`/`devHosts`, gains `mode: "auto" |
  "sandbox"` and `network: { kind: "open-public" | "allowlist", hosts }`; `pnpm gen:sdk-api` and a
  changeset.
- Device protocol: the `policy` frame reports `mode`; `capybara-device mode`; the old `policy set
  tier|isolation|localhost|remoteGrants` commands go.
- Kernel: `packages/kernel/src/sandbox/review/` (rules, classifier, outcomes), the approval kind
  `command`, the model purpose `review`, the org settings and deployment config of §4.3 (adding-config
  skill), the device-code card.
- `capybara-hq/plugins`: `sandbox-docker` egress default and private-range block; `sandbox-e2b`
  network policy.
- Web: device page (mode, one line of explanation, the switch command), org settings (two
  settings), admin settings (one), the approval card for commands, the device-code card.

## 8. Security review

- **Trust model change**: in auto mode the device owner's machine is reachable by the agent. Command
  review is the first gate, not an OS boundary: it sees text and intent, not what a command does
  once it runs. Sandbox mode is the recommended landing for high-risk work, and auto mode is a
  decision the owner makes at the machine. The risk text is shown once at login and on the device
  page. (Reworded 2026-11-14: Claude Code documents its permission rules as not a security
  boundary too.)
- **Threats and answers**: exfiltration of secrets (§5.2 deny), destructive deletes (ask/deny),
  persistence (rc files, launch agents, hooks: ask), lateral movement from cloud devices (private
  ranges and metadata blocked outside the container), a review the agent games (classifier never
  reads agent text), an attacker who triggers runs remotely (unattended runs never wait for an
  approval and never get **ask**-level commands; IM triggers from other people are unattended).
- **Multi-tenant**: cloud containers stay per device; no org shares a container; the private-range
  block keeps containers away from the deployment's internals.
- **Audit**: every **ask**/**deny** and every person's approval is recorded on the tool call and in
  the trajectory.

## 9. Rollout

Pre-0.1.0, so one switch-over: the device program and kernel change together; stored settings are
migrated (§4.4); the release notes tell device owners that new logins start in auto mode and how to
switch.

## 10. Testing

- Rules: the table test of §5.2, including bypass attempts (quoting, `eval`, base64, `$( )`).
- Classifier: a fake model in kernel tests; a live test behind `CAPYBARA_TEST_*` with a small
  labelled set.
- End to end on the acceptance scenarios that failed: clone `capybara-hq/core` (protected files),
  a local server with Docker's socket proxy running, a background `git clone`, `gh pr create` on a
  local device, `gh auth login` on a cloud device, a scheduled task that hits an **ask** command.

## 11. Decisions of the review (2026-11-13)

The four questions this draft put to the maintainer, answered:

1. File tools in auto mode reach absolute paths anywhere, as in Claude Code; writes outside the
   workspace pass review. (§4.1)
2. 本会话允许同类 remembers the rule hit for the conversation, not the exact command. (§5.4)
3. A run the device owner themselves triggers in IM is attended: an **ask** waits for a card in
   the IM thread. (§3)
4. Sandbox mode keeps today's `strict` profile only; `dev` goes away. (§4.4)
