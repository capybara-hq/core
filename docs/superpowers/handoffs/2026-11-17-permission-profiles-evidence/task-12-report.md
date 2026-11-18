# Task 12 report: Docker provider integration under unchanged hardening

Status: DONE_WITH_CONCERNS. Commit `6f2e3e3` on `feat/sandbox-docker-permission-scopes`
(plugins worktree `/Users/grant/Capybara/plugins/.claude/worktrees/feat-sandbox-docker-permission-scopes`,
from plugins `main` 05d00a9). Not pushed, no PR.

## What was built

Published packages installed normally from npm: `@capybara-hq/plugin-sdk` 0.1.0-rc.27 (root override
and plugin dep), `@capybara-hq/testing` 0.1.0-rc.21 (kernel rc.37), `@capybara-hq/plugin-tools`
0.1.0-rc.16. No file/link/workspace references.

- `src/runtime-source.ts`: bundle v2 check, the SDK digests recomputed from the shipped bytes, the
  agent's pinned SHA-256, `SHA256SUMS` generator.
- `image/runtime/`: `native-files.py` and `linux-sandbox.py` byte-for-byte from
  `SANDBOX_RUNTIME_SOURCE` (601f51c1…, 64f0c6f3…), the provider's consumer `capybara-operation.py`,
  `SHA256SUMS`. `image/Dockerfile`: `COPY --chown=0:0 runtime/ /opt/capybara-runtime/` +
  `sha256sum -c SHA256SUMS`, dir 0755 / files 0644. Nothing else in the container profile changed.
