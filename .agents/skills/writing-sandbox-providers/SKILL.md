---
name: writing-sandbox-providers
description: 'Use when changing the kernel side of sandbox@2 or anything that drives a sandbox from the kernel: the contract as the kernel relies on it (devices, file system versus instance lifecycle, FileSystemGoneError, abort, SandboxGoneError versus ordinary errors, auto-start, in-sandbox time limits, killAll / killTagged, required concurrentExec, exec tags and actor, optional image, same-name replacement), effective org limits, egress and tiers (sandboxLimitOverrides, sandboxEgress, update, limitsApplyAt), the SandboxService lifecycle keyed by device id (shared and exclusive leases, intent, holder records, path leases, maxConcurrentCommands, TTL, lockWaitSeconds, fencing generation, idle suspension, maxRunning, inactivity destruction of the instance, rebuild and notices, devices-legacy-cleanup), the socket proxy config and compose sandbox profile core ships, and kernel tests on the sandbox-fake fixture. To write a sandbox extension (sandbox-docker, sandbox-e2b) see writing-sandbox-providers in capybara-hq/plugins.'
---

# Sandboxes: the kernel side of `sandbox@2`

Work happens in **devices** (spec `docs/superpowers/specs/2026-11-07-environments-design.md`): a device is one instance plus a file system, shared by all
conversations bound to it (and their sub-agents). Instances are disposable, files are not: suspension and destruction act on the instance, and the files stay until the
device is deleted. The kernel's sandbox tools (`Bash` / `Read` / `Write` / `Edit` / `Glob` / `Grep` / `Deliver`),
attachment sync and `Skill` all use it through `SandboxService`. `sandbox@2` is a **single-choice, brokered** extension point: a deployment installs only one sandbox extension,
and other extensions cannot `requires` it. For the extension host see `.agents/skills/writing-extensions`; for the tools side see `.agents/skills/writing-tools`.

