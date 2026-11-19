# @capybara-hq/device

## 0.1.0-rc.16

### Patch Changes

- 387c309: macOS: a command's process group that holds only dead members (zombies not yet reaped) no longer
  fails the call or the stop. Darwin answers the group signal with EPERM there instead of ESRCH; the
  worker now checks for a live member before treating EPERM as a failure, so an aborted or finished
  command completes and a stop reports `stopped` instead of `cancel-pending`.

## 0.1.0-rc.15

### Minor Changes

- 7f86c80: Permission profiles are active: the kernel and `capybara-device` speak device protocol 3 only,
  every builtin enters a device through the managed operation route, and each run records its
  permission context. A restricted profile also reads the instance's staged skills root
  (read-only); the working root comes from the held instance's committed roots; an instance gone
  after a dispatched operation keeps the outcome unknown and is rebuilt for the next call; a run
  another member triggers in an owner's conversation runs without the owner's device. A
  `GenerateImage` call with `file_path` takes the same permission review as `Write`: an outside
  directory is asked about (or reviewed) and granted for that call only. The testing helpers run on
  the activated kernel.
  
  The old public permission inputs are gone. The config key `devices.autoMode` and
  `CAPYBARA_DEVICES__AUTO_MODE` now fail validation with a message that names `devices.fullAccess`
  and `capybara config migrate-permissions`. The admin settings no longer read or write
  `devicesAutoMode`, and the org settings no longer read or write `autoMode` (including
  `deployment.autoMode`); use `devicesFullAccess` and `fullAccess`. The refusals are renamed
  `org.full_access_not_allowed` and `deployment.full_access_not_allowed`. Stored old keys are still
  converted by the permission configuration publication.
  
  Kernel: the old background launcher is gone. A background `Bash` task starts, is polled, stopped
  and read only by its exact device reference; no session-id script runs any more. Tasks left from
  the old launcher are handed to the legacy retirement and never signalled or read live. A refused
  background start, and an old task's failed launch, are reported in actionable words instead of
  the device's raw message.
  
  `capybara-device` drops its protocol 2 surface: the old connection and dispatch (`killTagged`,
  `killAll` and unscoped operations are refused as unknown), the host and switching executors, the
  daily `capybara-device mode` command (use `capybara-device ceiling set`), the Docker executor's
  own commands and its startup marker reaper (the container now only hosts permission operations),
  and the last-good fallback of a broken `policy.json` (it is refused until fixed).
  Under protocol 3 the local `commands.log` records each exec and background start again (tag,
  account, conversation, restricted or full isolation, exit code, the grants' source; never the
  command or its environment) and every policy change from the deployment or the CLI.
  Upgrading from a protocol 2 `capybara-device`: processes the old auto mode left running are not
  searched for; restart the machine or kill leftovers from before the upgrade. A Docker-mode
  device's old container is recreated at its first operation (a container format version), and a
  container found without its bridge is recreated, never reconnected.
  
  The kernel never kills device work broadly any more: a crashed holder's operations are revoked
  exactly (owed in the outbox before its record is forgotten, so a failed revoke is retried), and a
  resumed, failed-update or quarantined instance revokes its started-or-unknown operations instead of
  `killAll`; no stored background session id is signalled after a resume or a rebuild.

### Patch Changes

