# Task 12 independent security review: sandbox-docker operation permission scopes

Reviewed: plugins `git diff 05d00a9 6f2e3e3` (branch `feat/sandbox-docker-permission-scopes`,
commit `6f2e3e3 feat(sandbox-docker): enforce operation permission scopes`), read-only. I judged the
code before reading the author's report. The SDK launcher (`linux-sandbox.py`) was out of scope; I
only looked at how the provider stages, verifies and drives it.

## Verdict: CHANGES_REQUIRED

Hardening is unchanged and staging is sound. Restricted support is reported only by the launcher's
own probe. Root pinning, the forwarder and foreground cancellation look correct, and the
actual-provider evidence is real (aarch64, Landlock ABI 8, all four claims). Three issues block
approval:

1. The background trust records are writable by the sandbox user. A restricted operation granted
   `/tmp` can forge its own record and keep running after stop or revocation. I reproduced this.
2. A Full-access background start can launch after its revocation, and can be orphaned by a stop
   that arrives just after the acknowledgement.
3. Revocation tombstones live on the instance tmpfs. They are lost when the provider restarts the
   container as its own kill fallback.

## What I checked and found sound

- **Hardening:** no diff touches `HostConfig` (CapDrop ALL, `no-new-privileges`, ReadonlyRootfs,
  PidsLimit, tmpfs `/tmp`). There is no CapAdd, no seccomp or privileged change, no new container,
  and no change to instance policy per profile. The test `keeps the container hardening unchanged`
  asserts this, and Seccomp mode 2 holds for uid 1000.
- **Staging:** `COPY --chown=0:0` into the read-only rootfs and `sha256sum -c` at build time
  (`image/Dockerfile:105-107`). `permissionSupport` checks owner, mode, no symlinks and digests
  (`operations.ts:751-785`). `verify_runtime` re-checks the SDK files and the directory before each
  restricted or direct launch (`capybara-operation.py:105-117`). The sandbox user cannot replace
  `/opt/capybara-runtime/*`: the files are root-owned on a read-only rootfs, and the runtime
  confirmed `touch` is refused. A mutant image reports `restricted:null, fullAccess:false`, and a
  restricted exec on it is refused. The agent does not re-hash itself at use; the probe and the
  read-only rootfs cover that.
- **Support claim:** `restricted` is non-null only when the launcher's `probe` reports all four
  claims (`operations.ts:795-811`). The probe runs only on an already running instance
  (`runIfRunning`). A restricted launch re-runs the launcher's static probe (`run()` → `probe_static`).
  The read-only `direct` path checks `probe_static` when `requireRestricted` is set.
- **Same pinned descriptors:** `pin()` opens each root with O_NOFOLLOW|O_DIRECTORY and checks it is
  canonical through `/proc/self/fd`. The same fds and (dev, ino) go to the launcher via `pass_fds`.
  `verify_roots` re-validates them, and the same fds feed the Landlock rules, the broker and the
  native helper in native mode (`capybara-operation.py:130-151, 368-399`). The conformance root and
  component swap races passed.
- **Consume before effect:** `record()` runs as root and writes with O_EXCL into
  `/tmp/.capybara-ops` (root, 0711, checked) before every user, browse and background-start method.
  A duplicate gives OutcomeUnknown and a mismatch gives ValidationError. The tombstone is checked in
  consume and again in `admit()` immediately before a launch (foreground and restricted
  background).
- **Foreground cancellation:** the abort path goes through `cancel <ctl>`, which matches only agents
  whose argv is exactly `capybara-operation.py exec|native capybara-exec <ctl>`. SIGTERM lets the
  launcher kill its subreaper tree; the launcher has PDEATHSIG. `killTagged` and `killAll` first
  SIGTERM matching restricted agents, then do the old forced pass. Tags are matched with the exact
  `-<uuid>( |$)` suffix, so a prefix tag never matches. The sibling-survival tests passed.