This skill covers what core owns: the contract as the kernel relies on it, `SandboxService` (leases, fencing, suspension, destruction), the builtin sandbox tools (`Bash`, `Read`, `Write`, `Edit`, `Glob`, `Grep`, `Deliver`),
the socket proxy config and compose sandbox profile, and the kernel tests on the `sandbox-fake` fixture. **Writing a sandbox extension** (its code, README, Docker / E2B
specifics and tests) is in [writing-sandbox-providers in capybara-hq/plugins](https://github.com/capybara-hq/plugins/tree/main/.agents/skills/writing-sandbox-providers).

Implementations:

- `packages/kernel/test/fixtures/plugins/sandbox-fake`: the minimal shape (a local directory + `/bin/sh`, **no isolation, for tests only**); every kernel sandbox test runs on it.
- The official [`sandbox-docker`](https://github.com/capybara-hq/plugins/tree/main/plugins/sandbox-docker) (one container per device, runc or gVisor's runsc, Docker only through
  a socket proxy, an egress proxy container per instance) and [`sandbox-e2b`](https://github.com/capybara-hq/plugins/tree/main/plugins/sandbox-e2b) (E2B cloud or self-hosted)
  plugins in capybara-hq/plugins; their READMEs list every platform trade-off.

## Contract: `sandbox@2` (`packages/plugin-sdk/src/sandbox.ts`)

`@2` replaces `@1` with no overlap (no compatibility before 0.1.0): a kernel refuses to load a provider still on `@1`. A change here is an SDK change (API snapshot +
changeset) and must keep the official providers working; check them in capybara-hq/plugins.

```ts
interface SandboxProvider {
  createFileSystem({ name, limits, signal }): Promise<FileSystemHandle>;  // name = cap-device-<deviceId>
  destroyFileSystem(fs, signal): Promise<void>;          // not being there counts as success
  destroyFileSystemByName(name, signal): Promise<void>;  // no handle: a crash mid-create, the legacy cleanup
  create({ name, image?, limits, fileSystem, signal }): Promise<SandboxHandle>;  // an instance attached to the file system
  resume(h, signal): Promise<"resumed" | "gone">;
  suspend(h, signal): Promise<void>;          // files must be kept; an instance that is not there also counts as success
  destroy(h, signal): Promise<void>;          // the instance only, never the file system; not being there counts as success
  destroyByName(name, signal): Promise<void>; // the instance only
  killAll(h, signal): Promise<void>;
  readonly concurrentExec: true;              // required: exec / readFile / writeFile / stat run concurrently on one instance
  killTagged(h, tags, signal): Promise<void>; // required: kill only the exec commands labelled with one of tags
  exec(h, { command, cwd?, env?, timeoutMs, maxOutputBytes, signal, tag, actor }): Promise<ExecResult>;  // actor = { accountId, conversationId, runId? }
  // ExecResult.network?.blocked (optional): hosts the provider's egress refused, with the layer; the kernel
  // recomputes the org layer and may ask the device owner (network ask-to-allow spec §4)
  readFile(h, path, { maxBytes, signal }): Promise<{ data; truncated } | null>;  // missing or a directory → null
  writeFile(h, path, data, signal): Promise<void>;                               // parent directories are created automatically
  stat(h, path, signal): Promise<{ size; isDir } | null>;
}
```

Instance name: `cap-device-<deviceId>` for both the file system and the instance. Old per-conversation instances (`cap-<conversationId>`) are removed by the one-off
job `devices-legacy-cleanup`, which calls `destroyByName` and `destroyFileSystemByName` on every `sandboxes` row (see Lifecycle).

### File system versus instance

- The **file system** is the device's files (a volume, a template's persistent disk) and lives until the device is deleted. The **instance** is the process
  host attached to it: it is suspended when idle, destroyed after long disuse (`destroyAfterInactiveDays`), and recreated on the next use with the same files.
  `destroy` / `destroyByName` therefore never touch the file system; only `destroyFileSystem` / `destroyFileSystemByName` do.
- `create` with a file system that is gone throws **`FileSystemGoneError`** (duck-typed like `SandboxGoneError`; use `isFileSystemGoneError`) instead of making an empty one.
  A Docker provider must check that the volumes exist before mounting them, because Docker would otherwise create empty ones. The kernel reports it to the model and
  the device page rather than silently rebuilding: the files are lost.
- `image` is optional; without it the provider uses its own published image. The kernel passes one only when a device pins a custom image.
- `exec` carries `actor: { accountId, conversationId }` for audit and attribution; providers record it and must not use it for anything else in phase 1.

`glob` / `grep` / `edit` are composed by the kernel from `exec` + `readFile` / `writeFile`; the provider does not implement them. So the image must have GNU `find`
(`-print0`) and `grep` (`-rnHIE`, `--include`), `timeout`, `setsid`, `pkill` / `pgrep`.

### Semantics the kernel relies on

Every provider must follow these; the kernel's behaviour below assumes them. How the official providers implement each one is in the plugins repository's skill.

- **Abort**: every method responds to `signal` promptly. Already aborted at call time → reject immediately; aborted in flight → end as soon as possible with the abort reason.
  The kernel relies on this to stop when the lock is lost, the run is aborted or times out; without it, you may operate on the same instance at the same time as a new lock holder.
  **An aborted `exec` must kill the command and its child processes**, not merely stop waiting for output; an `exec` aborted after the command has started resolves normally with
  `{ exitCode: null, timedOut: false }` (with the output collected so far) and does not reject. A timeout resolves `timedOut: true, exitCode: null`.
- **gone versus ordinary errors**: when the instance is **definitely** no longer there on the provider's side (container deleted, E2B sandbox expired), `exec` / `readFile` /
  `writeFile` / `stat` / `killAll` throw `SandboxGoneError` and `resume` returns `"gone"`. The kernel then recreates the instance on the same file system and retries once; the model sees a recreated notice (processes are gone, files are kept).
  Losing the file system is a different error, `FileSystemGoneError` (above). If the instance is only temporarily unreachable (401, 5xx, network errors, a bare 404 returned by a proxy),
  throw an **ordinary error**; otherwise one network blip wipes the user's files. Use `isSandboxGoneError` to decide (duck-typed, compatible with an extension bundling its own copy of the SDK).
  Throw network errors as they come (node's `code` / `syscall`, or wrapped as `cause` / `AggregateError.errors`, as `fetch` does): `SandboxProviders`
  hands every provider out through `guardProviderConnection` (`sandbox/unreachable.ts`), which rethrows a connection failure (`ECONNREFUSED`,
  `ENOTFOUND`, any `connect` / `getaddrinfo` error → never connected; `ECONNRESET`, `ETIMEDOUT`, `EPIPE`, socket hang up → dropped) as
  `SandboxProviderUnreachableError` with the raw error as `cause`; the sandbox tools give it a fixed text. Never write model-visible text in a provider.
  E2B treats only E2B-format 404s (`{code: 404, …}`) as gone; failing to obtain the envd access token is also reported as gone (better to rebuild than to send a request without the token).
- **Auto-start**: when the instance still exists but is stopped / paused (host or daemon restart, the suspension sweep stopped it before it could record `suspended`, someone ran
  `docker pause`), `exec` / `readFile` / `writeFile` / `stat` / `killAll` first start it the way `resume` does and then proceed,
  without reporting an error. The kernel trusts only the `running` it recorded itself.
- **Command time limit inside the sandbox**: besides stopping the command on the provider side at `timeoutMs`, the command itself must run inside the sandbox through
  `timeout -s KILL <timeoutMs + a few seconds>`. When a kernel replica crashes, the provider-side timer disappears with it, and disconnecting does not end the command;
  this limit guarantees it cannot run indefinitely in parallel with the next lock holder's commands.
- **killAll**: kill every command started through `exec` that is still running (SIGKILL by process group and session); processes moved to the background in a new session are not guaranteed.
  The kernel calls it only where no other holder (any session of the device) can be running a command (see "Takeover per holder" below): under the exclusive lease,
  before the downgrade, right after recovering from `suspended` (an E2B pause preserves processes too). Crashed holders are killed by tag, never with `killAll`. When the exec that kills processes cannot even start (process table exhausted),
  Docker falls back to `restart?t=0` and E2B falls back to pause + a `connect {memory: false}` cold start, which also end live siblings' commands; both log a
  warn and the call returns normally.
- **Concurrent use (`concurrentExec`, `killTagged`, `tag`; both required)**: all sessions of a device and their sub-agents share one instance, so the kernel calls
  `exec` / `readFile` / `writeFile` / `stat` concurrently on it. Those methods must be safe
  concurrently, and **auto-start must be idempotent under concurrent calls** (two calls that both find the instance stopped both start it without failing:
  Docker's `start` on a running container answers 304, E2B `connect` on a running sandbox only extends its timeout). Every `exec` gets the holder's `tag`
  (`SANDBOX_TAG_RE`, `^[a-z0-9-]{1,64}$`, checked by the provider before it goes near a command line): label the command with it (the official providers name
  the control file `/tmp/.capybara-exec-<tag>-<uuid>`), and implement `killTagged(h, tags)` to kill only those commands' process trees, matching the
  whole tag: `capybara-exec /tmp/[.]capybara-exec-<tag>-<uuid>( |$)` with the UUID's exact shape, because a tag may be a prefix of another (`ab` of `ab-cd`;
  the kernel's tags are UUIDs, but the contract allows any `SANDBOX_TAG_RE` tag). An aborted or timed-out `exec` still kills only its own command. A provider that does not declare `concurrentExec: true` and implement `killTagged` fails to load. Concurrent commands share the sandbox's pids and memory limits; say so in the README.
- **Same-name replacement**: `create` first deletes an old instance of the same name (never its file system) and then builds (the kernel may exit after the provider has built it but before it has recorded the handle). Likewise
  `createFileSystem` replaces nothing: it must fail or return the existing one if the name exists, and `destroyByName` / `destroyFileSystemByName` clean up by `cap-device-<deviceId>` when the kernel has no handle (device deletion, test cleanup).
- **Output**: `maxOutputBytes` is the **combined** limit on stdout + stderr; excess is discarded and `truncated` is set; truncation backs off to a full UTF-8 character boundary.
- **`/skills` is read-only**: mounted read-only for the sandbox user (or owned by root with 0755), and `writeFile("/skills/…")` is written by the provider as root,
  and must not be redirected elsewhere by a symlink the sandbox user places. The kernel's `/skills` write protection judges only the path string and can be bypassed by symlinks; the real
  defense is in the provider. Skill files have no executable bit, and `Skill` tells the model to run them with an interpreter (`sh /skills/x/run.sh`).
- **File operations resolve as the sandbox user**: permissions and symlinks are resolved as the non-root user, never as root through the daemon.
- Paths have already passed `validateSandboxPath` (only `/workspace`, `/skills`, `/tmp` are accepted); the working directory is `/workspace` and attachments are in
  `/workspace/attachments/<conversation>/` (the first 12 hex digits of the root conversation id).
- **Background tasks** (`Bash` `run_in_background`, spec `docs/superpowers/specs/2026-11-05-background-bash-design.md` §4; no contract
  change): the kernel launches a task with one short `exec` (`cwd: /workspace`, relative paths `.capybara/tasks/<id>.*`) that runs
  `setsid nohup sh -c 'timeout -s KILL <s> bash <id>.sh; echo $? > <id>.exit'` in the background and prints the session id; liveness is
  `pgrep -s <sid>`, stopping is `pkill -TERM|-KILL -s <sid>`. So the sandbox needs `sh`, `bash`, `setsid`, `nohup`, `timeout`, `pkill -s`,
  `pgrep -s` and `base64` (a provider without them fails the launch with a readable error), and `exec` must return once its own process and stdio end,
  without waiting for a detached session. The exec wrapper's abort, timeout, `killTagged` and `killAll` don't reach a task, and a task holds
  no lease while it runs. Tasks don't survive a Docker suspend or a rebuild (the poll marks them `lost`); a task marked lost while its
  process may live on (an E2B pause keeps processes) is `kill_pending`, and `SandboxService` kills those sessions right after resuming that
  instance, under the exclusive lease next to its `killAll`. The poll and `TaskOutput` / `TaskStop` use `SandboxService.ifRunning`: a shared
  lease only on a `running` row of the task's instance, never creating or resuming one. sandbox-fake puts node shims for `setsid`,
  `timeout`, `pkill -s` and `pgrep -s` first on its PATH (macOS has none) and kills an instance's processes on `suspend` and `destroy`.

### Limits and egress (`SandboxLimits`)

- `tier` (`strict` < `dev` < `open`, spec `docs/superpowers/specs/2026-11-12-sandbox-dev-tiers-design.md`) is the device's **effective** tier: the lowest of the
  device's own tier (`devices.tier`, null = the org default), the org ceiling (`sandboxTier.max`) and the platform ceiling (`sandbox.tiers.max`); unattended runs are
  capped at `dev` without a `tier:open` task grant. One function computes it: kernel `sandbox/tiers.ts` `effectiveSandboxPolicy`. Only a person widens a tier
  (org settings over the session, the device owner on the device page); the Platform op and PATs only narrow. `devHosts` is for local exec args only; cloud
  providers treat `allowHosts` as final.
- `egress` / `allowHosts` are the values **in effect for the org**: the org setting `sandboxEgress` can replace the allowlist with its own or cut the network,
  and cannot be more open than the deployment (Ruling M19). `egress: "none"` cuts the network in every tier. There is no deployment `egress: "open"` any more:
  open egress is the `open` tier. The provider just enforces the `limits` it receives and does not read org settings.
- `cpu` / `memoryMb` are likewise the values **in effect for the org**: a super admin can override them per org in the admin console (deployment setting `sandboxLimitOverrides`,
  orgId → `{ cpu?, memoryMb? }`, cpu 0.25–64, memoryMb an integer in 256–262144, C19); the items given replace the deployment defaults of `sandbox.limits`, and items not given and `diskMb` keep the deployment defaults (kernel `effectiveSandboxLimits`); org admins see the effective values and their source read-only in org settings.
  The provider just enforces the `limits` it receives from `create`; a provider that cannot size each sandbox (such as E2B, where the template decides the size) must state in its README
  "org-level cpu / memory overrides do not take effect for this plugin"; a deployer who needs different sizes uses different templates.
- **Tier and egress mode follow running instances; the rest applies at create.** The kernel records the `{ tier, egress }` an instance was created with
  (`device_instances.instance_limits`; NULL reads as `strict` with an unknown egress, so it differs once after the upgrade). On use, when the effective tier or
  egress mode differs, it calls the optional `update(h, limits, signal)` under the exclusive lease: `"updated"` records the new limits; `"recreate"`, a gone
  instance, or a provider without `update` destroys and recreates the instance on the same files (the existing "recreated" notice). A non-gone `update` failure
  recreates on instance-bound providers; after an abort, or on a provider with `limitsApplyAt: "fileSystem"` (E2B: the instance is its file system), the instance
  is quarantined (suspended or killed) and the error rethrown. A `"fileSystem"` provider without a successful `update` keeps the old record, and the device view
  says `pendingFilesReset` (「重置文件后生效」): the record never claims more than is in force. Changes of `allowHosts`, `cpu`, `memoryMb` still reach only
  instances created afterwards, and `diskMb` only file systems created afterwards. When an item cannot be done, say so in the README (Docker's default local
  volume driver does not limit `diskMb`; E2B's cpu / memory / disk are decided by the template).
- `egress` and `tier` together:
  - `none`: loopback only, whatever the tier.
  - `allowlist` (default): allow only `allowHosts` (`validateAllowHost` already rejects IP literals, single-label names and `.local` / `.internal`;
    `*.example.com` matches subdomains and not the domain itself). `strict` keeps HTTP(S) on 443 / 80; `dev` allows any port to those hosts (sandbox-docker adds
    SOCKS5 on the egress proxy and a larger `/dev/shm`).
  - `open` tier: any public host. The provider's deployment config `openEgress: "off" | "proxy" | "direct"` (default `"proxy"`; it replaced `allowOpenEgress`)
    decides how: `off` refuses a `create` or `update` that asks for open with an English error; `proxy` goes through the provider's egress proxy, which still
    refuses private, loopback, link-local and metadata addresses; `direct` attaches the shared bridge and reaches the host and the intranet (trusted deployments
    only). The kernel warns at start when `sandbox.tiers.max` is `open` while the provider is `off`.
- **The allowlist does not prevent data exfiltration**: it blocks the internal network and hosts outside the allowlist, but not data sent to allowlisted hosts (`git push` to github.com, publishing packages).
  The README must say so and recommend `sandboxToolPolicy: ask` and / or `sandboxEgress: none` for sensitive orgs.
- A provider that cannot allow by domain name must **refuse, or degrade to `none` with a warning**, and must never silently open up (E2B self-hosted `domainAllowlist: false`).
  Where it can but more weakly, write it in the README (E2B looks only at Host / SNI and does not verify the destination IP, Ruling M14).

## The kernel-internal provider `@local` (local devices)

Local devices (spec §6, §13 and §15) run on a person's machine, driven through a program that
connects to the gateway. Their provider is `@local`, registered by the kernel itself
(`packages/kernel/src/sandbox/providers.ts`, `packages/kernel/src/local-devices`); it is not an extension and
no plugin can take the name.

- **Per-device resolution.** The provider is chosen by the device's row
  (`devices.provider`), not by the deployment's one sandbox extension, so cloud and local
  devices coexist. Handle ids are the device id (parsed from `cap-device-<deviceId>`).
- **Relay.** Calls become requests on `capk:device-req:<deviceId>` and results come back under
  `capk:device-res:<requestId>`; no holder means `device.offline` at once. See
  `packages/kernel/src/local-devices` and spec §13.4. The handle carries the org's limits from `create`; a
  handle without them answers `SandboxGoneError`, which rebuilds the instance.
- **Offline-safe destroys.** `destroy`, `destroyByName`, `destroyFileSystem` and
  `destroyFileSystemByName` never fail because the machine is away (a stop is relayed only when it is
  online and is fire-and-forget). Files on the machine are never removed.
- **Never swept.** Idle suspension, `maxRunning` eviction and inactivity destruction skip `@local`;
  the only sweep that includes its rows is the gone-sweep for a deleted org or device.
- **Roots and real paths.** `SandboxHandle.roots` (`{ workspace, skills, tmp }`, absolute paths in the
  instance) is optional; absent means `SANDBOX_ROOTS`. A device reports its roots in `hello`. Every
  kernel tool, attachment copy, skill file and background task builds paths from the **held
  instance's roots**, never from constants, and tool descriptions never name `/workspace` ("the
  workspace directory"). Root-independent path checks run before entering the instance
  (`validateSandboxPathShape`). Each conversation records an `device_paths` event on its first
  sandbox call and whenever the roots change, including back to the defaults; it is in the log, so it
  needs no `DriftReason`. A new tool must use the roots too.

## Lifecycle: `SandboxService` (`packages/kernel/src/sandbox/sandbox.service.ts`)

The kernel owns it; the extension implements only primitives. **Do not do scheduling, timing or state tables in the extension**:

- **State** lives in the device's row (instance status `creating` / `running` / `suspended` / `destroyed`, instance handle, file system handle, owning provider), keyed by
  **device id**, never by conversation. The file system is created with the device; the instance is created lazily on the first sandbox tool call of any session.
  The old `sandboxes` table is no longer used (a later migration drops it).
- **Leases** (phase C, `packages/kernel/src/sandbox/leases.ts`, spec `docs/superpowers/specs/2026-10-26-subagents-design.md` §10): using a sandbox recorded
  `running` takes a **shared** lease (up to `sandbox.maxConcurrentCommands`, default 6, hot, shared by all sessions of the device):
  every sandbox tool, attachment sync, `Skill` copies. Every lifecycle change (create instance, first use, rebuild after `gone`, `resume`, provider switch,
  `suspend`, `destroy`, `killAll` after resume) takes the **exclusive** lease, alone. Keys: `capk:sandbox:<env>` (the lock key: an exclusive token or the literal `shared`), `capk:sandbox-users:<env>` (zset of shared tokens by expiry), `capk:sandbox-intent:<env>`
  (an exclusive waiter's intent: new shared leases wait, writer preference), `capk:sandbox-holders:<env>` (holder records), `capk:sandbox-path:<env>:<sha256>`.
  Every key carries a TTL, never shortened by a holder for a TTL another holder set: the lease keys (`capk:sandbox:<env>`, `capk:sandbox-users:<env>`)
  60 s (`SANDBOX_LOCK_TTL_MS`; the lease is a `LockService` shared lease, `tryShared` / `tryExclusive` in `infra/lock`, renewed every TTL/3 and lost at
  the deadline of decision R19 of the Nest kernel spec: send time of the last successful renewal + 2/3 TTL, which aborts that holder's signal); the holder records
  `sandbox.limits.maxCommandSeconds` + 10 min; the intent max(4 × poll, 2 s); a path lease 30 s (renewed); the seen key
  below `destroyAfterInactiveDays` + 1 day. A caller loops: sandbox `running` → one try at a shared lease; otherwise one try at the exclusive lease with
  intent (same token, so it can switch to shared under its own intent once someone else made the sandbox run); the exclusive holder makes it run and
  **downgrades** to a shared lease to run its own command (always release the view `downgrade` returned; any view's `release` releases the lease's current kind).
  Waiting is capped at `sandbox.lockWaitSeconds` (default 75, **must be greater than the lease TTL**, Ruling M15), then `sandbox.busy`. Two replicas using it
  for the first time at once build only one; several holders hitting `gone` together rebuild once (the others find the new instance and see "recreated").
  A holder that was not there for the rebuild (the parent, or a sibling sub-agent, on its next call) also sees "recreated": the kernel keeps the
  instance each agent conversation last used (`capk:sandbox-seen:<env>:<holder conv>`, its `created_at`, TTL `destroyAfterInactiveDays` + 1 day)
  and reports a change once.
  An instance is named by its handle **and** the row's `created_at` (set by the fenced write after each `create`): sandbox-docker's handle is the instance
  name, the same after a rebuild, so the handle alone would make every holder rebuild in turn and wipe the instance the previous one had just built.
- **Takeover per holder**: each holder records itself in `capk:sandbox-holders:<env>` (TTL `maxCommandSeconds` + 10 min) before its provider calls,
  refreshes the record before every `exec`, and deletes it **before** releasing its lease. Every acquirer claims records without a live lease (crashed
  holders) atomically and kills only their commands with `killTagged` (every provider has it; other conversations of the device may be running commands).
  `killAll` runs only under the exclusive lease, before the downgrade, on an instance that acquirer just resumed from `suspended`: nobody else can hold
  it, and that one call also covers the crashed holders' records it claims. A newly created instance has nothing to kill (records found then are only
  claimed). The claim removes the records before the kill: an acquirer that crashes in between leaves those commands to the in-sandbox time limit.
  There is no single-holder path and no single "sandbox in use" marker (the `capk:sandbox-busy:<env>` key of earlier kernels is neither read nor written);
  the cap is always `sandbox.maxConcurrentCommands`.
- **Kernel file writes per path**: `Write`, `Edit`, attachment sync (its marker) and `Skill` copies (the skill's marker) take a per-path
  lease (30 s, renewed, waited for up to 30 s, then the tool error "Another sub-agent is writing this file; wait a moment and retry."). What shell commands write is not
  serialized; the `Bash` description says other sub-agents may run commands at the same time.
- **Fencing generation**: each lease acquisition (shared ones too) first increments `generation`, and later state writes (exclusive holders only; shared holders only move `last_used_at` forward with `GREATEST`) compare against it, so an old exclusive holder's writes necessarily fail (`SandboxLockLostError`).
- **Access**: the kernel checks the conversation owner's access to the device when it acquires the instance for a tool call; a loss fails the tool with `device.forbidden` / `device.not_found`.
- **Suspension**: a `@LockedCron` (`sandbox-suspend-idle`, once per minute across replicas) calls `suspend` on instances idle (no command from any session of the device) longer than `suspendAfterIdleMinutes` (default 10), or running continuously longer than `maxRunningMinutes`
  (default 120, Ruling M1). Those with any holder are skipped until the next time (one try at the exclusive lease, no intent); one past `maxRunningMinutes`
  gets the intent for about a second so new commands wait briefly and the suspension can get in when the running ones end. `last_used_at` is set when each
  holder leaves, so the idle clock starts when the last concurrent holder finishes.
- **Destruction**: a `@LockedCron` (`sandbox-destroy-inactive`, hourly); instances inactive longer than `destroyAfterInactiveDays` (default 7) get `destroy` (instance only; the files stay); a deleted device or org gets `destroy` and `destroyFileSystem`;
  a deleted device (also a departing member's) is destroyed immediately, instance and file system, through the one-off maintenance job
  `sandbox-destroy-for` (producer `SandboxJobs.destroy(deviceIds)`, data `{ deviceIds }`, consumer `SandboxService.destroyDevice`).
- **File reset**: `POST …/devices/:id/files/reset` records the audit row and, after the commit, enqueues the one-off maintenance job `sandbox-reset-files`
  (producer `SandboxJobs.resetFiles(deviceId)`, job id `sandbox-reset-files-<deviceId>`: a second request while one waits or runs joins it; removed when
  it ends, so a later request is a new job; consumer `SandboxService.resetFileSystem`, which waits for the exclusive lease) and answers 202.
- **Legacy cleanup**: the `@LockedInterval` job `devices-legacy-cleanup` (every 5 minutes, once per tick across replicas, `LegacySandboxCleanupJob`) takes up to 50 rows of the legacy
  `sandboxes` table per tick and destroys each old per-conversation instance and file system through the row's provider (`lookup(provider)`: `destroyByName` and
  `destroyFileSystemByName` on `cap-<conversationId>`, and `destroyByName` on a loaded `prev_provider`), then deletes the row. No lease: nothing holds a legacy row.
  Rows of a provider that is not loaded are kept (warned on the first tick of each hour); a failed row gets `sweep_failed_at` and is retried after the others. With
  no rows a tick is one `SELECT … LIMIT 1`; nothing else reads that table, and a later migration drops it.
- **Skill directories accumulate**: `Skill` copies each skill version to its own `/skills/<name>@<digest12>/` in the device's file system, which every
  conversation of the device shares, and nothing deletes an old one (there is no delete primitive in `sandbox@2`, and another conversation may still use that
  version). They are small and stay until the files are reset or the device is deleted.
- **Transparent recovery**: a suspended instance is `resume`d on next use; on `gone` or after the instance was destroyed, a new instance is created on the kept file system
  (`restarted: true`, processes are gone, files stay) and the tool result carries an English notice. After a file reset each conversation's next use is told the files were
  reset instead (`filesReset: true`, `SANDBOX_FILES_RESET_NOTICE`): the seen key records `<created_at>:<fs_resets>`, a count of resets the kernel keeps itself, because a
  provider may give the new file system the old id (sandbox-docker's volumes are named after the device; the fake does it with `setFakeFileSystemIdsByName`). A file system gone at the provider is never replaced: `fs_status = 'lost'` and `device.files_lost` until reset.
- **Provider switch**: a device whose files or instance belong to a provider that is not the current one cannot be used (`device.unavailable`, nothing changes; its
  files are not migrated) until that provider is back. Deleting it destroys the old provider's instance and file system through `SandboxProviders.lookup` while that extension
  is still loaded; otherwise the deletion fails and the row stays for a retry (an instance that cannot be destroyed is recorded in the `prev_*` columns).
  A row the old provider left mid-create (`status = 'creating'`, no file system recorded) is taken over by the current one, which first calls the old
  provider's `destroyFileSystemByName` (it may have made the file system by name); with the old provider not loaded, or on failure, it only warns.
- **Live devices only**: the instance row is created only for a live device (`deleted_at IS NULL`) of the caller's org, with the device's own `org_id`, and
  the use path re-checks it under the exclusive lease before creating anything: a use that waited behind `destroyDevice` gets `device.not_found` instead of bringing
  the provider resources back. A row of another org is also reported as `device.not_found`.
- **Per-command** limit `sandbox.limits.maxCommandSeconds` (default 7200); `Bash` defaults to 120 seconds. A command timeout is also tightened to
  the time remaining in the owning run minus 30 seconds (`runtime.maxRunSeconds`, default 900, Ruling M20; the built-in tool context's `runDeadline`), and the result
  tells the model it was due to the run time limit. Long commands need `maxRunSeconds ≥ maxCommandSeconds`, otherwise startup logs a warn.
- **Background task jobs** (`packages/kernel/src/background`, rows in `capybara.background_tasks`): the worker's `@LockedInterval`
  `background-task-poll` (every `sandbox.background.pollSeconds`) checks running tasks through `SandboxService.ifRunning` and finishes each
  with one conditional update plus its event; the daily `@LockedCron` `background-task-prune` deletes finished rows after
  `tools.outputRetentionDays`. A stop claims its task in PG first (`stopping_at`, abandoned after 5 min, `STOP_CLAIM_TTL_MS`) so the poll
  skips it. A wake inside the 60 s window (`WAKE_WINDOW_MS`) is the delayed job `bg-wake-<conversationId>-<windowEnd>[-r<n>]` on
  `cap-kernel-maintenance` (`-r<n>`: re-scheduled when it fires early).

## Security

- **Docker's socket proxy** (`docker/sandbox-proxy/haproxy.cfg`, the one config core ships; `docker/compose.yaml` inlines it as `configs.sandbox-proxy-haproxy.content`,
  kept equal line for line by `pnpm check:compose-haproxy`): allows only the endpoints `sandbox-docker` uses, containers / volumes are recognized only by names starting with `cap-`,
  and request bodies are rejected by regex for privileged mode, `Binds`, `CapAdd`, non-ASCII keys (Go folds key names by Unicode, `Bindſ` = `Binds`) and so on. **This is only a backstop;
  the main defense is network position**: anything that can reach the proxy can nearly control Docker. **Never publish the proxy on any host address (127.0.0.1 included)**;
  in production, put it only on the internal network where the kernel runs, and do not attach sandboxes to that network. The dev compose publishes it on `127.0.0.1:2375` for the local machine only (Ruling M13); in that case never set the plugin's
  `openEgress: "direct"` (a direct open sandbox can reach the host loopback through `host.docker.internal`); the default `"proxy"` refuses private addresses.
- **The proxy config has a copy in capybara-hq/plugins**: the `sandbox-docker` tests start a real HAProxy from `plugins/sandbox-docker/test/sandbox-proxy/haproxy.cfg` in that repository.
  `pnpm check:bootstrap --network` (rule `bootstrap-haproxy`) requires that copy, at the bootstrap manifest's `marketplace.commit`, to equal core's `docker/sandbox-proxy/haproxy.cfg` byte for byte.
  A change to the proxy rules therefore lands in both repositories: in capybara-hq/plugins with a violating case against the real proxy (proving it is rejected), then here with the
  `marketplace.commit` bump.
- **Sandbox images**: the compose `sandbox` profile builds `capybara-sandbox` and `capybara-sandbox-egress` from git contexts
  `https://github.com/capybara-hq/plugins.git#<marketplace.commit>:plugins/sandbox-docker/image` (and `…:plugins/sandbox-docker/egress-proxy`), pinned to the same commit
  (rule `bootstrap-compose-ref` of `pnpm check:bootstrap`). The images themselves (container hardening, the egress proxy that blocks DNS rebinding by checking every resolved IP)
  are the plugin's; see its skill.
- Logs and errors carry no secrets and no other orgs' ids.

## Tests

- **Kernel tests use the fake sandbox**: `packages/kernel/test/fixtures/plugins/sandbox-fake`, deployment config `{ root }`; multiple replicas sharing one
  root share the same instances. Helpers: `readFakeSandboxOps` (operation counts), `removeFakeSandbox` (simulate gone),
  `setFakeSandboxDelays` (slow operations; `exec` holds a command open), `fakeSandboxState`; the fake declares `concurrentExec`, records each command's tag in
  `procs/<pid>` and logs `exec <id> <tag> <startMs> <endMs>` and `kill-tagged <id> <tags>` in `ops.log`. Concurrent holders: `packages/kernel/test/sandbox/concurrent.test.ts`,
  `concurrent.dual.test.ts`; the Redis protocol: `leases.test.ts`; takeover after killing the executing replica and recovery after suspension:
  `packages/kernel/test/sandbox/sandbox-artifacts.dual.test.ts`. See `packages/kernel/test/sandbox/*`,
  `packages/kernel/test/tools/sandbox/sandbox-tools.test.ts`, `packages/kernel/test/skills/m5-segment3.dual.test.ts` for cases.
- `@capybara-hq/testing` exports what provider tests in capybara-hq/plugins assert on (`SANDBOX_STARTED_NOTICE`, `SANDBOX_RESTARTED_NOTICE`, `SANDBOX_LOCK_TTL_MS`,
  `SANDBOX_SUSPEND_JOB`) and `startFakeE2B`; changing those texts or keys breaks the official providers' tests, so treat them as part of the contract.
- Real Docker, runsc and E2B are tested in capybara-hq/plugins; manual acceptance on real runtimes is in `docs/superpowers/plans/m5-live-acceptance-checklist.md`.