- `capybara-operation.py` (trusted consumer, never decides authority): pins each existing granted
  root once (O_NOFOLLOW, canonical via /proc/self/fd; a swapped root refuses), runs the launcher
  (exec or native mode) on those same descriptors, frames stdout/stderr/result, re-verifies the SDK
  digests and root ownership before each restricted launch, a per-operation loopback allowlist
  forwarder (CONNECT / absolute http:// → CONNECT tunnel through the instance egress proxy, only
  this operation's broker may reach its port), PDEATHSIG(SIGTERM) on the launcher + `reap` of the
  recorded session, exact cancel by control path (SIGTERM → launcher tree kill, then SIGKILL),
  root-only durable records (`/tmp/.capybara-ops`, 0711/0600: consume, tombstones), background
  supervisor (pid+start-time record before ack, spool + scoped `outputPath`, status/tail/read/stop
  with once-claimed stop outcome).
- `src/operations.ts`: `permissionSupport` (staged owner/mode/digest check + launcher `probe`, run
  only in an already running instance), `operation` (parse/freeze scope; consume before effects;
  Full = device+environment only → ordinary wrapper behind an admission check; restricted exec and
  native through the launcher; read-only scopes on pinned descriptors after the launcher's static
  support check), `browse`, `prepare` (skills only under /skills, as root via the writable skills
  mount, files 0644; attachments only under /workspace/attachments/<x>, as the sandbox user),
  `revokeOperation` (tombstone, then exact kill incl. background), `background`
  (start idempotent per generation/operation, status/tail/readOutput ≤65,536/stop; never
  starts/resumes the instance).
- `src/provider.ts`: wiring/transport, `execWith` refactor; killTagged/killAll first SIGTERM
  restricted agents so the launcher ends its whole tree (a SIGKILL of the supervisor would orphan
  restricted descendants). `src/docker-api.ts`: `agent: false` (see concerns). Manifest `sdk`
  → `^0.1.0-rc.27`. README section "Permission profiles (operation contract)". Changeset (minor).
- No instance policy mutation, no new execution container, no capability/seccomp addition or
  relaxation, no privileged mode (asserted in the test).

## RED → GREEN

- RED (before staging, image without runtime): `pnpm exec vitest run plugins/sandbox-docker/test/permission-scopes.test.ts --maxWorkers=2`
  → 8 failed / 1 passed / 6 skipped (staging/digest/Dockerfile unit cases; hardening runtime stat;
  probe; preparation; browse; mutant image). The conformance case passed only through its
  fail-closed branch (support reported restricted unavailable, restricted exec refused).
- Mutant proof: routing restricted exec to the Full path made the conformance fail
  ("restricted reads must not reach the sibling").
- GREEN, evidence mode `CAPYBARA_TEST_REQUIRE_LINUX_RESTRICTED=1`: 18 passed, 1 skipped (the
  "Docker is required" guard, which only runs when Docker is absent); log
  `task-12-docker-require-run.log`. Repeated 3× after the keep-alive fix: 18/1 each.
- Full plugin suite, sequential (`--maxWorkers=1 --no-file-parallelism`): 10 files, 256 passed,
  2 skipped (runsc, guard) — listing, network, egress, concurrent, lifecycle, manifest, kernel smoke,
  dual-replica, permission (`task-12-sandbox-docker-suite.log`).
- Every other plugin (`--exclude **/sandbox-docker/** --maxWorkers=2`): 138 files passed, 10 skipped;
  2037 passed / 174 skipped (`task-12-other-plugins.log`).
- `pnpm lint`, `pnpm typecheck`, `pnpm check` (all capybara-plugin checks, icons, skills),
  `pnpm check:marketplace`, commitlint: pass. Full `pnpm verify` not run as one command (it would
  re-run every Docker suite in parallel on the shared machine); its parts were run as above.

Test cases in `test/permission-scopes.test.ts`: staged bytes = SDK; agent digest + SHA256SUMS;
Dockerfile copy/check; hardening unchanged (CapDrop ALL, no CapAdd, no-new-privileges, read-only
root, not privileged, NetworkMode none, PidsLimit, Seccomp mode 2, runtime root-owned and not
writable); support from the launcher's own probe; `runSandboxPermissionConformance` on the actual
provider (shell/Python/Node/curl positive controls, sibling/symlink/protected denials, network
allow/deny incl. IPv6, loopback-only bind, UNIX sockets under every network kind, Full controls,
both overlap orders, component + root swaps, mutable sockaddr/chmod pointer races, exact
cancellation and timeout of detached descendants, narrowing); Full vs restricted (Seccomp_filters
1 vs more, setsid allowed vs denied, outside write allowed vs denied); forwarder through the real
egress proxy (allowed host 200, other host 403, egress proxy not directly reachable, none reaches
nothing, environment keeps the instance network); consume-once / mismatch / expired; revoke before
launch and while running (restricted and Full, siblings survive); killTagged tree kill; preparation;
browsing; background (idempotent start, status, tail, positional reads, bounds, foreign ref,
natural exit, sibling, outside outputPath, Full + revocation, stopped instance never started);
digest-mutant image fails closed (restricted null, Full unavailable, restricted exec refused).

## Runtime evidence

Docker 29.9.3 linux/arm64 (Docker Desktop), kernel `Linux 7.0.14-linuxkit aarch64`, Landlock ABI 8,
`SecurityOptions` seccomp builtin + cgroupns, runc; image `capybara-sandbox:test-*`
`sha256:8ff79df9f1f79688fdbe5025f68da2699b848edd1f8c8d24ab1a8cf8562a4639` arm64 (built from
`image/`). Report: `{restricted: all four true, fullAccess: true, background: true}`. x86_64 not
run here (no amd64 host); the launcher's own VALIDATED_ARCHES/probe decide there; gVisor (runsc)
not registered here — the probe's Landlock check makes it unavailable, untested.

## Concerns / limitations

1. Harness/contract inconsistency (core): `runSandboxPermissionConformance` needs a numeric
   `granted.host` (its pointer-race program calls `inet_aton(host)`) and puts it in the allowlist,
   but `parseSandboxOperationScope` (validateAllowHost) refuses IP literals. The fixture maps the
   numeric host to a test name `granted.permission.example`, which the provider maps to the
   127.0.0.1:18080 endpoint through the test-only `permissionTestEndpoints` option (direct broker
   endpoint + NO_PROXY). Production allowlists use only the forwarder; the forwarder is covered by
   its own real-egress test, not by the conformance suite. Also: the harness hangs forever on a
   rejected operation inside `waitFor` (no failure path) — that is how the keep-alive bug surfaced.
2. Latent provider bug fixed outside the listed files: `docker-api.ts` reused Node keep-alive
   connections that the socket proxy (HAProxy `timeout http-request` 30 s) had closed → "socket hang
   up" after ≥30 s idle (reproduced: `task-12-keepalive-hang-repro.log`). Now one connection per
   request. No dedicated regression test (it needs a ≥30 s idle wait).
3. Scope widened by the dependency move: the root `pnpm.overrides` pins one SDK, and kernel rc.32
   (testing rc.19) fails to start with SDK rc.27, so every plugin moved to testing rc.21 and its
   kernel tests now switch model-fake on per org (`enableModelProviders` / extension PUT, kernel rc.37
   behaviour); the sandbox dual test calls `FetchAttachment` (rc.37 no longer syncs attachments).
4. Background/control records live in the instance's `/tmp`: the root-only op records are
   trustworthy; background status/spool under `/tmp/.capybara-bg` are owned by the sandbox user —
   Full access work (same OS user) could rewrite them, restricted work cannot unless a scope grants
   `/tmp`. Records end with the instance (new generation). A paused (`docker pause`) container is
   treated like a stopped one (`lost`), no pending-cancel persisted outside the container.
5. Restricted exec needs at least one existing writable root (launcher requirement) → scope-denied
   otherwise; missing roots grant nothing and are left out. ssh-over-SOCKS (`GIT_SSH_COMMAND`) is not
   forwarded under a restricted allowlist. Foreground duplicates always return OutcomeUnknown (no
   stored results).
6. Kernel side unreleased: protocol/facade activation (Tasks 6/8) and kernel use of
   `operation`/`prepare`/`background` are not published; the provider is tested directly against
   the published SDK contract. The image must be republished (images workflow) for production use;
   older images report everything unavailable.
7. Process note: once during the work a `git stash` briefly reverted tracked files while a Docker
   run was in progress; that run was discarded and all evidence above is from later runs.

## Fix round 1 (independent review CHANGES_REQUIRED)

Commit `142c948` (fix(sandbox-docker): keep operation records out of the sandbox user's reach), on
top of `6f2e3e3`. No `git stash` used.

RED first, in the hardened container (current image, provider hardening): new describe "review fix
round 1" → 6 failed / 2 passed (`task-12-fix1-red.log`): I1 `/tmp` write root accepted; I1 a Full
background task forged its record and survived revoke (child pid alive); I2 a Full start revoked
before launch still ran (`ran` written); I3 a revoked operation ran after a container restart;
M1 a Full command's fake refusal frame was reported as refused; M3 a pre-created
`/tmp/.capybara-ops` disabled operations. (The early-stop case and the new forwarder cases passed
on the old code: the race needs the new barrier hook; the forwarder cases are coverage.)

Fixes:
- **I1**: every trusted record (consume records, tombstones, cancellation markers, background record,
  output spool, stop claim, channel) lives in `/opt/capybara/skills/.capybara-ops` (root, 0711 dirs,
  0600 records) on the persistent skills volume, written only by root steps; the agent checks
  markers through the read-only `/skills/.capybara-ops`. Per background execution a detached
  **root** recorder owns record/spool and is fed by the sandbox-user supervisor through a FIFO whose
  random name arrives on stdin only (0622, unlistable dir). Stop = root plan → sandbox-user pidfd
  signal of the recorded supervisor (start time checked) → root claim (O_EXCL). `<ctl>.kill` files
  are gone (root cancellation markers instead). Defence in depth: restricted write roots that
  contain or lie inside the records or the Full wrapper's `/tmp/.capybara-exec-*` files (`/`, `/tmp`,
  `/skills`, `/opt`, `/opt/capybara`…) and read roots inside the records are refused, in Node and when
  the agent pins; prepare paths inside the records are refused.
- **I2**: the supervisor blocks SIGTERM/INT/HUP before reporting itself, acks, (test barrier), re-runs
  `admit` (tombstone, cancel marker, deadline), installs handlers, launches (children unblock in
  preexec; Full children under `timeout -s KILL`), then unblocks so a pending stop is delivered with
  the child known.
- **I3**: tombstones/consume records persist across restarts (skills volume); `revokeOperation`
  writes the tombstone, kills foreground work and the background execution, then rewrites the
  tombstone and throws (kernel retries) if the instance generation changed. Agent cancel waits
  ≤12 s; killTagged does one graceful pass for all tags; the operation kill script no longer stacks
  two graceful waits — all inside killOrRestart's 15 s.
- **M1** per-call nonce in `CAPYBARA_ADMISSION_NONCE`, popped by the agent before exec, required on
  the refusal frame. **M2** tests: `--proxytunnel` CONNECT with `*.example.com`, an allowlisted name
  the instance network refuses (no 200), and another operation (none and allowlist) cannot connect to
  a live operation's forwarder port; README states raw TCP clients don't work under allowlist.
  **M3** solved by the move (the sandbox user cannot create anything there). **M4** no more ctl.kill
  files. **M7** comment fixed. **M5** recorded in README as residual (Full shares the uid: it cannot
  change root records but can signal/inspect sandbox-user processes incl. the supervisor's channel
  via /proc) — for Task 14. **M6** for core. Fixture TODO references the two core testing bugs.
- Test-only hooks added: `backgroundLaunchBarrier(taskId)`, `afterRevokeKill(operationId)`.

GREEN:
- `CAPYBARA_TEST_REQUIRE_LINUX_RESTRICTED=1 … permission-scopes.test.ts --maxWorkers=1`: 26 passed,
  1 skipped (Docker-absent guard) — `task-12-fix1-require-run.log`. Runtime unchanged: Linux
  7.0.14-linuxkit aarch64, Landlock ABI 8, Docker 29.9.3, image
  `sha256:52261ae6c240526ac1630866a4e0a12a7bc2423bb78292895c2a3304145ca7d9` arm64.
- Whole plugin, sequential: 10 files, 264 passed, 2 skipped (runsc, guard) —
  `task-12-fix1-sandbox-docker-suite.log`. Other plugins unchanged in this round (not rerun).
- lint, typecheck, `pnpm check`, commitlint: pass.

Remaining limitations: records on the skills volume show up as the name `.capybara-ops` in `/skills`
listings (content unreadable); consume records of a previous generation make a same-ID retry a
validation error rather than a re-run; Full-uid residual trust (M5).

## Fix round 2 (re-review round 1 minors R1–R6)

Commit `cfbbb02` (fix(sandbox-docker): bind background channels to their supervisor), on top of
`142c948`. No `git stash` used.

RED first in the hardened container (describe "review fix round 2"): 6 failed
(`task-12-fix2-red.log`): R1 the reviewer's attack (same-uid write of an `X` frame through
`/proc/<supervisor>/fd`) turned root status into `exited 0` while the task ran; R2 a late
supervisor launched after a stop claimed `lost` for a `starting` record; R3 legacy `writeFile`
wrote `/skills/.capybara-ops/x` as root; R4 spool not capped (5001 vs cap 1000) and no prune on
start; R5 same-input retry after a restart was `SandboxScopeValidationError`; R6 a non-Refused
`full()` failure exited 0 without the nonce.