- **Allowlist forwarder:** one loopback forwarder per operation. The broker endpoint set is only
  `127.0.0.1:<its port>`, so the egress proxy itself is refused. It forwards only allowlisted names
  (IP literals and bracketed targets are refused) as CONNECT through the instance egress proxy. DNS,
  private-address and port rules stay in the egress proxy, so no local resolution or rebinding
  window is added. The forwarder is closed when the operation ends; for background work it lives as
  long as the supervisor. Full access is not affected.
- **Full path:** `filesystem: device` with `network: environment` only; anything else is
  unsupported. It runs the unchanged `execArgv` wrapper behind an `exec`ed admission prefix. The
  runtime confirmed no extra seccomp filter (1 vs 2), `setsid` allowed and writes outside the root
  allowed.
- **`agent: false`** (`docker-api.ts:113`) is correct. Node's default agent keeps connections
  alive, and HAProxy closes idle ones (`timeout http-request 30s` also governs keep-alive idle), so
  reusing one gave "socket hang up". One connection per request has no functional regression: the
  hijacked exec streams don't depend on pooling. The cost is more short TCP connections, which is
  acceptable. The code comment says "keep-alive timeout"; the config key is `timeout http-request`
  (nit).
- **Dependency move to testing rc.21 and the other plugins' test edits:** legitimate.
  `pnpm.overrides` pins one SDK, and kernel rc.32 does not start with SDK rc.27. The edits only
  adapt to kernel rc.37 behaviour: model providers are now off per org (`enableModelProviders`), and
  attachments are no longer synced (`FetchAttachment`). Only devDependencies moved; published
  dependency ranges are unchanged. Better split into its own `chore` PR, but not blocking.

## Findings

### Critical

None.

### Important

**I1. A restricted operation granted `/tmp` (or `/`) forges the background trust records: it
escapes stop and revocation, signals other processes through the agent, and reads or forges other
tasks' output.**

Where:
- `capybara-operation.py:568-581`: `BG=/tmp/.capybara-bg` is owned by the sandbox user, 0700.
- `capybara-operation.py:703-745`: the supervisor's `status.json` and its `output` spool.
- `capybara-operation.py:872-909` and `936-961`: `stop_execution` and `cancel --uuid` trust
  `status.json` for state, pid and start time.
- `operations.ts:520-533`: `checkScope` accepts any canonical root.

Failure scenario: for a background execution the only kill route is the record. The supervisor's
argv is `capybara-operation.py bg-start`, so neither the `TERM_AGENTS` pattern nor the
`capybara-exec <ctl>` pattern ever matches it.

`parseSandboxOperationScope` accepts `/tmp` as a write root. Kernel `aboveHome` rejects only `/`
and the home parents, so `/tmp` (or a one-operation escalation to it) is a reachable grant. Landlock
then permits writes under `/tmp/.capybara-bg`.

I reproduced it on the task's image (`capybara-sandbox:test-2420b1b876f5`) with the provider's
hardening (cap-drop ALL, no-new-privileges, read-only, tmpfs `/tmp`, uid 1000). I ran `bg-start`
for a restricted scope with `writeRoots:["/tmp"]` and network `none`, whose command rewrote its own
`status.json` to `{"state":"exited","exitCode":0}` and then ran `exec sleep 300`. Then I ran
`capybara-operation.py cancel --uuid <id>`, which is exactly what `revokeOperation` →
`KILL_OPERATION_SCRIPT` runs. Result: `stop.json` = `{"outcome":"already-exited","exitCode":0}`,
and `sleep 300` was still alive. `stop()` returns the same outcome.

So a ceiling revocation reports success while the restricted work keeps running under its old
grant. The plan requires that actual ceiling revocation stops affected work.

The same write access also lets the operation:
- put any sandbox-user pid and start time into a sibling task's record, so the kernel's `stop` or
  `revokeOperation` makes the unconfined agent SIGTERM or SIGKILL it. That is a confused deputy
  around Landlock's signal scoping, and it cancels a sibling.
- forge another conversation's `status.json` or `output`, which reaches that model through
  `tail` and `readOutput`.
- create `<ctl>.kill` files that cancel sibling operations before they start.
- with a read root of `/tmp`, read other conversations' spools.