- c30ec7c: `commands.log` records an approved per-call sandbox escalation as `isolation: "full"` with
  `grantSource: "call approval"` (decided by the operation's reach, never the command text).
- 86b1422: `capybara-device`: on macOS, a restricted command whose write root contains an owner-denied path
  (a project bound at the home directory, an approved `cd ~`) can no longer write the denied secret
  paths (`~/.ssh`, `~/.aws`, `~/.netrc`, …) or the device's own state directory: their files cannot
  be written, created, renamed or deleted, and the directories cannot be moved, removed or replaced
  by a symbolic link. Before, those paths were only hidden from reads. On Linux such a grant stays
  refused, and the refusal now names the root and the denied path and says to run from a narrower
  directory.
  
  A `capybara-device` newer than its deployment no longer tells the person to upgrade the program
  when the deployment refuses it as outdated (HTTP 426): it reads the deployment's device protocol
  from the refusal and, when the deployment's is older, says to upgrade the deployment first.
  
  The macOS restricted self-check first proves that a granted file reads: a read probe that fails
  for any reason no longer counts as a refused read.
- 0ce1ab0: `capybara-device`: an aborted or timed-out restricted command on macOS always completes. A
  descendant that left the command's process group (`fork` + `setpgid`) could hold its output pipe
  open, so the call never ended and the operation worker, its proxy and its private temporary
  directory stayed behind. Cancellation now stops and kills the command's descendants found by
  parent pid (including those in another group or session; one already reparented to launchd is
  not found), and once the owned group is gone the worker closes the pipes after a short grace.
- 413c495: `capybara-device`: restricted commands and file operations on macOS (Request approval, Approve
  for me) can no longer read files outside what they were granted. Before, every parent directory
  of a granted root, `/` included, was opened for reading with its whole subtree, so a restricted
  command could read almost any file of the machine except the denied secret paths. Reads are now
  limited to the granted roots, the system and developer tool directories (`/System`, `/usr`,
  `/bin`, `/sbin`, `/private/etc`, Homebrew, Xcode and the Command Line Tools, `/Library/Apple`,
  `/Library/Frameworks`, installed JDKs, the time zone data), the version managers' data and a few
  exact paths (`/tmp`, `/var` and `/etc` links, the random and terminal devices, the Xcode
  selection, license and tool cache); parent directories can still be passed through but not
  listed. The restricted self-check now also proves that an ordinary file it never granted stays
  unreadable, and reports restricted execution unavailable otherwise.
  
  Restricted commands and background tasks on macOS also get a working temporary directory again:
  each gets its own empty, private one (`TMPDIR`, `TMP`, `TEMP`), removed when it ends (a crashed
  device's are removed at the next launch). The runtime used to point `TMPDIR` at a shared
  `/tmp/claude` the device refuses, so `pnpm`, `cc`, Python's and Node's temp files failed. `mktemp`
  without a template still writes to macOS's shared user temporary directory, which stays closed:
  pass `"$TMPDIR/x.XXXXXX"`.
- cba5078: `capybara-device`: restricted commands on macOS and Linux hosts find version managers again
  (asdf, nvm, pyenv, rbenv, mise, volta, sdkman, rustup). Their variables are set from the device's
  real home and environment, as the protocol 2 OS sandbox did, and the directories they name are
  granted read only, with asdf's global `~/.tool-versions` as a single read-only file; nothing
  that is `/`, is, lies under or holds an owner-denied path is granted.
  Commands in the local-Docker container keep the image's home.
- 3cb0cf5: Kernel: the `device.auto_mode_not_allowed` refusal is gone with the protocol 2 machine-mode check
  (a protocol 3 device's owner ceiling refuses with `device.full_access_not_allowed`). A device held
  by the legacy retirement (`device.unavailable`, `device.restart_required`,
  `device.recreate_required`, `device.replace_required`) now tells the model what clears it instead
  of the inactive-provider text. Messages that named the removed `capybara-device mode` command name
  `capybara-device ceiling set` instead.
  
  `capybara-device`: unused protocol 2 helpers (the sandbox-runtime config, the network violation
  parser, host file access) are removed. Design: the `KeycapCommand` example names
  `capybara-device ceiling set`.
  
  The device sign-in token response names its field `fullAccess` (was `autoMode`; same values
  `allowed` / `off`), and `capybara-device login` reads it to say that the org does not allow Full
  access. A kernel and a device program upgrade together.

## 0.1.0-rc.14

### Minor Changes

- 429e837: Stage durable permission operation admission, fresh native operation facades and validated protocol adapters. Protocol activation remains gated on the coordinated caller and background migration.
- 9777d14: Replace the local policy's `mode` with a version-2 owner ceiling (`ownerCeiling: {fullAccess,
  restrictedProjectReach}`): old `mode: auto` converts exactly to Full allowed with OS-user reach,
  `mode: sandbox` to neither; `start` converts once under the policy lock and any write converts.
  The strict reader only trusts a version-2 file. New `capybara-device ceiling show|set`: setting
  needs both fields, narrowing applies directly, widening needs `--yes` or a confirmed prompt.
  Stage authenticated owner reports for protocol 3: the `owner-report.json` sequence sidecar,
  `parseOwnerCeilingReportV3`, and the report on policy frames, policy answers and applied policy
  statuses; a staged `policy` op may only narrow the owner ceiling and reconciles live work before
  answering. Protocol 2 and its `mode` summary are unchanged.
- 7a4762b: Stage a private macOS operation backend with strict owner-ceiling intersection, immutable workers,
  pinned native helpers and durable exact-execution supervision. Keep wire version 2 and current
  executors unchanged; restricted capability remains unavailable pending adapter acceptance and
  coordinated protocol, policy-reconciliation and background activation.

### Patch Changes

- 2256b24: The device hello can carry the host's OS boot identity (`bootId`; SDK `DEVICE_BOOT_ID_RE`,
  `isDeviceBootId`): `capybara-device` reports Linux's `boot_id` or macOS's boot session UUID (nothing
  otherwise) on the active and the staged hello. The kernel records it per machine from
  authenticated hellos only (a hello without one clears it); a local legacy retirement obligation keeps the boot its machine last
  reported and resolves once a current machine of the device (a re-login counts) reports another boot
  (the computer restarted). An obligation without a recorded boot never resolves by itself; the same
  boot from a new credential, a stale or replayed boot and a revoked machine are no evidence. A local device waiting for that restart
  answers `device.restart_required` ("Restart this computer to finish the upgrade").
  One whose computer never reported a boot identity answers `device.replace_required` (delete the
  device and connect the computer as a new one).
- 527c6a3: The published device package is now self-contained: packing bundles its whole runtime closure
  (the SDK, the patched sandbox runtime, ws and their dependencies) into `dist/node_modules`, byte for
  byte, and declares no dependencies, so an install gets exactly the bytes its runtime manifest names.
  The pack scripts run with `node --experimental-strip-types`.
- 124eb1f: Staged protocol 3: the device binds an instance generation only through the authenticated
  `bindInstance` request. It checks its stored previous binding, verifies the installed manifest and
  refuses while another generation's work is live or uncertain, then writes the binding durably
  before enabling that generation's operation backend. An unbound session admits no operation; a
  restart recovers the same generation's journal only when the installed runtime is unchanged. The
  kernel names as previous binding only one the current machine acknowledged.
- 427f193: Linux and local-Docker operation backends for permission profiles (dormant: reachable only through
  the staged protocol 3 path). On Linux hosts the device runs restricted commands through the SDK's
  Landlock and seccomp-broker launcher on pinned root descriptors, with every filesystem write
  brokered and the mandatory write denies refused, and network none or an allowlist served by a
  token-protected proxy owned by the operation (CONNECT to ports 80 and 443 and plain requests to
  port 80 only, globally routable addresses only). Native file work uses the SDK helper on pinned descriptors and refuses
  owner-denied paths (compared by real path too), link targets and the mandatory write denies; Full
  access runs as the OS user without restricted filters. The agent runs from inline source and
  executes the SDK runtime only from sealed memfds whose digests it checked. Background work,
  retained output and exact cancellation share the macOS supervisor; cancellation works without
  pidfds too, an abort escalates like a cancel, and a lost agent's recorded session (SID and start
  time) is reaped, also by the next device process. Restricted support is the launcher's own probe:
  an unsupported kernel, ABI, architecture or Python below 3.9 fails closed. A local-Docker device
  runs the same agent in its container. The macOS worker now enforces the same write policy through ordered Seatbelt regex rules (the
  pnpm patch of `@anthropic-ai/sandbox-runtime` accepts `writeRegexRules`): case-insensitive denies,
  the gitdir allowlist, no bare-repository `HEAD`, no forged repository, no `.git` and no directory
  holding a kept `HEAD` moved away, each write root matched in every spelling Seatbelt may see; git keeps working inside submodules,
  and the worker removes an empty `.git/sequencer` after a restricted command.
  The README recommends `git config --global safe.bareRepository explicit` as defence in depth.
- e6c338b: The macOS operation backend accepts the runtime bundle that also carries the Linux launcher and
  picks the native helper by name.
- 2b2e132: A restricted macOS worker no longer loads the sandbox runtime from the install by path. The
  verification a binding relies on (`verifyInstalledRuntime` with `stageIn`) copies the exact bytes
  it hashed into a private, content-addressed directory of the state directory and seals that copy;
  workers import only from it, and only when its runtime hash is the one the binding attested (the
  backend's `runtimeHash`). Each launch checks that the installed closure still holds the verified
  bytes and that the copy is untouched: a changed byte, a replaced file, an added file or a link swap
  (an in-place `npm update` while the service runs, say) refuses the launch with a typed unsupported
  error until a restart or rebind verifies the runtime again. Sandboxed JVMs get the staged proxy
  agent, and a runtime package declaring peer or optional dependencies is refused at verification.
- f241880: The device package now ships a canonical installed-byte manifest (`dist/runtime-manifest.json`,
  written by `tools/runtime-manifest.ts` at pack time from the emitted modules, the inline helper
  sources and the installed sandbox runtime closure) and a private verifier that re-hashes the
  installed bytes and the interpreter environment before attesting a runtime identity. Nothing uses
  it on the active protocol 2 path yet.
- 000b0fe: Prepares the device side of protocol 3 (dormant: protocol 2 still runs until the protocol constant
  changes). `start` builds the instance binder with one operation backend per bound generation
  (macOS, Linux or the device's container), attested to the binding's runtime hash and verified with
  the runtime staged in the state directory; one session state per machine credential with the
  credential's reconnect grace; a drain that waits for the owned work and the held answers; every
  end of the program (stop, machine stop, revoked, replaced, outdated) exact-stops the owned
  operations and names any stop still pending. A bind that passed its other checks, or a create,
  exact-stops the older generation's background tasks. macOS reports restricted support only after a
  real worker on the verified runtime passes a write, read and network self-check, retried after a
  transient failure; a docker-mode device attests its container's image id.
- a4eea48: The dormant protocol 3 session keeps one state per machine credential (a credential change drops
  the old state and its held answers), requires the reconnect grace explicitly, holds at most 64
  answers while no socket is ready (expired ones are swept on each hold), and refuses `bindInstance`
  while draining; status, reads, tails and stops are still served. Protocol 2 stays the live wire.
- cdf5abd: Staged instance binding (fix round 1): one operation supervisor owns a device's journal at a time,
  so binding a new generation drains the old backend, re-checks unsettled work after its last await
  and disposes the old supervisor before the new one reads the journal. Bindings are stored per
  device with the machine credential; the kernel names as previous the last binding it committed for
  the machine, so a lost answer, a re-login or a shared state directory no longer deadlocks the
  chain. Old binding records are pruned; the environment fingerprint covers every module the Python
  helpers import.
- e366658: Staged instance binding (fix round 2): a binding compares the environment fingerprint with the
  device's latest installed binding, so an environment change across a generation whose answer was
  lost still resets Full consent; a binding committed before a re-login follows the active machine
  before it is sent. The bundled device runtime carries the Apache-2.0 modification notice of the
  patched sandbox runtime and refuses optional or platform-specific packages.
- Complete dormant managed output transport with strict positional ranges, authenticated connection capacity negotiation, and original admitted execution grant provenance. Protocol 2 remains active pending the coordinated runtime cutover.
- 28ff1e5: Owner report fixes: a late, lower-sequence report from a policy frame, answer, status or bind
  answer is ignored instead of blocking the device (only a hello regression or a conflict blocks);
  unblocking with the same Full permission resets no consent; every carrier records its connection.
  The cloud owner-ceiling PATCH is refused until the device's permissions are migrated, and widening
  also checks the provider. Platform, org and publication Full-off writers revoke running restricted
  work outside the machine's roots; working roots outside the workspace follow the project reach.
  `capybara-device login` resets the owner-report sequence; `ceiling set` decides widening under the
  policy lock; `ceiling show` and `mode` explain the project reach on the current protocol.
- d174573: Retain managed macOS background output in an exact-reference private spool and a separate ordinary artifact, with bounded positional reads, durable checkpoints, explicit output credit, and sticky collector-failure cancellation.
  
  Preserve immutable read snapshots, exact cancellation ownership, conservative journal recovery after failed publication, and the restricted worker's artifact write exclusions.
  
  Require durable final journal decisions before acknowledgment and independently validate and finalize indeterminate commits during recovery, preserving sticky faults and cancellation tombstones.
  
  Merge cancellation evidence monotonically and keep owned stop/revocation and failure-credit release independent of blocked journal and deferred fault-control writes.
- 3ef9ae9: Stage graceful drain for the protocol-3 session: a draining device refuses new admissions but keeps
  serving exact status, output reads, tails, stops, revocation and retries of already admitted
  operations. The drain finishes only when in-flight requests and everything the supervisor owns
  (acknowledged tasks whose start request already answered, output collectors, pending exact
  cancellations and deferred persistence) have settled; a timed-out drain reports what is pending and
  the device is not reused. The owner watcher now also stays on while an exact cancellation settles.
  Protocol 2 is unchanged.

## 0.1.0-rc.13

### Patch Changes

- fb9afe0: Carry current mode ceilings on local stat and readFile requests so project context loads before
  any command and reads cannot inherit a stale wider command decision. Device protocol v2 requires
  a matching kernel and device upgrade; existing credentials and device files remain valid.
- Updated dependencies [5408b24]
- Updated dependencies [fb9afe0]
- Updated dependencies [5408b24]
- Updated dependencies [5408b24]
  - @capybara-hq/plugin-sdk@0.1.0-rc.25

## 0.1.0-rc.12

### Minor Changes

- 19506a3: The device answers `list` (one directory's entries) and `scan` (directories holding `.git` or
  `AGENTS.md`, at most two levels down) so the deployment can offer a device's projects, announces the
  `projects` feature, and reports the owner's home in its hello. Each request is read in the mode it
  would run in now (the owner's choice cut to the ceiling the request carries): auto mode reads with
  the owner's rights, sandbox mode reads only the workspace through the sandboxed helper (killed with
  its process group when the request is cancelled, even while it is still being spawned), and a
  docker-mode device reads only its container's workspace. A scan reads at most 500 directories, skips
  hidden directories and the SDK's `DEVICE_SCAN_SKIPPED_DIRS` / `DEVICE_SCAN_SKIPPED_BASE_DIRS`, and
  follows no symbolic links. Both work while the device directory is gone (null / `[]`), and neither
  recreates a removed workspace, so a lost workspace stays gone. The device keeps no project list of
  its own.

### Patch Changes

- Updated dependencies [ed795c4]
  - @capybara-hq/plugin-sdk@0.1.0-rc.24

## 0.1.0-rc.11

### Patch Changes

- 58a1594: The login service tells the truth. Exit 0 now means a deliberate stop (logout, a revoked
  credential, drain, not logged in) and the macOS agent restarts only failing exits (`KeepAlive {
  SuccessfulExit: false }`); a deployment that needs a newer program (426) exits 1, so an upgrade in
  place recovers. `stop` refuses only when the service runs the program it would signal, `service
  start` refuses next to a terminal program, and a pid file is trusted only when `ps` shows this
  program started before it. `service status` separates not installed, not loaded, exited (see
  `service.log`) and running, and compares with the package the service file runs; `service
  stop|restart` report a service that stayed loaded or did not come back. The policy summary reports
  the owner's mode, file operations without the OS sandbox wait for a fresh command decision, and
  `login` checks the OS sandbox before writing a sandbox policy and words its lines for Docker.

## 0.1.0-rc.10

### Minor Changes

- 529b01e: `capybara-device service start|stop|restart` control the login service without knowing launchctl or
  systemctl, and `service status` now names the version the running program uses: when it is older
  than the installed package (a daemon left over from before an upgrade) the third line says
  `installed <v> — restart it: capybara-device service restart`. `stop` unloads the service instead of
  signalling a program the restart policy would bring back, so the top-level `stop` now refuses while
  a login service is installed. The pid file records the running version (`{pid, version,
  startedAt}`); one written by an older program reads as version unknown.

## 0.1.0-rc.9

### Minor Changes

- f3c29f5: Auto mode: a device runs commands in one of two modes, `auto` (the default for a new login when the
  organization allows it: as the owner, with every command reviewed by the deployment; a fresh login
  in an auto-forbidden organization writes sandbox mode) or `sandbox` (today's strict
  `sandbox-runtime` profile). `capybara-device mode [auto|sandbox]` shows or switches it; `policy`
  loses `set tier|isolation|localhost|remoteGrants` and keeps `show` and the allowlist commands;
  `status` prints the mode. In auto mode file operations reach any absolute path on the machine. A
  legacy `policy.json` (`isolation: none` or `tier: open`) migrates to auto, anything else to
  sandbox, and `start` says so once. The policy op may only narrow to `sandbox`; a deployment may
  never turn auto mode on. When the OS sandbox is unavailable the device still serves auto mode, and
  sandbox mode refuses every command with the reason (and refuses the `mode sandbox` switch) instead
  of running unsandboxed.

### Patch Changes

- Updated dependencies [caa4575]
  - @capybara-hq/plugin-sdk@0.1.0-rc.22

## 0.1.0-rc.8

### Patch Changes

- f77f60c: A restarted kernel or web no longer leaves the device offline until someone bootstraps the login
  service by hand. The macOS launch agent now uses unconditional `KeepAlive` with a 30 s
  `ThrottleInterval`, so a clean exit restarts the program instead of leaving the agent down. The
  reconnect loop backs off exponentially with jitter, capped at 60 s, never gives up on a connection
  failure, resets after a connection stays up, and reports each distinct failure once instead of
  every attempt (the same failure at most once a minute). `capybara-device service install` boots an
  existing agent out before writing the new plist and bootstraps it afterwards, so a reinstall picks
  up the new file; `capybara-device service status` reports whether the agent is loaded and the
  program running.
- Updated dependencies [f78281b]
  - @capybara-hq/plugin-sdk@0.1.0-rc.21

## 0.1.0-rc.7

### Minor Changes

- 76828c0: Device policy ops carry an op id. The device protocol's `policy` op now requires `opId` (non-empty,
  no `:`, at most 128 characters); the new `policyStatus` op asks a device what became of an op id
  (`applied`, `refused`, `started` or `unknown`, with its policy summary now); a hello may carry
  `recentOps`, the outcomes of the latest 100 policy ops; the new feature `policyOpId` announces all
  three. `capybara-device` logs each policy op in `policy-ops.json` next to `policy.json` (`started`
  before the change, then `applied` or `refused`; the last 100 kept), answers a repeated op id from
  that log without applying it again, and reports the log in every hello. The kernel sends its op id
  with each `policy` op.
  
  The SDK's hello parser keeps one `recentOps` entry per op id (the last one listed). `capybara-device`
  keeps a refusal's message in the log cut to 500 characters, never logs an applied op as refused
  when releasing the policy lock fails after the write, and keeps an op the log already says was
  applied as applied.

### Patch Changes

- a6d073a: A background task on macOS keeps its launch's network permissions until its process group ends; it lost them (proxy 403) as soon as the launch returned.
- Updated dependencies [76828c0]
  - @capybara-hq/plugin-sdk@0.1.0-rc.20

## 0.1.0-rc.6

### Patch Changes

- d3f5836: At tiers `dev` and `open`, sandboxed commands may write `.git/config`, so `git init`, `clone`,
  `config` and `remote add` work in OS mode. `.git/hooks` stays unwritable at every tier (now also
  when the program runs from a directory that does not contain the device's roots), init and clone
  use an empty template, and `strict` keeps `.git/config` unwritable.
- 873dc2c: Sandboxed commands no longer get `npm_config_store_dir`, which made every npm command warn
  `Unknown env config "store-dir"`; pnpm 10 has no other variable for its store, so it stays at
  pnpm's default under the command's HOME.
- 67e6ad5: A local OS-sandboxed device now kills what a foreground command leaves running (`server &`,
  `nohup …`) when the command ends, by its process group and by a per-command marker for processes
  that left the group. Inside the sandbox no later command could signal them, so they leaked. A
  background task launch, whose command starts with the new `BACKGROUND_LAUNCH_LINE`
  (`@capybara-hq/plugin-sdk`), keeps what it starts. The `Bash` description tells the model to use
  `run_in_background` for servers and watchers.
- cb0be5f: `capybara-device service install` on macOS waits until `launchctl bootout` has really removed the
  old agent before `bootstrap`, and retries a bootstrap that fails with error 5 (Input/output error),
  with a clear message when it keeps failing. On Linux a reinstall restarts the unit. `drain --wait
  [--timeout <seconds>]` returns once the program has exited.
- Updated dependencies [67e6ad5]
- Updated dependencies [e76028b]
  - @capybara-hq/plugin-sdk@0.1.0-rc.18

## 0.1.0-rc.5

### Patch Changes

- 8471657: A local policy change made on the machine (`capybara-device policy ...` while the service runs, a
  flipped localhost proxy guard, a new tier ceiling) reaches the deployment at once: the device
  pushes its new summary in a `policy` frame (new in the device protocol), and the kernel stores it
  as it stores the hello's, so the device page and the next `device_paths` line show it.
- 204a7ed: Version managers work inside the OS sandbox: asdf, nvm, pyenv, rbenv, mise, volta, sdkman and
  rustup get their data directories under the real home (read only) instead of the workspace HOME.
- Updated dependencies [8471657]
- Updated dependencies [a3ca5ef]
  - @capybara-hq/plugin-sdk@0.1.0-rc.17

## 0.1.0-rc.4

### Minor Changes

- 99d2fe8: Sandbox tiers in OS and Docker mode. A command runs at the device's tier (`policy set tier
  strict|dev|open|default`) cut to the organization's ceiling: `dev` adds the dev hosts preset to
  the network, package caches under `<dir>/cache/`, and on macOS local servers (unless a local
  forwarding proxy is detected; `policy set localhost allow` overrides) and unix sockets under the
  device's directories and a short socket directory that `TMPDIR` and `MAC_CHROMIUM_TMPDIR` point
  at; `open` reaches anything the organization allows and needs `--yes`. A tier change reaches the
  sandbox at the next command. Docker mode sizes `/dev/shm` per tier and opens the bridge only for
  explicit local domains or tier `open`. The proxy guard runs again every 30 seconds (before the next
  command) and, on macOS, counts a check that fails as a proxy found. A local tier change turns the
  sandbox back on for a device set to run without one. `policy show` says what the tier gives on this machine, and
  `start` prints a notice for a legacy `network: "open"`.
- 579b956: Accept owner-approved network changes from the deployment. `policy.json` gains `network`
  (`allowlist` default, or `open`: commands reach what the organization allows) and `remoteGrants`
  (`owner` default, or `off`: the device refuses every widening from the deployment). The new `policy`
  operation adds or removes allowed domains and switches `network` (narrowing always accepted, every
  host validated, written under the lock); a run's or task's granted hosts join a command's list
  within the organization's egress. In OS mode exec results report the refused hosts; the hello
  announces `networkReport` / `policyOp` and a summary of the local policy. The local command log
  records each change from the deployment, refused attempts and each command's grants. A
  Docker-mode device refuses widening from the deployment (it cannot limit single domains).
- 6cd651b: `capybara-device policy set network open` turns off the device's own network limit (commands
  reach what the organization allows) after printing the risk: it needs `--yes`, or an answer of `y`
  on a terminal; without a terminal and without `--yes` it exits with status 2 and a hint.
  `set network allowlist` is always accepted. `policy set remoteGrants owner|off` decides whether
  the device owner may widen the network from the deployment.
- 8fa0e32: `policy.json` replaces `network` with `tier` (absent = the organization's default), `isolation`
  (`sandbox` by default) and `localhost` (`auto` by default). The old keys `network`,
  `allowLocalBinding` and `allowUnixSockets` are ignored and dropped on the next write; a policy with
  tier `open` behaves as the old `network: "open"`, every other tier as before.
- 5d6f865: A device in OS mode runs commands without a sandbox when its owner sets it on the machine
  (`capybara-device policy set isolation none`, with tier `open`; the risk text is shown and needs
  `--yes` or a `y` at the prompt). Below tier `open`, or when the deployment does not allow the
  command to run unsandboxed (`limits.allowUnsandboxed` not `true`), such a device refuses commands,
  naming why; a command whose sandbox is turned back on while it starts is refused too, and an
  invalid `policy.json` turns the sandbox back on. The
  deployment can never turn the sandbox off: the `policy` op accepts only `isolation: "sandbox"`, and
  a higher tier only under `remoteGrants: "owner"`. The hello announces the `tiers` feature, the
  policy summary reports the tier the device runs at, and the local command log records each
  command's tier and isolation.

### Patch Changes

- 4ce2efa: Explain blocked network access: in OS mode a refused domain gets a reason from the proxy, and each
  command's stderr ends with a trailer naming every refused host and the layer that refused it (this
  device's allowed domains, the organization's allowlist, or a private address). Local policy changes
  apply at the next command without a restart (an invalid `policy.json` keeps the last valid policy),
  writes take `policy.json.lock`, and `capybara-device policy add|remove allowedDomains <host>` edits
  the list one host at a time.
- Updated dependencies [2682d5f]
- Updated dependencies [2e52ca1]
- Updated dependencies [8fa0e32]
- Updated dependencies [95fc4b0]
  - @capybara-hq/plugin-sdk@0.1.0-rc.16

## 0.1.0-rc.3

### Patch Changes

- 7f14dc0: After `capybara-device login`, say to run `capybara-device start` (or `service install`) to bring
  the device online; the upgrade message names the `next` dist-tag before 0.1.0.

## 0.1.0-rc.2

### Patch Changes

- ec79610: One name: devices. The program says device everywhere: `credential.json` holds `deviceId` (a file
  from an older version is unusable: run `capybara-device logout` and log in again), the default
  directory is `~/capybara-device/<deviceId>`, the sign-in follows the kernel's `device_sign_in.*`
  error codes, and `status` prints `device`. SDK doc comments say device instead of environment.
- Updated dependencies [ec79610]
- Updated dependencies [d495d7d]
- Updated dependencies [18defa0]
- Updated dependencies [0a35407]
- Updated dependencies [cf93278]
- Updated dependencies [199f895]
  - @capybara-hq/plugin-sdk@0.1.0-rc.9

## 0.1.0-rc.1

### Minor Changes

- 812318c: New package `@capybara-hq/device`: the `capybara-device` program with `login`, `logout`, `status`, `start`, `stop`, `drain` and `policy`: the connection to the deployment, operation dispatch, results kept across reconnects, a local command log, and the OS sandbox mode (every command inside `@anthropic-ai/sandbox-runtime`: writes only under the environment directory, secret paths unreadable, network limited to the local policy intersected with the environment's egress). The plugin-tools dependency check can hold a package to the plugin-sdk-only boundary (`deviceDirs`).

### Patch Changes

- 616cc33: `capybara-device` gains Docker mode (commands run with `docker exec` in one container per environment from the published sandbox image, the environment directory mounted at `/workspace`, `/skills` and `/tmp`; no network unless the effective egress allows some, with no domain allowlist) and `service install|uninstall` (a launchd agent on macOS, a systemd user unit on Linux).
- Updated dependencies [c505b45]
- Updated dependencies [ebbfeb5]
  - @capybara-hq/plugin-sdk@0.1.0-rc.6