Fixes:
- **R1**: the channel is a root-owned UNIX socket (bound relative in the record dir, 0622). The
  recorder accepts frames only on the one connection whose `SO_PEERCRED` pid equals the claimed
  supervisor pid, with matching start time, non-root uid and argv `capybara-operation.py bg-start`;
  other connections are dropped, later ones refused. The supervisor connects itself (so PEERCRED
  names it) and the `bg-start` process sets `PR_SET_DUMPABLE 0` before reading its request, so
  same-uid processes cannot read the channel name or reopen descriptors via /proc. The old test is
  renamed "I1: file writes (even with Full access) cannot change the root-owned records; revocation
  stops the task"; the new R1 test runs the reviewer's /proc injection and requires `running`, then
  `stopped` with the task dead.
- **R2**: when a stop claim finds the record still `starting`, root writes the `.cancelled` marker
  for the record's `opKey` and marks the record `lost`; a late `bg-start` is refused by `admit`.
- **R3**: provider `readFile` / `writeFile` / `stat` refuse `/skills/.capybara-ops` and below.
- **R4**: per-execution spool cap 64 MiB (record notes `outputTruncated`; `outputPath` still gets
  everything); root `init` step at create, resume and the restart fallback runs `records()`, which
  prunes expired records/spools and previous-generation records past retention. README documents
  the spool on the persistent skills volume as an operational change.