Full-access work (same uid, no filters) can do all of this anyway. That fits the shared-uid trust
domain for Full, but it should be stated as a residual risk on the kernel side of "exact reference"
trust (see M5).

The author's README and report mention the `/tmp` case ("restricted work cannot unless a scope
grants `/tmp`") but treat it as acceptable. It is not acceptable for restricted work.

Fix, at least one of:
- (a) Refuse, in the provider, any restricted scope (operation, background, browse) whose read or
  write root is `/`, `/tmp`, or any other ancestor of `/tmp/.capybara-*`. Use
  `SandboxScopeDeniedError` or unsupported. Add a test with `writeRoots:["/tmp"]` and with
  `readRoots:["/tmp"]`.
- (b) Move the trusted background state out of every grantable path. Records need a writer that is
  not the sandbox uid. Root in this container has no CAP_SETUID or CAP_DAC_OVERRIDE, but it can own
  a root-only directory, as `/tmp/.capybara-ops` already does. For example, have the supervisor
  report status through an fd to a root-run recorder, or have a root-run `bg-status` step snapshot
  the record. Also give the kill path an identity that does not come from a writable file: record
  the supervisor's pid and start time in the root-owned consume record at start.

Recommended: (a) now, (b) as follow-up hardening.

**I2. A Full-access background start can launch after its revocation, and a stop right after the
acknowledgement can orphan an unsupervised Full child.**

Where: `capybara-operation.py:662-700` (`bg_start`), `703-713`, and `747-764` (`full_supervise`).

Failure scenarios:
1. Revoke between `bg_start`'s `admit()` (line 663) and the supervisor's `Popen` (line 753). The
   tombstone is written, then `cancel --uuid` finds no directory or no `status.json` and does
   nothing (or records `lost`). The Full supervisor never re-checks admission, unlike the restricted
   branch, whose `restricted()` calls `admit()`. It launches the command after the kernel was told
   the revocation was done. This is review focus 3 (delayed launch after a ceiling revocation).
2. The record says `running`, and `R` is acknowledged at lines 711-712, before `Popen` and before
   the SIGTERM handler is installed at line 763. A `stop` or revocation in that window kills the
   supervisor with SIGTERM's default action. The child was started with `start_new_session=True`
   and has no PDEATHSIG and no in-sandbox `timeout` wrapper. It keeps running forever with no
   supervisor, no timeout and a record that turns `lost`. The restricted branch is safe here
   because the launcher has PDEATHSIG.

Fix: in `bg_supervise` block SIGTERM, SIGINT and SIGHUP (`pthread_sigmask`) before writing the
running record. Install the handlers, call `admit(request)` again after the record exists and
before `Popen` (refuse with REVOKED or EXPIRED and record exited/refused), then unblock after the
child exists. Optionally run the Full child under `timeout -s KILL` like the foreground wrapper, so
a lost supervisor still bounds it. Add a test that revokes between start and launch (an injected
barrier, not a sleep).

**I3. Tombstones and consume records are lost when the provider restarts the container as its own
kill fallback, so a revoked or already-executed operation can run again within `admitBeforeMs`.**

Where:
- `operations.ts:985-1009` (`revokeOperation`) → `provider.ts:1169-1177` → `killOrRestart`
  (`provider.ts:985-1004`), whose budget is `within(15_000)`.
- `capybara-operation.py:936-961`: `cancel` alone waits up to about 20 s (15 s TERM, then SIGKILL
  and 5 s).
- `KILL_OPERATION_SCRIPT` (`provider.ts:430`) then runs `g` (up to 10 s), and `stop_execution` can
  wait 15 s more.

Failure scenario: a slow teardown pushes the kill script past 15 s. `killOrRestart` then restarts
the whole container, which ends every conversation's work and recreates the tmpfs `/tmp`, so
`/tmp/.capybara-ops` is gone. `revokeOperation` still returns success.

A delayed launch of the revoked operation is then consumed in the new generation as `new`, since
the tombstone is gone, and runs. A lost-acknowledgement retry of an already executed foreground
operation also runs twice. The contract requires the tombstone to be kept at least through
`admitBeforeMs`.

The same loss happens on suspend and resume, but there the kernel's pending-revocation duty
applies.

