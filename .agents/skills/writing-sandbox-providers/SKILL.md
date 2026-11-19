---
name: writing-sandbox-providers
description: 'Use when changing the kernel side of sandbox@2 or anything that drives a sandbox from the kernel: the contract as the kernel relies on it (devices, file system versus instance lifecycle, gone versus ordinary errors, abort, in-sandbox time limits, killTagged, exec tags, list / scan), permissionSupport v2 (boundary operation / instance), the device sandbox and its network (effectiveDeviceSandbox, open-public and the closed address classes, the fake-IP DNS fallback, no limits.mode, update, limitsApplyAt), protected write chains and the reserved staging prefix, per-call escalation, the SandboxService lifecycle keyed by device id (leases, holder records, path leases, fencing generation, idle suspension, inactivity destruction, rebuild and notices), the socket proxy config and compose sandbox profile core ships, and kernel tests on the sandbox-fake fixture. To write a sandbox extension (sandbox-docker, sandbox-e2b) see writing-sandbox-providers in capybara-hq/plugins.'
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
  // optional, both or neither (project root spec §4.1); without them the device offers no projects
  list?(h, path, { limit, limits, signal }): Promise<{ entries: { name; isDir }[]; truncated } | null>;
  scan?(h, base, { limits, signal }): Promise<{ path; suggestedName }[]>;
}
```

On the activated tree (device protocol 4, `PERMISSION_CONTEXT_ACTIVE`) the kernel never calls the raw `exec` / `readFile` /
`writeFile` / `stat` / `list` / `scan`, `killAll` or `killTagged` for a tool: every builtin enters a device through the
permission-scoped surface (`packages/plugin-sdk/src/sandbox-operation.ts`): `permissionSupport(h)`, `operation(h, scope)`
(the admitted `SandboxOperationScope`: filesystem roots, network, actor and tag come only from it), `prepare` (trusted staging
of skills and attachments), `browse` (owner metadata only), `revokeOperation(h, ref)` and `background` (`start` / `status` /
`tail` / `readOutput` / `stop` by exact `SandboxExecutionRef`). A provider without that surface makes its devices
`unsupported`: missing operation support never falls back to the raw methods. The raw methods stay in the `sandbox@2`
signature for the lifecycle and the conformance suite.

**`permissionSupport` is version 2** (approval-only profiles design, "SDK and protocol"; `parseSandboxPermissionSupport`):
`{ version: 2, boundary, restricted, network: { openPublic, allowlist, perOperationHosts }, outsideSandbox, background,
unavailableReason? }`. A report of any other shape reads unprobed and admits nothing.

- **`boundary: "operation"`** (a local device, a future Linux-runtime cloud provider): every operation gets its own
  restricted scope (`restricted` set), per-operation hosts are possible, and `outsideSandbox` says whether the runtime can
  run the escalated pair (`filesystem: device` + `network: environment`, recognized by `isFullExecutionScope`).
- **`boundary: "instance"`** (`sandbox-docker`, `sandbox-e2b`): the container or microVM is the sandbox. `restricted: null`
  is supported here: the scope is the whole instance, the provider's outer network is the sandbox network,
  `perOperationHosts` and `outsideSandbox` are `false` (a cloud device has no outside and no per-call host grants; the reply
  says to add the host to the device's list). All three profiles are offered; they differ only in sensitive-command consent.
- The profile in a scope is for audit only: providers never derive enforcement from it. Every profile's ordinary call is
  scoped (Full access included); only an escalated call carries `device` + `environment`, and only within the device's
  outside-sandbox ceiling.

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
(`-print0`) and `grep` (`-rnHIE`, `--include`) and `timeout`. Background tasks need no shell tools of the image (below).

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
  The kernel no longer calls it (permission runtime cutover B-1): a resumed, failed-update or quarantined instance and a crashed holder are cleaned up by exact
  operation revokes (`revokeOperation`, see "Takeover per holder" below). The method stays in the `sandbox@2` signature. When the exec that kills processes cannot even start (process table exhausted),
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
- **`list` and `scan` (projects, project root spec §4.1, §4.2)**: the kernel keeps a device's projects itself (`device_projects`) and asks
  the provider only what it can read. Neither carries limits (protocol 4 removed the mode tier): the provider answers what
  the device reaches (a cloud instance: its workspace; a local machine: its owner ceiling). `list` is one directory's entries, sorted
  by code unit, at most `limit` (the kernel asks `limit: 1` as the existence check when a project is added and up to
  `MAX_DEVICE_LIST_ENTRIES` for the skills tree at run start), never `.` / `..`, `isDir` following links (a dangling one `false`), `truncated`
  when more; null only for a missing path the device could reach; a file, an unreadable directory or an unreachable path throws.
  `scan(base)` answers `base` and the directories at most `MAX_DEVICE_SCAN_DEPTH` (2) below it that hold `.git` or `AGENTS.md`, as
  `{ path, suggestedName }` with a name passing `isDeviceProjectName`, sorted by path, at most `MAX_DEVICE_SCAN_RESULTS` (50); one traversal
  for every provider so the suggestions agree: breadth-first in code-unit order, `base` first, at most `MAX_DEVICE_SCAN_DIRS` (500)
  directories read, no symbolic links, no hidden directories, descending past a hit, skipping (never renaming) a directory with an invalid
  name and paths the device cannot reach (`node_modules` and a macOS `Library` may be skipped); a missing `base` is `[]`. Entries only, never
  file contents. The kernel checks every answer again (shape, inside the base, the name rule, the bound). A cloud provider
  answers inside the container's workspace (the kernel scopes a cloud device's projects to it).
- **Background tasks** (`Bash` `run_in_background`, permission runtime cutover 8.2-8.4, `packages/kernel/src/background/managed.ts`):
  the kernel reserves the task row, writes the durable launch intent and calls `background.start(h, scope, { command,
  timeoutMs, maxOutputBytes, taskId, outputPath, retainUntilMs, instanceGeneration })` under the admitted operation scope; the
  output artifact is `${workingRoot}/.capybara/tasks/<taskId>.out` (never a caller path). The provider persists exact ownership
  before it acknowledges, returns a `SandboxExecutionRef` (a retry of the same generation, operation and input returns the same
  ref) and keeps the starting grants for the execution's lifetime. The poll, `TaskOutput` and `TaskStop` act only by that exact
  ref on its exact recorded generation, through `SandboxService.ifRunning` (a shared lease only on a running instance of that
  generation, never creating, resuming or rebuilding one): `status`, `readOutput` (an append-only prefix, at most 65,536 bytes
  a read), `tail` and `stop` (a persisted pending cancellation when unreachable, applied before an explicit resume runs
  work). No session id, PID or shell script is built or signalled (`test/background/legacy-removal.test.ts` scans the whole
  kernel for the SID tools). A task holds no lease while it runs and counts against `sandbox.background.maxTasks`; a revoked
  start is cancelled by its operation id (`revokeOperation`), and one on an incarnation that no longer runs becomes a
  retirement member (below). Rows left by the old launcher (`launch_state = 'legacy'`) are never read or stopped live: they
  belong to the legacy retirement.
- **Cloud installed evidence** (B-15, `sandbox/permission-runtime-reports.ts`): a cloud device has no installed binding.
  Under the lifecycle lease the kernel reads `permissionSupport(handle)` (bounded at 30 s) from a just-created instance
  (recorded in the `commitHandle` transaction), after every resume, and whenever the recorded report is stale
  (`cloudReportOwed`), and records it with a kernel-built identity (`cloudRuntimeIdentity`: provider plugin and version,
  handle, generation, recorded applied limits, no image digest). A later record is written only while the row still
  holds the probed handle, generation and limits. Any of these changing makes the context and admission unprobed alike,
  and so do an `unapplied` record and applied limits more permissive than the effective desired ones (open public under
  an allowlist, a host the desired allowlist does not cover; spec §124). Narrower
  applied limits stand: the outer boundary is the applied network, and restricted hosts (base, accepted additions,
  proposals) are cut to it. A narrowing, host-only too, goes through the exclusive lease on the next use: it is applied
  (`update` or recreate) and recorded again, or, on a provider bound to its file system, recorded `unapplied` (unprobed
  until a file reset). Readers never call the provider (a suspended instance reads as recorded). A failed read is logged
  once per generation and never fails the lifecycle step; after a resume it clears the recorded identity (unprobed),
  otherwise the evidence stays as it was. A cloud device without an instance is refused by admission but stays
  provisionable: provisioning is the lease's job, and the first operation is admitted only after it recorded the evidence.
  A cloud device never runs outside its sandbox: `effectiveDeviceSandbox` gives it no outside whatever the report says, and
  `cloudEnforceable` clears `outsideSandbox` from a report of an instance not applied as its own boundary.
- **Cloud reconcile** (B-12, `CloudPermissionSnapshots.reconcile*`): reconciling a device that carries
  `permission_reconcile_required` first narrows its authority to the applied limits the instance is known to run, by
  intersection (the outer network cut to the applied one; a real narrowing is published
  through the device ceiling writer), never the other way. The marker clears when the applied limits then are exactly the
  effective ones with nothing `unapplied`; otherwise the outcome names the `target` (the effective limits, never wider than
  the instance in any dimension). `SandboxService.reconcileLimits` (the worker's every-minute `sandbox-reconcile-limits`
  cron, each device at most once per 10 minutes) applies that target through the provider's `update` under the exclusive
  lease (a suspended instance is resumed, its leftovers killed, and suspended again), records it and reconciles again. No
  `update`, `recreate`, a gone instance or a failure leave the marker and its file reset action.
- **Legacy retirement** (permission runtime cutover 8.5, migration 0157, `sandbox/legacy-retirement.ts`):
  - **Freeze.** `LegacyRetirementStore.freeze` writes the freeze row under the exclusive platform authority lock, then enumerates
    before it returns. An R1 (protocol 2) kernel checked the freeze under the shared lock right before each SID launch's
    dispatch, recording the exact incarnation (provider and generation) it dispatched into; this release launches no SID task
    and only reads those marks.
  - **Obligations.** One per device, provider and exact instance generation, for every legacy row whose processes may live on and
    for each revoked managed start on an incarnation that no longer runs. A historical reservation without a recorded incarnation
    is `unknown`, never the current instance.
  - **Gate.** `SandboxService` enumerates the device itself and checks its obligations in `ensure`, under the exclusive lease,
    before use, resume, rebuild or provider switch. A device with an unresolved obligation, or with a candidate not yet
    enumerated, never takes the shared path. `LocalInstanceBindings.bind` refuses while one is unresolved.
    `RetireLegacyTasksJob` is retryable and bounded; the gate never depends on it.
  - **Retirement.** The current cloud incarnation is destroyed whole by its provider (never resumed or `killAll`ed; files kept),
    and the confirmed destruction is recorded in `device_instance_destructions`. `retire()` and `destroyRow` record theirs too.
    B-22: a **suspended** current cloud incarnation whose members are all revoked managed starts is not destroyed (its other
    tasks would be lost): each revoked ref's exact `background.stop` is sent while suspended (the provider persists the
    cancel), the instance is resumed, each stop is confirmed (`stopped` / `already-exited`) and the obligation resolves
    `exact-cancelled` (migration 0159) and acknowledges exactly the stopped refs, under the obligation's row lock and only
    while no other member exists; a use then goes on with the resumed instance, the worker suspends it again (a throw
    after the resume suspends it too). A pre-resume answer other than `cancel-pending` / `stopped` / `already-exited`
    destroys it while still suspended. A member recorded later (an unacknowledged revoked start or a legacy row) reopens
    the obligation: in `addMember`, or on the next scan for a member an old replica added (never settled meanwhile). Any
    failure is noted and falls back to the whole-instance destroy. The lifecycle reconcile (`reconcileLimits`) never
    touches an instance while the device has an unresolved obligation.
    A cloud incarnation the kernel cannot name (`unknown` provider or generation) resolves only once the device's current
    incarnation is destroyed with confirmation (the gate destroys a live one), the row keeps no `prev_handle`, and the
    obligation was recorded after the freeze. When the current row is not live (destroyed without a record, or `creating` with
    no handle) but once had an instance, the gate calls the row's cloud provider's `destroyByName` for the device's instance
    name and records that as the destruction of the row's incarnation; a failure keeps the obligation open. Any other
    non-current cloud incarnation without a recorded destruction is quarantined for good (`device.recreate_required`), even
    with a known provider and generation (kept fail-closed). A failed or impossible destroy stays retryable
    (`device.unavailable`).
  - **Same-name replacement carries the barrier.** The `unknown` rule holds only because every rebuild on one provider goes
    through `create`, which first removes the old `cap-device-<id>` instance: a provider `gone` answer (E2B's token-failure
    `gone` included) or `applyLimits`' swallowed destroy failure leaves nothing behind, and E2B's incarnations are one sandbox.
    A provider or kernel path that rebuilds without same-name replacement breaks the barrier.
  - **Deleted devices.** A device is gone when its row is missing, `deleted_at` is set, or its org is soft-deleted. The worker
    (bounded per tick) leaves a cloud obligation alone while the device's instance row exists (its destroy is still owed and
    records the destruction), then resolves an obligation by a recorded confirmed destruction, else moves it to `abandoned`. An
    abandoned cloud obligation that later gains a matching recorded destruction resolves too. Abandonment is never evidence:
    its members stay unsettled. `report()` keeps it out of `retired` and counts it in `abandoned` / `abandonedMembers`;
    `cleanRetirement` also requires none.
  - **Local machines.** A local obligation keeps the boot identity (`bootId`, from authenticated hellos; a hello without one clears
    it) that the device's machine last reported. It resolves `host-rebooted` once any current machine of the device reports
    another, not earlier, boot: the OS instance is the evidence, not the credential. Until then the device answers
    `device.restart_required`. With no boot recorded it never resolves and answers `device.replace_required`: delete the device
    and connect the computer as a new one.
  - **What never clears an obligation.** A local destroy, a service restart, a new generation, a timeout or a SID.
  - **After the freeze.** Nothing in `SandboxService` signals a SID or clears kill marks (the old `killPendingTasks` is gone).
  - **`ifRunning`.** It refuses legacy SID polls, stops and reads and staged browse on such a device (`RetirementPendingError`).
    Only exact-ref managed drains pass `exactRef: true`.
  - **Freeze state.** `freeze()` returns once its own enumeration settled (`scanUntilStable`) and records `enumerated_at`
    (migration 0158); a run whose enumeration keeps finding new legacy or revoked rows throws
    `LegacyFreezeUnsettledError` and clears `enumerated_at`, leaving the freeze published but not enumerated.
    `assertCutoverBarrier()` (the cutover barrier) refuses before the freeze, while `enumerated_at` is NULL, and while an
    unmarked legacy row (`legacy_dispatch = 'unknown'`) started after `enumerated_at` exists (both stamped by the database
    clock); rerunning the freeze once the old replica is stopped opens it.
  - **Cutover runbook** (`capybara permissions cutover …`, `apps/capybara/src/commands/permissions.ts`; kernel side
    `infra/cli/permission-cutover.ts`; `--json` on each). `report` and `freeze` use PostgreSQL only; `snapshot` needs
    Redis (the lifecycle leases).
    1. Release the boot-reporting device build and kernel (R1, protocol 2, dormant). Stop every old kernel replica before
       the first new one starts: an old replica is not fenced by the freeze and B1 settings writes are not fenced either.
       Drain the old workers too: an old retirement worker neither reopens an `exact-cancelled` obligation (B-22) nor
       skips a member added to one after the cancel, so it could acknowledge a revoked start nobody stopped.
    2. `report`. It lists `localWithoutBoot` (local devices with legacy rows whose machine has no recorded boot) and
       `cloudUnknown` (cloud devices whose legacy rows name no incarnation; it reads the task rows and never empties by
       itself: `prevHandle` / `noInstance` devices will answer `recreate_required`, `currentUnconfirmed` ones clear on
       first use through `destroyByName` while their row's provider is loaded, unflagged ones clear on first use). Wait
       until both are empty or accepted. Old replicas are detected where possible: live replicas (presence, Redis) whose
       kernel version differs from the CLI's (an old replica, or the CLI is the different build; builds of one version
       are not told apart), and `unfencedWriters` (legacy rows without the dispatch marker started after migration
       0157; how many after the freeze, after its enumeration and in the last 15 minutes by the database clock: only a
       replica without the 8.5 code writes them; `latestAt` never resets, so act on `recent` / `afterFreeze`). Replica presence reads `unknown`
       when Redis does not answer; an old replica that never starts a legacy task is not detectable, so step 1 still
       applies.
    3. Convert the config (`capybara config migrate-permissions`) and start it with `--activate-permission-config`.
    4. `freeze`: publishes the freeze, enumerates until stable before returning, fences pending producers (reserved
       legacy launches are refused at dispatch: `fencedReservations`). Do this before managed starts are activated (a
       revoked start recorded before the freeze with an unreadable generation stays `recreate_required`).
    5. `snapshot`: `CloudPermissionSnapshots.snapshotAll` snapshots every live cloud device without a snapshot, each under
       its exclusive lifecycle lease and in its own transaction. It refuses behind an open barrier (no freeze, or not
       enumerated) and when this CLI's permission configuration is not the published one (`assertCurrent`, also checked
       per device under the platform lock; that failure stops the run). A rerun visits nothing and publishes nothing; a
       crash or a failed device (lease wait) leaves that device without a snapshot for the next run, never half written
       or published twice. A narrowing goes through the device ceiling writer (epoch, Full consent reset, exact
       revocation). Devices whose applied limits are not established keep `permission_reconcile_required` (listed)
       until a file reset reconciles them. Exit 1 while any device failed or is pending. Ctrl-C stops between devices
       (the device in flight commits or rolls back whole); `--lease-wait-ms` bounds each device's lease wait.
    6. Right before R2, run `snapshot` again until `pending` is 0: cloud devices created after step 5 start with
       `owner_full_access` NULL. Then R2, gated on `retired` (below). Deploying R2, again stop and drain every
       replica of the previous release before the first R2 worker runs (its retirement worker must be the only one
       settling `exact-cancelled` obligations, as in step 1).
    Operator notes: upgrade the kernel before the devices at R2 (a v3 device that reaches a kernel not yet on R2 gets 426
    "Update capybara-device"); running legacy background rows finish only after the freeze (step 4), and until then each
    holds a background slot and keeps its instance from idling.
  - **Release gate.** It passes on `retired`. With `abandoned > 0` it also needs the operator to acknowledge: "N old incarnations
    were abandoned with their devices; legacy processes may still run on those computers; no device can reuse them".

### Limits and the device sandbox network (`SandboxLimits`)

- **The sandbox is a device setting, the same under every profile** (approval-only profiles design,
  "Settings model"). One pure function, `effectiveDeviceSandbox(platform, org, device, provider)`
  (`packages/kernel/src/sandbox/device-sandbox.ts`, read live by `PermissionFacts`), gives the
  boundary, the network mode and ceiling, the allowlist hosts, whether a call may run outside the
  sandbox and the layer that set each ceiling. The device mirrors it in `intersectOperation`.
  - **Outside the sandbox:** only when the platform (`devices.outsideSandbox`), the org
    (`outsideSandbox`), the device owner (`ownerCeiling.outsideSandbox`, set on the machine) and the
    provider all allow it; a cloud device and an instance-boundary provider never do.
  - **Network ceiling:** the narrower of `devices.network.ceiling` and the org's
    `deviceNetwork.ceiling` (`allowlist` is narrower than `open`), clamped to what the provider
    can enforce; `sandbox.limits.egress: none` (the kill switch) closes it.
  - **Network mode:** the device's choice (a local owner's `network`, a cloud device's
    `devices.network_mode`; NULL follows the org), else the org default, else
    `devices.network.default`, clamped to the ceiling. `network_mode: none` is a closed cloud network.
    The owner sets a cloud device's choice on the device page (`PATCH /devices/:id` `network:
    { mode, hosts? }`, `DevicesService.update` / `planNetwork`; a local device gets
    `device.ceiling_on_machine`): within the ceilings and the org's hosts
    (`device.network_not_allowed`), under the ordered locks (membership, device row, the device's
    permission write lock). An API token or the Platform tool (`devices.set-network`) may only
    narrow, compared on the stored setting and on the effective sandbox. The view reports
    `pendingNextUse` / `pendingFilesReset` (`limitsApplyAt: "fileSystem"`) and the audit
    `device.network_changed` (`via: web | token | agent`).
  - **Hosts:** the org's effective hosts (`orgEffectiveHosts`: the platform's `allowHosts` minus the
    org's `excludedHosts` plus its `extraHosts`, or the extras alone under `base: none`; never a
    copy, so platform changes reach every org), intersected with the device's own list (a local
    owner's `allowedDomains` while its network is `allowlist`, an empty one allowing nothing; a
    cloud device's `network_hosts`, an empty one following the org). A device list only narrows.
  - **Per-call host grants** follow `hostGrantCeiling` / `hostGrantRefusal` (same file) under every
    profile: the org's `excludedHosts` never; an allowlist ceiling (platform or org) is hard (only
    the org's hosts; "an organization admin adds …"); `orgHosts: within` keeps grants within them
    ("a super admin adds the host"); a local owner's allowlist is a second ceiling ("capybara-device
    policy add allowedDomains …"); nothing on an instance-boundary device or a closed network.
- **What a provider gets.** `SandboxLimits` carries resources and the outer network only:
  `network: { kind: "open-public" | "allowlist", hosts }`. There is **no `limits.mode`** (protocol 4
  removed the tier; the device's `exec` / `create` limits refuse unknown keys, and a provider must
  not require or read a mode). The provider enforces the `limits` it receives and never reads org
  settings or platform switches. A cloud instance's outer network is its sandbox network; a local
  device's commands carry the device sandbox network and the machine intersects it with its owner
  ceiling.
  - `open-public` (开放挡内网): the public internet on any port. Closed, by resolved address and by
    IP literal alike (the SDK's one table, `packages/plugin-sdk/src/network-classes.ts`:
    `classifyAddress`, `ADDRESS_CLASS_RANGES`, `OPEN_PUBLIC_DENIED_CLASSES` /
    `OPEN_PUBLIC_DENIED_CIDRS`, checked against the kernel's `net/public-address.ts` and the Linux
    forwarder's Python copy): private and LAN ranges, CGNAT, ULA, link-local and metadata
    (`169.254.169.254`, `fd00:ec2::254`, Azure's `168.63.129.16`), loopback and the host's own
    addresses, multicast, broadcast, `0/8`, NAT64 and the reserved ranges. They are reachable only
    by running outside the sandbox. A cloud provider enforces this outside the container (Docker:
    the egress proxy; E2B: its network filter), never by an OS sandbox inside it.
  - `allowlist`: only `hosts` (`validateAllowHost` rejects IP literals, single-label names and
    `.local` / `.internal`; `*.example.com` matches subdomains, not the apex). The same closed
    classes hold: an allow-listed name resolving to a closed address is refused.
  - A provider that cannot allow by domain name must **refuse, or degrade to closed with a
    warning**, and never silently open up (E2B self-hosted `domainAllowlist: false`).
- `cpu` / `memoryMb` are the values **in effect for the org**: a super admin can override them per org in the admin console (deployment setting `sandboxLimitOverrides`,
  orgId → `{ cpu?, memoryMb? }`, cpu 0.25–64, memoryMb an integer in 256–262144, C19); the items given replace the deployment defaults of `sandbox.limits`, and items not given and `diskMb` keep the deployment defaults (kernel `effectiveSandboxLimits`); org admins see the effective values and their source read-only in org settings.
  The provider just enforces the `limits` it receives from `create`; a provider that cannot size each sandbox (such as E2B, where the template decides the size) must state in its README
  "org-level cpu / memory overrides do not take effect for this plugin"; a deployer who needs different sizes uses different templates.
- **The network follows running instances; the rest applies at create.** The kernel records the
  limits an instance was created with (`device_instances.instance_limits`; NULL reads as unknown, and
  an old `{ tier, egress }` record reads as unknown too). On use, when the effective network kind
  differs, it calls the optional `update(h, limits, signal)` under the exclusive lease: `"updated"`
  records the new limits; `"recreate"`, a gone instance, or a provider without `update` destroys and
  recreates the instance on the same files (the existing "recreated" notice). A non-gone `update`
  failure recreates on instance-bound providers; after an abort, or on a provider with
  `limitsApplyAt: "fileSystem"` (E2B: the instance is its file system), the instance is quarantined
  (suspended or killed) and the error rethrown. A `"fileSystem"` provider without a successful
  `update` keeps the old record, and the device view says `pendingFilesReset` (「重置文件后生效」): the
  record never claims more than is in force. Changes of `network.hosts`, `cpu`, `memoryMb` still
  reach only instances created afterwards, and `diskMb` only file systems created afterwards. When an
  item cannot be done, say so in the README (Docker's default local volume driver does not limit
  `diskMb`; E2B's cpu / memory / disk are decided by the template).
- **Provider refusals** (auto mode spec §4.2): a failed `createFileSystem` / `create` / `update`
  that is not an abort, gone, unreachable or kernel error is logged with the provider's error and
  replaced (`providerRefusal` in `sandbox.service.ts`); a cloud provider refusing the open public
  network becomes `sandbox.open_network_refused`, any other create `sandbox.create_failed`. The
  sandbox tools turn them into actionable text (`SANDBOX_OPEN_NETWORK_REFUSED_TEXT`,
  `SANDBOX_CREATE_FAILED_TEXT`); the provider's own message never reaches the model (it may name its
  settings). Test the refusal with `setFakeSandboxRefuseOpenEgress`.
- **Neither network prevents data exfiltration**: the open network and the allowlist close the
  internal network, but not data sent to a reachable host (`git push` to github.com, publishing
  packages). What a sandboxed command can send is bounded by what the sandbox can read (the scope,
  the minimal environment, the protected paths closed). The README must say so and recommend
  `deviceNetwork.ceiling: allowlist` / `sandbox.limits.egress: none` for sensitive orgs.
  Where a provider enforces more weakly, write it in the README (E2B looks only at Host / SNI and
  does not verify the destination IP, Ruling M14).

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
- **Projects.** A machine that serves the device operations `list` and `scan` announces the `projects`
  feature in its hello, plus the owner's home (`DeviceHello.home`, stored with the machine: the base of
  a project path under `os-user` project reach). `@local`'s `list` / `scan` forward them only to a
  machine that announced `projects` (the device answers within its owner ceiling: `os-user` reach
  reads with the owner's rights, `workspace` reach only the workspace, a docker-mode device in its
  container); for
  any other the device offers no projects (`device.projects_unsupported`). The device keeps no project
  list and has no project operations; projects live only in the kernel's `device_projects`.

## Lifecycle: `SandboxService` (`packages/kernel/src/sandbox/sandbox.service.ts`)

The kernel owns it; the extension implements only primitives. **Do not do scheduling, timing or state tables in the extension**:

- **State** lives in the device's row (instance status `creating` / `running` / `suspended` / `destroyed`, instance handle, file system handle, owning provider), keyed by
  **device id**, never by conversation. The file system is created with the device; the instance is created lazily on the first sandbox tool call of any session.
  The old `sandboxes` table is no longer used (a later migration drops it).
- **Leases** (phase C, `packages/kernel/src/sandbox/leases.ts`, spec `docs/superpowers/specs/2026-10-26-subagents-design.md` §10): using a sandbox recorded
  `running` takes a **shared** lease (up to `sandbox.maxConcurrentCommands`, default 6, hot, shared by all sessions of the device):
  every sandbox tool, attachment sync, `Skill` copies. Every lifecycle change (create instance, first use, rebuild after `gone`, `resume`, provider switch,
  `suspend`, `destroy`, the exact revocation after a resume) takes the **exclusive** lease, alone. Keys: `capk:sandbox:<env>` (the lock key: an exclusive token or the literal `shared`), `capk:sandbox-users:<env>` (zset of shared tokens by expiry), `capk:sandbox-intent:<env>`
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
  refreshes the record before every `exec`, and deletes it **before** releasing its lease. The operations a holder admits carry its lease token as
  their holder. Nothing is ever `killAll`ed or `killTagged` (permission runtime cutover B-1); cleanup is exact, by operation id:
  - **Crashed holder.** Every acquirer reads the records without a live lease (`SandboxLeases.deadHolders`, which leaves them in place), owes each
    token's revocation in an outbox row (`SandboxOperationIntents.oweHolderRevocations`, job `sandbox-holder-revoke-<deviceId>-<token>`), and only then
    forgets the records (`forgetHolders`). It then revokes the holder's admitted, dispatching and started-or-unknown intents inline (`revokeHolders`);
    if that fails, the maintenance worker's job retries it. If the outbox write itself fails, the record stays for the next acquirer. A record whose
    TTL lapses before anyone reads it is dropped unowed (its operations are past their device-enforced deadline).
  - **Incarnation nobody else holds.** Under the exclusive lease, on an instance just resumed from `suspended`, after a failed limits change on it,
    in the `reconcileLimits` resume and in a `quarantine` that cannot suspend, `revokeIncarnation` revokes every admitted, dispatching and
    started-or-unknown intent of that provider and instance generation (no live dispatcher can exist). On a resume it runs before the row says
    `running`; if it fails, the instance is suspended again (best effort) and the use fails, so the next resume revokes again.
    `background-running` intents keep their starting grant.
  - **Revoked launches.** A revoked `backgroundStart` with no exact ref ends its task in the same transaction (`lost`, a model-readable reason),
    freeing its `maxTasks` slot; the exact revoke stays owed.
  - **Delivery.** Each revocation writes `sandbox-operation-revoke-<operationId>` outbox jobs, which deliver `revokeOperation` until acknowledged.
    The holder also delivers the owed revokes of the instance inline before it runs anything (after a resume, or when it found crashed holders).
    That inline delivery is best effort, as the old `killAll` was: at most 100 per call, nothing without `revokeOperation`, and a failure only
    warned. The owed jobs keep every revoke durable. A revoked exec, read or write whose incarnation no
    longer runs is acknowledged once that incarnation provably ended: its confirmed destruction is
    recorded (`device_instance_destructions`), or the operation is past its admission deadline plus
    `maxCommandSeconds` and a 10-minute margin (the in-sandbox time limit); otherwise it stays owed. A
    revoked start is acknowledged only after a verified end: a `lost` task record (a launch revoked or
    given up before its ref was known) is stopped by the late ref first.
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
- **Per-command** limit `sandbox.limits.maxCommandSeconds` (default 7200); `Bash` defaults to 120 seconds. When a run duration limit is set
  (`runtime.maxRunSeconds` > 0; the default 0 is no limit, and then there is no `runDeadline` and no tightening), a command timeout is also
  tightened to the time remaining in the owning run minus 30 seconds (Ruling M20; the built-in tool context's `runDeadline`), and the result
  tells the model it was due to the run time limit. Long commands then need `maxRunSeconds ≥ maxCommandSeconds`, otherwise startup logs a warn.
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
- **Restricted write policy** (`packages/plugin-sdk/src/sandbox-write-denies.ts`, one source for the
  Linux broker, `native-files.py` with `denyWrites`, the device agent and the macOS runtime's ordered
  regex rules through the pnpm patch of `@anthropic-ai/sandbox-runtime`): mandatory denies (shell,
  git-global, `.envrc`, `.npmrc`, editor, agent and hook-manager files), the gitdir allowlist, no
  forged repository inside it, no bare-repository `HEAD`, nothing moved out of `.git`. Known
  limitations: a restricted command cannot `git init` or create submodules, worktrees or bare
  repositories; it **can forge a rebase or cherry-pick in progress** (`rebase-merge/`,
  `rebase-apply/`, `sequencer/` are writable for git's own use), and the owner's `git rebase
  --continue` (or `cherry-pick --continue`) then runs the `exec` lines of the todo list it wrote;
  `package.json` scripts and similar convention-run files are not covered; `git worktree prune`
  and the config-section removal of `git branch -D` fail under restricted; on macOS a multi-commit
  cherry-pick or revert reports it cannot remove `.git/sequencer` (the worker removes it when empty). On macOS a directory
  renamed into git's subtrees keeps contents Seatbelt never saw; owners are advised to set
  `git config --global safe.bareRepository explicit` (documented, never changed automatically).

## Local file access on protocol 4

A protocol 4 machine runs work only under an admitted operation scope: `LocalDeviceProvider.staged`
(`packages/kernel/src/local-devices/local-device-provider.ts`) is the `@local` registration, and its raw
`exec` / `readFile` / `writeFile` / `stat` / `list` / `scan` refuse with `SandboxPermissionUnsupportedError` before anything
is queued, while `killAll` / `killTagged` queue nothing. Reads and writes go through `operation(h, scope)` (the scope's read
and write roots, the frame-sized `readFile` cap of `devices.local.maxFrameBytes`), staging through `prepare`, owner browsing
through `browse`, commands through the request-bound execution adapter (the admitted call grants, cut to the org's current
limits; a host the limits now refuse fails the call). The machine re-checks every scope against its owner ceiling
(`ownerCeiling { outsideSandbox, network, allowedDomains, restrictedProjectReach }`, reported as `DeviceOwnerCeiling`
version 3). The web narrows it only through the `policy` op (network to `allowlist`, hosts removed, `outsideSandbox`
off, `restrictedProjectReach: workspace`); a `policy` op that adds hosts or carries a `mode` is refused (`POLICY_ADD_REFUSED`): widening happens only on the
machine (`capybara-device ceiling set --outside-sandbox on|off --network open|allowlist`, `capybara-device policy add
allowedDomains <host>`). Kernels and device programs upgrade together with no fallback: the kernel refuses a protocol 3
program (426, "Update capybara-device"), and a protocol 4 program facing an older deployment says the deployment must be
upgraded.

## Per-call sandbox escalation

Running one `Bash` call outside the sandbox (`sandbox: "escalated"` with a justification) is the `outside-sandbox`
crossing: Request approval asks the person, Approve for me the review model, Full access auto-grants it within the
outside-sandbox ceiling, except that a sub-agent's escalation or one carrying a credential consent goes to the review
model (`approverForCrossing`, writing-tools). It is also the only way to reach private, LAN, loopback, link-local and
metadata addresses, the Docker and kernel sockets and the protected paths. An admitted escalation gets the escalated
pair (`filesystem: device`, `network: environment`) for its command only (exec or backgroundStart; its native methods
keep the base scope), and only while the call holds an `outside-sandbox` grant and the snapshot's
`outsideSandboxCeiling` holds. `isFullExecutionScope` (`sandbox/operation-authority-types.ts`) recognizes the pair for
the provider support check (`held-operations.ts`) and the `outside-sandbox-off` revocation predicates
(`permission-ceiling-writes.ts`, `owner-report.ts`, `policy-summary.ts`); the device's `intersectOperation` decides the
same way. Admission (`resolveInvocation`) refuses an escalation without its grant under every profile, and when the
snapshot's `escalationRefusal` is set (running outside not allowed by a layer, a runtime without `outsideSandbox`, an
unattended run). An escalated call runs as the owner with the device program's environment minus every `CAPYBARA_*`
variable. The device's `commands.log` writes `isolation: "full"` and the grant source for such an operation, never the
command. A cloud device has no outside, so an escalation there is refused before any effect.

## Sandbox network and write rules on the device

The device workers enforce the sandbox; the kernel only computes the scope. What each worker must hold (the conformance
suite in `@capybara-hq/testing` checks it):

- **Open network on the resolved address.** Every sandboxed connection goes through the operation's own proxy (macOS:
  the patched sandbox runtime with `resolvedAddressStrict`; Linux and local Docker: the forwarder), which classifies the
  resolved address (IP literals too, no `localhost` carve-out) with the SDK's address-class table and dials exactly the
  address it checked, so DNS rebinding cannot swap it. The allowlist uses the same path. HTTP(S)- and SOCKS-aware clients
  work on any port; a proxy-unaware client (plain `ssh`) does not connect.
- **Fake-IP resolvers.** When the system resolver answers a name with an address in `198.18.0.0/15` (a router in fake-IP
  mode), the proxy re-resolves it through DNS-over-HTTPS (`SANDBOX_FAKE_IP_DNS` in `network-classes.ts`: RFC 8484 wire
  format at the IP-literal endpoints `1.1.1.1`, `1.0.0.1`, `8.8.8.8`, `8.8.4.4`; one 5 s deadline per name shared among
  them; complete answers cached for their TTL, at most 300 s and 256 names) and judges and dials the real address. When
  that fails the connection is refused naming the fake-IP resolver; the fake address is never dialled.
- **No own-listener connect.** No sandboxed client connects to a loopback listener, its own command's included (a
  listener cannot be told from another process's at the address dialled). On Linux a restricted command may bind and
  listen on loopback for clients outside the sandbox, and `SO_REUSEPORT` / `SO_ATTACH_REUSEPORT_*` are refused by
  seccomp; on macOS listening is refused (Seatbelt cannot restrict a bind to loopback). A dev server that must be reached
  runs through the escalation.
- **Minimal environment.** A sandboxed command never inherits the device program's environment: `PATH`, `LANG`, `HOME`
  (the working root), a private `TMPDIR` / `TMP` / `TEMP`, the detected tool homes, the proxy variables and the call's
  own `env`, under every profile.
- **Protected paths and chains.** The owner-denied secret paths (`DEVICE_DENIED_SECRET_PATHS`), the device state
  directory, the mandatory write denies and the OS persistence locations (`SANDBOX_SYSTEM_WRITE_DENIES`, LaunchAgents,
  systemd user units, autostart, the crontab spool) are closed under every profile. At operation start the worker
  resolves each protected home location component by component (`device/src/exec/protected-targets.ts`), following
  dangling links, and denies every link on the chain and the final target, anchored: an ancestor of an anchored deny
  never moves away. No directory grant covers a protected path.
- **Reserved staging prefix.** `SANDBOX_RESERVED_NAME_PREFIX` (`.capybara-staging-`, any case; `sandbox-write-denies.ts`)
  is denied to every sandboxed write on both platforms. The Linux broker moves a directory into a guarded prefix by
  renaming it to such a name first, checking it there and renaming it into place with NOREPLACE, under an exclusive
  lock against the operation's other writes (at most 5 s, then EBUSY).

## Known limitations (permission activation)

- **Local Docker mode needs the host's `/usr/bin/python3`.** A `capybara-device` in Docker mode runs the
  restricted output helper with the host interpreter; without it the device reports restricted support
  unavailable.
- **Cloud providers must ship with the kernel.** A cloud provider that still reports `permissionSupport` version 1 or
  reads `limits.mode` reads unprobed against an R3 kernel and admits nothing: release `sandbox-docker` / `sandbox-e2b`
  with support v2 (`boundary: "instance"`) together with the kernel and its bootstrap pins.
- **Public addresses that lead inward** (hairpin NAT to the router's WAN address, a VPN routing public ranges inward,
  an operator NAT64 prefix) are not closed: the classes are decided on the address. Such a machine needs an owner
  allowlist instead of the open network.
- **Version managers are readable under `workspace` reach too.** A restricted exec on a macOS or Linux
  host reads the version manager directories of the device user's home (`TOOL_HOME_DIRS`) and asdf's
  global `~/.tool-versions` read only (`restrictedToolHomes`, never a path at, under or holding an
  owner-denied one), even when the owner limited restricted project reach to the workspace.
- **`DockerContainer.ready` is not reset after a `docker rm` or a daemon restart.** The Docker provider keeps
  its readiness flag, so operations on that container fail closed until the provider (the kernel process)
  restarts.

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