- **R5**: same method + input under the ID is a duplicate in any generation → OutcomeUnknown.
- **R6**: any exception in `full()` emits a nonce-bearing refusal frame and exits 125.
- Test-only hook added: `backgroundSpoolCapBytes(taskId)`.

GREEN:
- REQUIRE mode permission suite: 32 passed, 1 skipped (Docker-absent guard)
  (`task-12-fix2-require-run.log`). Runtime: Linux 7.0.14-linuxkit aarch64, Landlock ABI 8, Docker
  29.9.3; test image `capybara-sandbox:test-73330175879b` (`9301eb80471d`) arm64.
- Whole plugin sequential: 10 files, 270 passed, 2 skipped (`task-12-fix2-sandbox-docker-suite.log`).
- lint, typecheck, `pnpm check`, commitlint pass. Other plugins unchanged in this round.

Residual (M5, Task 14): Full-access work shares the device uid and can still signal (stop/freeze)
sandbox-user processes including supervisors; it can no longer forge records or channel frames.

## Fix round 3 (re-review round 2: R7 + testing rc.22 / SDK rc.28 migration)

Commit `8bf494b` (fix(sandbox-docker): accept a background channel only for its own supervisor),
on top of `cfbbb02`. No `git stash` used.

RED first (`task-12-fix3-red.log`): new test "R7: a same-uid process that connects first never
captures the record" — the attacker reads the socket name from `/proc/net/unix` and runs the real
agent's `bg-start` with a forged request between `bg-prepare` and the real supervisor's connect
(test-only hook `beforeBackgroundLaunch`); before the fix the attacker's command launched under the
record.