Fix:
- After `killOperation` returns, rewrite the tombstone (idempotent `revoke`). It is cheap, and
  `consume` checks tombstones by `opKey` across generations.
- Make the inner wait budgets fit `killOrRestart`'s 15 s, or give the operation kill its own budget
  above the sum of the inner waits.
- Optionally return an error (so the kernel retries) whenever the restart fallback ran during a
  revocation.

### Minor

**M1. A Full command can forge its own admission refusal** (`provider.ts:1135-1141`). Any Full
command that exits 125 with stdout starting with a well-formed `R` frame, such as
`{"events":[{"event":"refused","code":"REVOKED"}]}`, is reported as `SandboxScopeDeniedError`
("revoked before it started") or as cancelled (`exitCode:null`), although it ran and had effects.
The model controls the command, so it can make the event log record "not executed". That breaks
the "unknown is never proof it did not execute" rule. Fix: give the refusal frame a per-call random
nonce, passed to the agent through an env variable that the agent removes before `execv`, so the
command cannot read it from its own `/proc/self/environ`. Accept a refusal only when the nonce
matches.

**M2. Permission conformance on Docker exercises the network checks only on a test-only path.**
`permissionTestEndpoints` (`provider.ts:131-137`, `capybara-operation.py:345-349`) adds direct
broker endpoints and NO_PROXY entries that production never configures. This hides no production
bypass: production endpoints are only the forwarder port. It does mean the conformance suite's
allowlist assertions (the granted receipts and the sockaddr pointer race) run against direct
endpoints, not against the forwarder.

The separate egress test covers HTTP absolute-form to an allowed name, 403 for another name, the
egress proxy not being reachable directly, `none`, and `environment`. It does not cover:
- HTTPS `CONNECT` through the forwarder;
- a `*.` wildcard;
- an allowlisted name that the instance network denies (it must fail in the egress proxy);
- another restricted operation being unable to connect to this operation's forwarder port.

Add those four cases.

Also document that under a restricted allowlist, raw TCP clients that ignore proxy variables
(python sockets, node `net`, ssh, database clients) cannot reach the allowlisted hosts. That matches
the instance network but differs from what the conformance suite assumes.

**M3. A `/tmp/.capybara-ops` created first by the sandbox user disables operations** (denial of
service). `records()` refuses a directory that is not root-owned with mode 0711
(`capybara-operation.py:975-982`), and every consume then fails as unsupported until the instance
restarts. In practice root creates the directory on the first consume after start; any
pre-cutover `exec` path runs as the sandbox user and could plant it first. Consider having root
create it during instance start (`init`), as it already does for other root setup.

**M4. `<ctl>.kill` files are never removed** (`capybara-operation.py:938-942`). Each cancelled
restricted operation leaves an empty file on the size-limited tmpfs `/tmp`. The deterministic
`ctl` per operation ID keeps this correct, but the files should be cleaned up together with the
records.

**M5. Residual Full-access trust needs to be stated for the kernel.** Even after I1, Full work of
any conversation on the same device can rewrite `/tmp/.capybara-bg` (status, output, `stop.json`,
pre-created execution directories). A background status, exit code or "stopped" from this provider
is therefore only as trustworthy as the device's shared uid. Record this for Task 14 and in the
kernel's exact-reference trust notes. A further move of the records to a root-owned location
(I1 (b)) would close it.

**M6. `/proc` is readable as a system root** (launcher policy, reported for the launcher review).
A restricted operation can read `/proc/*/cmdline` of other conversations' Full commands. The
existing `execArgv` puts the whole command text in argv, so any secrets inlined in a sibling's
command are visible. `environ` is protected by Landlock's ptrace scoping; `cmdline` is not.

**M7.** The Docker API comment names the HAProxy setting as a "keep-alive timeout". The config's
`timeout http-request 30s` governs idle keep-alive. Nit.

## Core testing package issues (confirmed, for a core fix)

Package: `@capybara-hq/testing@0.1.0-rc.21`, file `dist/sandbox-permission-conformance.js`.

1. **`granted.host` must be both an allowlist name and an IPv4 literal, which no valid scope can
   satisfy.**
   - `SandboxPermissionEndpoint.host` is documented as "a numeric address the device can reach
     directly" (`.d.ts:5-6`).
   - The suite builds `allowlisted = { kind: "allowlist", hosts: [granted.host] }` (line 189) and
     passes it to `fixture.operation`.
   - Any provider following the contract runs `parseSandboxOperationScope`, whose
     `validateAllowHost` refuses `127.0.0.1` with "host must not be an IP address literal". The
     last label must start with a letter.
   - The suite also uses `granted.host` as a raw socket address: `FLIP_PROGRAM` calls
     `socket.inet_aton(sys.argv[3])` (lines 19-21 and 420), and `curl http://host:port`,
     `node net.connect` and `python create_connection` connect directly (lines 212 and 289-290).
   - Consequences: a conforming fixture cannot pass the suite unchanged, and the suite implicitly
     requires allowlisted hosts to be reachable by direct TCP, not through a proxy.
   - Fix: split the endpoint into `name` (an allowlist hostname the fixture maps to the endpoint)
     and `address` (a numeric IPv4 address for the pointer race and the ungranted comparison). Let
     the fixture declare whether allowlist reachability is direct or proxied: for a proxied
     provider, use `curl` with the proxy environment for the positive control and skip the raw
     `connect` positives.
2. **`waitFor` hangs forever when an operation is refused or ends before writing its ready file.**
   - `waitFor = async (path) => { while ((await fixture.inspect.readFile(path)) === null) await
     setImmediate }` (lines 206-210) is not tied to the operation promise it waits for (lines 314,
     350, 356, 367, 394, 432, 438, 459).
   - If that `exec` rejects (for example with Unsupported, ScopeDenied or a transport error) or
     exits without creating the file, the loop never ends. The rejection stays unhandled until the
     test times out; in plugins that is the describe's 30-minute timeout.
   - Fix: `waitFor(path, pending)` races the poll against `pending` and throws "operation ended
     before <path>" with the settled result or error. Alternatively, attach a `.catch` at creation
     and check a settled flag inside the loop.

## Tests run (this review)

- `CAPYBARA_TEST_REQUIRE_LINUX_RESTRICTED=1 pnpm exec vitest run
  plugins/sandbox-docker/test/permission-scopes.test.ts --maxWorkers=2`, run twice: 18 passed,
  1 skipped. The skipped case is the "Docker is required" guard. Runtime: Linux 7.0.14-linuxkit
  aarch64, Landlock ABI 8, Docker 29.9.3, seccomp builtin, image `sha256:8ff79df9…`, report with
  all four claims true.
- `manifest`, `network`, `sandbox-docker`, `concurrent` and `list-scan` (Docker, `--maxWorkers=2`):
  5 files, 120 passed, 1 skipped (runsc).
- `pnpm lint` and `pnpm typecheck`: pass.
- Manual reproduction of I1 in a hardened container from the task's image, as described above. The
  container was removed afterwards.
- Not run: the other plugins' suites and the dual-replica or smoke kernel tests. The author reports
  138 files passed and 256 plugin tests passed.

## Re-review round 1 (commit 142c948, `git diff 6f2e3e3 142c948`)

### Verdict: APPROVE (with minor follow-ups; nothing blocking)

I1, I2, I3, M1, M2, M3, M4 and M7 are fixed. I re-ran the I1 reproduction and tried to break the
new design by hand, in a container with the provider's hardening and the same skills-volume layout:

- **I1 reproduction:** a restricted background start with `writeRoots:["/tmp"]` is refused by the
  agent itself (`SCOPE_DENIED: A granted root contains the provider's records`), and nothing runs.
  The Node side refuses it too (`protectedRoot`, `checkRoots` for operation, background and browse).
- **Restricted work looking for the records:** a restricted background task with root
  `/workspace/a` cannot find the FIFO through `/proc/*/fd`. Landlock's ptrace scoping hides the
  supervisor's descriptors. It also cannot list `/skills/.capybara-ops/bg` (the directory is 0711)
  and cannot write anything under `/skills`, which is a read-only mount.