Fixes:
- **R7(a)** after its P frame the supervisor waits (≤30 s) for a one-byte `A` from the recorder on
  the same connection; refused/closed → it exits without acknowledging or launching.
- **R7(b)** a second random token (stdin only; never in a path, argv or env) must be in the P frame
  (constant-time compare); `/proc/net/unix` shows only the socket name.
- **R2 cosmetic** the recorder refuses a P frame when the root `.cancelled` marker exists, so a
  cancelled record never turns `running`; the R2 test now also asserts status stays `lost`.
- **Migration** `@capybara-hq/testing` 0.1.0-rc.22 (all plugins' devDeps), `@capybara-hq/plugin-sdk`
  0.1.0-rc.28 (root override and plugin dep; manifest `sdk: ^0.1.0-rc.28`). rc.28's
  `linux-sandbox.py` differs only by a comment (the /proc read-root limitation, M6); restaged, new
  digest `f27ab699…`, SHA256SUMS regenerated. The conformance now runs with
  `endpoints.access: "proxy"`: the granted endpoint is a counting service outside the device on the
  sandbox network, reached by its allowlisted name only through the operation's forwarder and the
  real instance egress proxy (pinned by the existing `egressTestHosts`); ungranted endpoints listen
  on the device loopback (Full reaches them directly). The test-only `permissionTestEndpoints`
  option, the agent's direct-endpoint code path, the name-rewrite workaround and the TODO are removed.

GREEN:
- REQUIRE-mode permission suite: 33 passed, 1 skipped (Docker-absent guard)
  (`task-12-fix3-require-run.log`). Support report: all four restricted claims, fullAccess and
  background true; Linux 7.0.14-linuxkit aarch64, Landlock ABI 8, Docker 29.9.3, image
  `sha256:694d8a086cc6dd85c540465e205d8ae17a609337155b9ffcee42823d597a3dc0` arm64.
- Whole sandbox-docker plugin, sequential: 10 files, 271 passed, 2 skipped
  (`task-12-fix3-sandbox-docker-suite.log`).
- Every other plugin (2 workers): 138 files passed, 10 skipped; 2052 passed / 174 skipped
  (`task-12-fix3-other-plugins.log`).
- lint, typecheck, `pnpm check`, `check:marketplace`, commitlint: pass.