- **The sandbox user (Full co-tenant) attacking the records:** it cannot create, list or change
  records (`touch` and `mkfifo` under `/skills` fail with a read-only file system, and the
  directory listing is denied). It can only reach a FIFO by its exact name, and the name travels
  only on stdin.
- **Test-only hooks** (`backgroundLaunchBarrier`, `afterRevokeKill`, `permissionTestEndpoints`) are
  only on `DockerSandboxTestOptions`, the second argument of `createDockerSandbox`, which the plugin
  config cannot set. The barrier path reaches the agent only inside the provider-built request.

Design points confirmed:
- **I2 ordering** is mask, then P frame (record), then ack, then (test barrier), then `admit` (which
  checks tombstone, cancel marker and deadline), then Popen (the child unblocks in `preexec`), then
  handlers, then unblock. For the restricted path, `supervise()` installs the handlers and then
  unblocks, and `pdeathsig()` unblocks inside the launcher.
- **The Full background `timeout -s KILL <timeoutMs/1000+6>` wrapper** does not change Full's normal
  behaviour. The supervisor still times out at `timeoutMs` and kills the process group first; the
  wrapper is only a bound for when the supervisor is lost (the foreground wrapper uses +5 s grace).
  Exit codes pass through.
- **I3:** tombstones and consume records live on the persistent skills volume.
  `revokeOperation` runs tombstone, then foreground kill, then a background stop by the recorded
  identity, then rewrites the tombstone. If the generation changed in between, it throws (the
  kernel retries) and never reports success. Every wait now fits the 15 s `killOrRestart` budget:
  agent cancel ≤ 12 s, one graceful pass in killTagged (≤ 10 s), no stacked waits in the
  operation-kill script. The background stop steps run as separate execs under the caller's signal.
- **Stop:** root reads the identity, the sandbox user signals through a pidfd with a start-time
  check before and after `pidfd_open`, and root claims the outcome with O_EXCL. A reused pid is
  never signalled.
- **M1:** the nonce goes in through the exec environment and the agent pops it before `execv`, so it
  is absent from the command's environ. A frame without the matching nonce is ignored, and the M1
  test passes.

### Remaining findings (Minor)

**R1. Residual Full-uid trust, now with concrete evidence (documented M5; keep it on the Task 14
list).** With the sandbox user's ordinary rights (what any Full operation of any conversation on
the device has), I:
1. found the restricted task's channel by reading `/proc/<supervisor>/fd/3`, which points to
   `/skills/.capybara-ops/bg/<id>/<secret>`;
2. opened that magic link for writing and sent an `X` frame (exitCode 0);
3. got `exited, exitCode 0` from root's `bg-status`, and `bg-stop-plan` returned that exit instead
   of a signal target, while the restricted `sleep 300` kept running.

So a Full co-tenant can make another conversation's restricted background task report a fake exit
and escape stop and revocation. A Full task can do the same to itself through its parent's fds.

This is not a new class of access. The linuxkit kernel has no Yama, so the same uid can already
ptrace the supervisor or SIGSTOP the launcher, and the README says so. Two follow-ups:
- the test title "I1: no task can forge its background record"
  (`permission-scopes.test.ts:1086`) overclaims. It only tries file writes; rename it or add the
  FIFO case as a documented residual.
- cheap hardening: replace the FIFO with a root-bound UNIX socket. The recorder takes `P` only from
  a peer whose SO_PEERCRED pid equals the claimed pid, and `O`/`X` only on that connection.

**R2. A stop while the record is still `starting` can claim `lost` with no cancellation obligation**
(`capybara-operation.py` `bg_stop_plan` / `bg_stop_claim`, the 5 s waits). If the recorder has not
received `P` within 5 s (a slow `bg-start` after `bg-prepare`), the stop records `lost` in
`stop.json`. A later launch is not blocked: `admit` checks only tombstones and `.cancelled`
markers. Every later `stop` then returns the cached `lost` and kills nothing. Fix: when the claim
is made while the record is `starting`, also write the root `.cancelled` marker for the
operation's `opKey` (the supervisor re-admits before launching), or claim `stopped` only after the
marker is written. Low likelihood, because the kernel normally holds the reference only after the
start acknowledgement.

**R3. The legacy `writeFile` (and stat/read) does not refuse `/skills/.capybara-ops`.**
`provider.ts` `writeFile` writes any `/skills/...` path as root through
`/opt/capybara/skills`. The kernel's sandbox tools refuse `/skills` and skill sync uses validated
names, so this is defence in depth. Still, refuse the reserved prefix in the legacy file methods
too, because one kernel bug there would let root rewrite or delete tombstones.

**R4. The output spool moved from the bounded tmpfs `/tmp` to the persistent skills volume, which
has no size limit.** A background task's spool now survives restarts until `retainUntilMs` + 1 h,
which can be days, and only the host disk bounds it. The retained-output spec deliberately adds no
output quota, so this is not a contract violation. It is an operational change: a chatty background
task can fill the docker volume disk, and skills writes then fail. State it in the README, and
consider pruning on instance start as well as in `records()`.

**R5. Retry semantics across generations.** A consume record from a previous generation makes a
same-ID, same-input retry a `SandboxScopeValidationError` (the author notes this). The contract's
duplicate rule is OutcomeUnknown. A mismatch only on `generation`, with the same method and hash,
should map to OutcomeUnknown, so the kernel never reads it as an invalid request.

**R6. Nit:** in `full()`, an exception other than `Refused` (for example the "unexpected Full
access command" ValueError) falls through to the generic handler. That handler emits a refusal
frame without the nonce and exits 0, so the provider would report exit 0 with junk stdout. Only
provider-built argv can reach it; return 125 from that path as well.

### Tests run (re-review)

- `CAPYBARA_TEST_REQUIRE_LINUX_RESTRICTED=1 pnpm exec vitest run
  plugins/sandbox-docker/test/permission-scopes.test.ts --maxWorkers=2`: 26 passed, 1 skipped (the
  Docker-absent guard), including the 8 "review fix round 1" cases.
- `manifest`, `network`, `sandbox-docker`, `concurrent` and `list-scan` (Docker, `--maxWorkers=2`,
  run after the above, not at the same time): 5 files, 120 passed, 1 skipped (runsc).
- `pnpm lint` and `pnpm typecheck`: pass.
- Manual attacks on image `capybara-sandbox:test-7673ee467a64` (agent `d4089dd2…`, which matches
  `SHA256SUMS` at 142c948), hardened like the provider, with the skills volume mounted read-only at
  `/skills` and read-write at `/opt/capybara/skills`. The attacks are described above. The
  container and volume were removed afterwards.

## Re-review round 2 (commit cfbbb02, `git diff 142c948 cfbbb02`)

### Verdict: APPROVE (one Minor fail-closed follow-up recommended; nothing blocking)

R2 through R6 are fixed, and the R1 attack from round 1 no longer works. I tried to break the new
channel by hand in a container with the provider's hardening, using image
`capybara-sandbox:test-73330175879b` (agent `19a9bcfb…`, which matches `SHA256SUMS` at `cfbbb02`)
and the skills-volume layout (read-only `/skills`, read-write `/opt/capybara/skills`).

**R1 attack re-run (blocked).** I started a restricted background task, then scanned as a same-uid
process:
- no `/proc/*/fd` link names the records or a socket;
- `/proc/<supervisor>/fd` and `/proc/<supervisor>/mem` give `Permission denied`, because the
  supervisor set `PR_SET_DUMPABLE 0`, which fork inherits;
- with no Yama, ptrace attach is still refused by the non-dumpable check (same uid without
  CAP_SYS_PTRACE).

So frames can no longer be injected by reopening the supervisor's descriptor. Pid reuse is not
possible either: `SO_PEERCRED` fixes the pid at connect, and the start time is checked too.

**Remaining channel weakness (R7, Minor).** I ran this attack successfully:
1. `/proc/net/unix` is world-readable and lists every bound socket's `sun_path`, so it shows the
   channel's secret name in full (the socket is bound relative, so the entry is just
   `<secret>`).
2. The execution directory is `operationUuid(operationId)`. With both the UUID and the secret, a
   same-uid process connected first by running the real agent with a crafted request:
   `python3 -I /opt/capybara-runtime/capybara-operation.py bg-start` with `kind: device` and the
   command `sleep 401`. Its argv, peer pid, start time and non-root uid all pass, so the recorder
   bound it.
3. The real restricted supervisor (`sleep 402`) then connected. The recorder closed that
   connection, but `bg_supervise` ignores channel errors, so it still acknowledged `started:true`
   and launched.
4. Result: the record and `bg-stop-plan` target the attacker's pid (`signal:{pid:61}`), while the
   real restricted work runs unrecorded and cannot be stopped.

Preconditions:
- The attacker must know the execution UUID. Nothing inside the sandbox reveals it: background
  starts have no control path, and the agent argv and the socket path entry do not contain it.
- The attacker must win the short window between `bg-prepare` and the supervisor's connect.

This is defence in depth and not blocking. The current kernel does not yet consume these
references, so whether the UUID can leak (through tool output or task listings) is a kernel-side
fact to settle in Task 14.

Fix (cheap):
- (a) Fail closed. After its P frame, the supervisor waits for a one-byte acceptance from the
  recorder on the same connection. If the connection is refused or closed, it does not acknowledge
  or launch (it refuses with INVALID_REQUEST). An attacker then only causes a failed start, never
  unrecorded work.
- (b) Optionally, put a second random token in the P frame and check it: the token is delivered on
  stdin like the secret, but it never appears in a path, so `/proc/net/unix` does not show it.

**R2 to R6 and the hook check:**
- **R2:** when the stop claim finds the record still `starting`, it writes `.cancelled` for the
  record's `opKey` and marks the record lost. A late supervisor is refused by `admit` (in
  `bg_start` and again before launch); the R2 test covers this. Cosmetic: the recorder's
  in-memory state is still `starting`, so a late P frame can move the file from `lost` to
  `running` and then to `exited`/refused. Nothing launches, and `stop.json` keeps `lost`.
- **R3:** `checkPath` refuses `/skills/.capybara-ops` and below for `readFile`, `writeFile` and
  `stat`, including the root-run skills write.
- **R4:**
  - the spool is capped at 64 MiB per execution; the record notes `outputTruncated`, and
    `outputPath` still receives everything;
  - the root `init` step runs at create, at resume (only when the container was not running) and
    after the restart fallback; it runs `records()`, which prunes;
  - the README states the operational change.
- **R5:** a record with the same method and input is a duplicate in any generation, giving
  OutcomeUnknown. A duplicate background start returns the old-generation reference, which then
  reads as `lost`, never as a re-run.
- **R6:** any exception in `full()` emits a refusal frame that carries the nonce, and the process
  exits 125.
- **Test hooks:** `backgroundSpoolCapBytes`, like the other test hooks, exists only on
  `DockerSandboxTestOptions`. `index.ts` passes `{}` to `createDockerSandbox`, and the strict
  deployment schema rejects extra keys. The agent also validates `0 < cap <= 64 MiB`.

**Residual (M5, unchanged, for Task 14):**
- Full-access work shares the device uid. It can SIGSTOP or kill sandbox-user processes, including
  supervisors, and it can ptrace the restricted launcher and broker of another conversation:
  `execve` resets the launcher to dumpable, and there is no Yama.
- The launcher could set itself non-dumpable as well; that belongs to the launcher review.

### Tests run (re-review round 2)

- `CAPYBARA_TEST_REQUIRE_LINUX_RESTRICTED=1 pnpm exec vitest run
  plugins/sandbox-docker/test/permission-scopes.test.ts --maxWorkers=2`: 32 passed, 1 skipped (the
  Docker-absent guard), including the 6 "review fix round 2" cases. I ran it twice.
- `manifest`, `network`, `sandbox-docker`, `concurrent` and `list-scan` (Docker, `--maxWorkers=2`,
  run after the above): 5 files, 120 passed, 1 skipped (runsc).
- `pnpm lint` and `pnpm typecheck`: pass.
- Manual attacks as described above. The container and volume were removed afterwards.
