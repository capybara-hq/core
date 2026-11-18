# Task 2b — restricted Linux runtime source and permission evidence

Worktree `/Users/grant/Capybara/core/.claude/worktrees/perm-t2b`, branch `perm/t2b`, base `a5185eb77`.
Commit: `95395bf47 feat(sdk): restricted Linux runtime source and permission conformance`. Not pushed, no PR.
Docs (held wording) untouched.

## Environment of the evidence (exact)

- Docker Desktop 29.9.3 (client/server), default runtime runc, daemon security options
  `seccomp,profile=builtin` + `cgroupns`. Kernel `7.0.14-linuxkit`, aarch64. Landlock ABI reported: 8.
- Image `ghcr.io/capybara-hq/capybara-sandbox:0.1.0-rc.15`, id/digest
  `sha256:0473fbbcd51f461217d615b374f65a036caecf3457c455beff6577d08b66e930` (Python 3.13.5, Node 22.23.5,
  gcc, curl). Overridable with `CAPYBARA_TEST_SANDBOX_IMAGE`.
- Container flags (asserted by the test from `docker inspect`): `--user 1000:1000 --cap-drop ALL
  --security-opt no-new-privileges --read-only --network none`, no CapAdd, not privileged, Docker's default
  seccomp (`/proc/self/status` Seccomp: 2 as UID 1000). tmpfs: `/tmp`, `/home/sandbox` (uid 1000),
  `/workspace` (uid 1000, exec), `/opt/capybara-runtime` and `/opt/capybara-receipts` (root-owned 755).
  No seccomp/capability/user-namespace relaxation anywhere. The two fail-closed cases add a *stricter*
  outer seccomp filter (deny Landlock syscalls / deny SECCOMP_FILTER_FLAG_NEW_LISTENER).
- Runtime bytes are staged root-owned from `SANDBOX_RUNTIME_SOURCE` and their SHA-256 verified inside the
  container (`sha256sum`) before use. Commands run as UID 1000 through a test-only in-container agent
  (`packages/testing/test/fixtures/linux-permission/agent.py`) that pins roots and launches the runtime;
  it stands in for a provider and is **not** the Docker provider.
- Controlled endpoints (`listen.py`) run as root inside the container: granted `127.0.0.1:18080`,
  ungranted `127.0.0.1:18081` and `[::1]:18082`; receipts are counted in root-owned files.

## Commands and results

- `pnpm exec vitest run packages/testing/test/sandbox-linux-runtime.test.ts --reporter=verbose`
  → **14 passed (14)**, 44.5 s. Log: `task-2b-docker-evidence.log`. Stability after the race fix below:
  5 consecutive runs, **14/14 each**.
- `pnpm exec vitest run packages/plugin-sdk/test packages/testing/test/sandbox-native-conformance.test.ts
  packages/testing/test/sandbox-native-helper.test.ts packages/testing/test/sandbox-permission-conformance.test.ts
  --reporter=verbose` → 1174 passed, 1 failed: the existing 2a test `sandbox-native-helper.test.ts >
  executes ordinary native semantics …` times out at 5 s. It fails identically on the controller branch
  (`docs-conversation-permission-profiles` @ `239351676`, run alone) with machine load average ~30 from
  other sessions; unrelated to 2b (the file and the native source are unchanged). Log: `task-2b-focused-unit.log`.
- `pnpm typecheck` → exit 0. `pnpm check:sdk-api` → passed. `pnpm check:sdk-api-changeset --base a5185eb77`
  → passed. `pnpm check` → All checks passed (incl. Test portfolio). `pnpm exec biome check
  packages/plugin-sdk packages/testing vitest.config.ts .changeset` → clean. `pnpm gen:sdk-api` → no snapshot
  change (the exported type is unchanged; only the bundle contents/version changed).

### RED → GREEN record

- SDK bundle test: expectations moved to version 2 with `linux-sandbox.py` (name/digest/freeze, no Node
  imports, validated-arch and no-root-reopen static checks).
- The Docker tests were developed against a scratch launcher first; each mechanism case was red before its
  behavior existed (e.g. native mode could not read the runtime dir until it became a read rule; `chown`
  with 6-tuple args returned EACCES; listener-less launch reported `launch` before refusing).
- **Flake found and fixed (product bug):** 2 of ~8 runs failed `granted endpoint must work` with EACCES.
  Cause: the broker recorded ownership of a brokered socket *after* `SECCOMP_IOCTL_NOTIF_ADDFD|SEND` had
  already returned the alias to the target, so an immediate `connect` from another thread found no owned
  socket. Reproduced deterministically by widening the window (50 ms delay after ADDFD): old ordering →
  `PermissionError: [Errno 13]`, new ordering (record before ADDFD) → `connected`
  (`task-2b-socket-ownership-race-repro.log`). After the fix: 5/5 full runs green.
- **Mutation proofs (committed tests):** three deliberately broken launchers are staged and each is
  detected: (1) no `landlock_restrict_self` → sibling write lands; (2) launcher reopens the root pathname
  (the pre-correction behavior) → a root swapped between pinning and launch sends the write into the
  sibling; (3) broker double-fetches the sockaddr before connecting → the pointer race reaches the
  ungranted endpoint. The real launcher passes the same scenarios.

## Acceptance inventory

### 1. Same pinned launch roots across OS rules / native helper / metadata — **proven (this kernel)**
- The consumer pins each root once (`O_RDONLY|O_DIRECTORY|O_NOFOLLOW`) and passes `{path, fd, dev, ino}`.
  The launcher only `fstat`s/`readlink`s those descriptors, refuses `ROOT_CHANGED` when the identity or
  current location differs, adds the Landlock `path_beneath` rules with those fds, gives the same fds to
  the broker's resolver (`NativeFiles` from `native-files.py`) and to the native helper (native mode).
- Evidence: launch record roots/fds/dev/ino equal the consumer's pinned values; `ruleFds == brokerFds`,
  native `nativeFds == ruleFds`; cwd identity == pinned root identity. Root swapped between pin and
  launch → `ROOT_CHANGED`, nothing written; wrong recorded identity → `ROOT_CHANGED`. Root swapped while
  an operation runs → the live command stays on the original object (`in-place` written in the moved
  root), writes through the swapped path are denied, a fresh operation is refused. Mutation (2) shows the
  escape the correction prevents.
- Caveat: the fd equality is the launcher's own launch record; the behavioral proof is the swap tests
  and the mutation.

### 2. Linux broker and complete syscall/ABI/resource inventory — **partly proven; gaps listed**
Proven on aarch64 (inventory test + conformance):
- Brokered with copied inputs, resolved from the pinned write roots (never CONTINUE on a pointer):
  `socket` (AF_INET/6 created and owned by the broker, alias injected), `connect`, `listen`;
  `fchmod`/`fchmodat`/`fchmodat2`, `fchown`/`fchownat`, `utimensat`, `setxattr`/`lsetxattr`/`fsetxattr`,
  `removexattr`/`lremovexattr`/`fremovexattr` (fd forms checked by identity). Read-only root and sibling:
  fchmod/fchown/utime/setxattr/chmod/O_PATH+`fchmodat2(AT_EMPTY_PATH)`/O_PATH `fchownat` → EACCES;
  own files → allowed.
- Landlock (ABI ≥ 6 required, all fs rights handled, TCP connect handled, abstract-unix and signal
  scopes): content read/write/exec, truncate, rename out, rename of the root, hardlinks (EXDEV), O_PATH
  reopen via `/proc/self/fd` (EACCES), `kill`/`/proc/$PPID/environ`/`/proc/$PPID/mem`/`/proc/1/root` of the
  supervisor (denied).
- Seccomp filter: foreign arch → kill; x32 bit → ENOSYS; any syscall > 469 → ENOSYS; io_uring*,
  userfaultfd, setxattrat/removexattrat/file_setattr → ENOSYS; `setsid` → EPERM; TIOCSTI/TIOCLINUX,
  FS_IOC_SETFLAGS/FSSETXATTR/SETVERSION and fscrypt policy/key ioctls → EPERM; families other than
  UNIX/INET/INET6/NETLINK_ROUTE → EAFNOSUPPORT (packet, vsock tested); UDP/raw inet, SCTP/MPTCP, unix
  dgram → EACCES; `MSG_FASTOPEN` on sendto/sendmsg/sendmmsg → EACCES. Unix bind/listen, TCP listen and
  socketpair still work.
Not proven / gaps:
- **Metadata reads outside the roots are not mediated**: stat/statx/access/readlink/getxattr/listxattr/
  statfs, inotify/fanotify marks and `/proc/<pid>/cmdline` of other processes reveal names, sizes, times
  (not contents). Open item.
- **x86_64 is not validated**: its table exists but `VALIDATED_ARCHES = ("aarch64",)`, so the probe and
  launch report restricted unavailable on x86_64 (fail closed). Other arches likewise.
- **Resource bounds not proven**: one broker thread per notification; unconnected brokered sockets are
  held until connect completes, `listen`, or operation end (a restricted process can exhaust its own
  broker's fds/threads — self-DoS only, unmeasured). Brokered calls cost ~ms (3000 chmods fine; 20000
  under load exceeded 60 s).
- AF_UNIX pathname/abstract `connect` is denied in restricted mode (compat limitation). Relative paths
  with `..` are normalized lexically by the broker (always within write roots, semantics can differ).
  `fchmod` on a root directory itself via fd is denied (path form allowed).

### 3. Mutable-input and root/component race proof — **proven for the tested races**
- C program (`flip.c`, gcc in the image), one thread rewriting the sockaddr port in a loop while another
  connects: Full control reaches the ungranted endpoint (exploratory run: 707 receipts of 3000); restricted
  with the granted endpoint allowlisted: ungranted receipts unchanged (exploratory: ok=1618 fail=1382,
  0 ungranted). chmod path flipping between an in-root file and the sibling: in-root chmods succeed,
  sibling mode unchanged (exploratory: 15025 ok of 20000; committed test 3000).
- Python ctypes variant inside the generic harness (1500 connects, 3000 chmods): same invariants.
- Component swap: `renameat2(RENAME_EXCHANGE)` loop swapping `race/dir` with a symlink to the sibling
  (>1.6 M swaps in the exploratory run) during 30 native writes + 30 native reads and 400 shell
  write/read/chmod rounds: nothing appeared in the sibling, secret never read, mode unchanged.
- Double-fetch mutant detected (see above). Not separately raced: the utimensat/xattr/chown handlers
  (they share the chmod resolution path).

### 4. Real positive native/shell/network controls — **proven**
Shell (cat, write, mkdir -p, chmod, `touch -d`, `ln -s`), Python and Node file work inside the root;
native write (parents created) / read / stat / list; Python, curl and Node connections to the granted
endpoint (+3 receipts exactly); network `none` refuses even the granted endpoint.

### 5. Cross-scope isolation, revocation, cancellation under unchanged hardening — **proven within scope**
- Both overlap orders with a live Full operation (Full has no restricted filters: it reads/writes the
  sibling and reaches an ungranted endpoint) — restricted stays denied.
- A broader restricted operation keeps its grant while a concurrent narrower one (`writeRoots` =
  `root/narrow/keep`) is denied outside; the next fresh narrowed operation is enforced (exec + native).
- Cancellation: subshell background, `nohup`, `setsid` attempt and a double-fork with `setpgid` all end
  on abort (supervisor is subreaper; tree walk + `pidfd_send_signal`), while a sibling operation survives
  and completes; timeout ends the tree; survivors are killed when the main command exits.
- Not proven: kernel-driven ceiling revocation end to end (Tasks 6/8/12); `SandboxBackground`
  start/status/stop references are not part of this source; SIGKILL of the supervisor itself leaves
  grandchildren orphaned (still Landlocked; brokered syscalls then fail with ENOSYS) — providers must
  stop with SIGTERM.

### Fail closed — **proven**
Without Landlock or without a seccomp listener (stricter outer filter), the probe reports
`restricted: null` with a reason, exec launch is refused `UNAVAILABLE` before any command runs, and the
harness's unsupported path (restricted operations must throw `SandboxPermissionUnsupportedError`) passes.

## Files

- `packages/plugin-sdk/src/sandbox-linux-runtime-source.ts` (new, static Python source string)
- `packages/plugin-sdk/src/sandbox-runtime-source.ts` (bundle version 2, adds `linux-sandbox.py`)
- `packages/plugin-sdk/test/sandbox-runtime-source.test.ts`
- `packages/testing/src/sandbox-permission-conformance.ts` (new: `runSandboxPermissionConformance`,
  `SandboxPermissionFixture`, `SandboxPermissionGrant`, `SandboxPermissionEndpoint`), `src/index.ts`
- `packages/testing/test/sandbox-permission-conformance.test.ts` (harness self-tests, no Docker)
- `packages/testing/test/sandbox-linux-runtime.test.ts` (Docker evidence; skips with a reason)
- `packages/testing/test/fixtures/linux-permission/{agent.py,docker.ts,listen.py,outer-deny.py,flip.c}`
- `vitest.config.ts`: new `testing-container` project (checked-in list, 240 s/300 s bounds like
  kernel-container), excluded from `node`.
- `.changeset/linux-restricted-runtime-source.md` (plugin-sdk minor, testing minor)

## Limitations / for the controller

- Evidence is the SDK runtime under a test transport on one aarch64 Docker Desktop kernel; it is not the
  Docker provider (Task 12), not E2B, not local Linux, not x86_64.
- CI runs on x86_64: there the probe reports unavailable and the Docker tests exercise only the
  fail-closed paths (mechanism tests skip with `context.skip`). CI also needs the image pull; without
  Docker the file skips with its reason in the describe title.
- Plan/spec wording ("held") left for the controller to update.

## Fix round 1

Commit `af124224c fix(sdk): confine UNIX sockets, loopback binds and lost supervisors` (on top of
`95395bf47`), branch `perm/t2b`. Same hardened container and image as above; nothing relaxed.
The review is `task-2b-independent-review.md`.

### RED (before the fix)
- `task-2b-fix1-red.log`: the new tests on the round-0 launcher fail:
  - inventory: `unix-raw`, `bind-any`, `bind6-any` and `abstract-bind` were ALLOWED (I1, M1);
  - conformance: `127.0.0.1=ok ::1=ok 0.0.0.0=ok ::=ok` (M1);
  - SIGKILL of the supervisor: the request hung until the 240 s bound with orphans alive (I3);
  - the probe had no `validated` field.
  Docker's own profile already returned EPERM for keyctl/unshare, so M3 could not be shown red
  in Docker. It is proven by the BPF-interpreter SDK test instead.
- `task-2b-fix1-red-unix-environment.log` (I2): with network `environment`, the round-0 launcher
  connected to a stream service in the sibling directory and the server logged an accept. The
  fixed launcher returns EACCES.
- M4: the mutant that closes only fds below 1024 leaks fd 1500 (committed mutation test). The
  real launcher does not.

### Fixes
- **I1:** for AF_UNIX the filter allows only SOCK_STREAM and SOCK_SEQPACKET, with flags masked.
  DGRAM and RAW get EACCES in every restricted mode. socketpair is unchanged.
- **I2:** in every network kind, including environment, the broker creates and owns every
  AF_UNIX/INET/INET6 socket and always handles `connect` and `listen`.
  - Pathname UNIX connect is resolved with follow-symlink semantics through the pinned write
    roots. The target must be a socket, and the connect goes through `/proc/self/fd/N`.
  - Pathname bind (mediated kinds) resolves the parent directory in the write roots and binds
    via `/proc/self/fd/<dir>/<name>`.
  - Abstract and unnamed addresses are refused. Abstract scoping does not cover the broker,
    so it cannot pass them on.
  - In environment mode, inet behaves without a filter, still with broker ownership.
- **M1 (controller decision):** network none/allowlist may bind only to 127.0.0.1 or ::1, done
  as a brokered bind. Landlock now handles BIND_TCP and CONNECT_TCP. `listen` on an unbound or
  non-loopback TCP socket is refused, which closes the autobind-to-any route. This is documented
  in the source header and the conformance doc.
- **I3:**
  - SIGTERM/SIGINT handlers are installed and the signals blocked before fork. The child
    restores the defaults and unblocks just before exec.
  - The child order is: PDEATHSIG, parent check, then setsid.
  - Right after fork the supervisor writes `{"event":"session","sid","start"}`.
  - The new `linux-sandbox.py reap` mode ends the closed session (setsid is denied inside it).
    It identifies the session by SID plus the leader's start time, signals each member through a
    pidfd after re-checking its session, waits on that pidfd, and skips zombies.
  - The test consumer runs `reap` after every launcher exit, before it joins the output pipes,
    so the request no longer hangs.
  - No cgroup is used: the container has no delegated, writable cgroup.
- **M3:** the filter itself denies keyctl, add_key, request_key and setns (EPERM), clone3
  (ENOSYS; glibc falls back to clone) and uselib. clone and unshare carrying any CLONE_NEW* flag
  get EPERM.
- **M4:** children use `close_range`, keeping the root fds only in native mode.
- **M5:** `probe()` never raises; any failure reports `restricted: null` with a reason.
- **M6:**
  - The SDK source-string test is replaced by behavioural tests. They load the launcher with
    only `platform` and the Landlock ABI stubbed and check every probe decision, the probe's
    crash handling and the endpoint keys.
  - A small classic-BPF interpreter runs the generated filter for both aarch64 and x86_64:
    foreign arch kills, x32 and syscall numbers above 469 get ENOSYS, and the socket, keyring,
    namespace, fastopen and ioctl verdicts are checked in both mediated and environment kinds.
  - The Docker fail-closed cases now assert the specific reason: "Landlock ABI 0" for the
    removed Landlock, "required primitive failed" for the removed listener. They skip when the
    primitives are not otherwise available, so they cannot pass because of the architecture.
- **M7:**
  - `packages/testing/test/container-tests.json` is read by `vitest.config.ts`.
  - `check:test-portfolio` applies its overlap and missing-file rules to that list, plus a new
    `test-portfolio-container-unlisted` rule: a testing test calling `startDevice(` that is not
    listed fails.
  - Red fixture: `tools/checks/fixtures/test-portfolio/testing-container`, with a failing-first
    test in `tools/checks/test/test-portfolio.test.ts`.
  - Documented in `tools/checks/README.md`.
- **M8:** endpoints are keyed as `(address, port, scopeId)`, with IPv4-mapped addresses
  normalized. The connect compares the copied `sin6_scope_id`.
- **Socket constants:** the launcher now uses the Linux socket ABI constants (identical on
  aarch64 and x86_64) instead of the host Python's, so the interpreter tests also run on macOS.
- **M2 (accepted):** stated in the source header and in the conformance doc. Metadata reads
  outside the roots stay visible: stat, access, readlink targets, xattr values, statfs, inotify
  and other processes' cmdline.

### x86_64 and the validated flag
- `ARCHES["x86_64"]` is reviewed: the legacy chmod, chown, lchown and utime family; bind 49,
  listen 50, clone 56, keyctl 248–250, unshare 272, setns 308, the x32 bit, and
  `AUDIT_ARCH_X86_64`. The BPF-interpreter test exercises it.
- `VALIDATED_ARCHES = ("aarch64",)`. On x86_64 the default probe reports "The syscall inventory
  is not validated on x86_64".
- `candidateArch` (request field) / `probe --candidate-arch` runs the reviewed table for evidence
  collection only. The launch and probe records then carry `"validated": false`.
- The Docker evidence test always uses the candidate agent for mechanisms and asserts the default
  probe's "not validated" reason on x86_64. It logs both probe results (`[linux-runtime] ...`).
  It needs only a ghcr pull (the rc.15 image has a linux/amd64 variant), Docker's defaults, and no
  extra privileges.
- **How the flip happens:** after a CI run on a stock x86_64 GitHub runner shows
  `sandbox-linux-runtime.test.ts` at 17/17 with mechanisms not skipped, an evidence commit:
  - adds "x86_64" to `VALIDATED_ARCHES`;
  - updates the SDK digest and the SDK behavioural expectation (`x86-default` → null);
  - adds a changeset;
  - cites the CI run ID, runner kernel and Landlock ABI.
- **Risk:** Landlock ABI 6 needs kernel 6.12 or later. If the runner kernel is older, the probe
  reports "Landlock ABI N is below the required 6", mechanisms skip, and that runner cannot
  supply the evidence. The logged probe shows which case applies.

### Results
- **Docker evidence:** `pnpm exec vitest run packages/testing/test/sandbox-linux-runtime.test.ts
  --reporter=verbose`, 5 consecutive runs, **17/17 each**: `task-2b-fix1-docker-run{1..5}.log`
  (run 1: 47.5 s; full conformance about 18 s; C pointer race about 15 s).
  - New cases: SIGKILL of the supervisor leaves no owned process and the request completes; a
    high inherited fd does not survive exec.
  - New mutations: the low-close mutant leaks; the no-Landlock, reopen-root and double-fetch
    mutants are still detected (the double-fetch target string now names the connect site
    uniquely).
  - Conformance now includes, for each of none, allowlist and environment, a Full-access sibling
    UNIX server reached via stream, seqpacket, dgram, raw and an in-root symlink: all denied, the
    server's count stays 0, and an in-root UNIX round trip works. The same client under Full
    access reaches the server exactly 5 times, which proves the probe is real.
  - Also new: binds are loopback only for none and allowlist.
- **Focused unit tests:** `sandbox-runtime-source` (5), the permission and native conformance
  harnesses, and `test-portfolio`'s 14 tests including the new red-fixture case all pass.
  - One timeout: `test-portfolio > passes the real tree` exceeds the local 5 s bound because of
    machine load from other sessions. Load average reached 186. The run took 1302 s, and the
    test took 4.7 s on the controller branch at load 25.
  - The full real-tree scan itself passes in `pnpm check` (Test portfolio check passed).
  - `sandbox-native-helper.test.ts` was not touched, as instructed.
  - Logs: `task-2b-fix1-focused-unit.log`.
- **Checks:** `pnpm typecheck` 0; `check:sdk-api` passed (no snapshot change);
  `check:sdk-api-changeset --base a5185eb77` passed; `pnpm check` all passed; Biome clean on
  every touched path.

### Still not proven / still needed
- **x86_64:** real-kernel evidence must come from CI (see the flip above). Until then x86_64
  reports restricted unavailable.
- **Supervisor loss:** cleanup depends on the consumer running `reap`. If the consumer is lost
  too, the orphans keep running until a later reap. They stay under Landlock, and brokered calls
  fail with ENOSYS. No cgroup-based containment is available in this container.
- **Unchanged from round 0:** broker resource bounds are unmeasured; metadata confidentiality is
  out of scope (M2); kernel-driven revocation, background references and the Docker/E2B
  providers are not covered.

## Fix round 2

Commit `e6e4bd142 fix(sdk): close socketpair datagrams and keep broker socket ownership` (on top of
`af124224c`). It addresses "Re-review round 1" in `task-2b-independent-review.md`. Same hardened
container and image; nothing relaxed.

### RED: `task-2b-fix2-red.log`, new tests on the af124224c launcher, 3 failed
- **I1-r:** the inventory reported `pair-dgram`, `pair-raw` and `pair-dgram-cloexec` as ALLOWED.
  The conformance suite's sibling-server UNIX check, which now includes `pair-dgram` and
  `pair-raw` sendto attempts under none, allowlist and environment, was not reached in that run,
  because the bind check before it failed first.
- **M1-r:** conformance printed `unspec=0.0.0.0`: after connect(AF_UNSPEC), listen() autobinds
  to every interface.
- The new refused-connect test printed nothing in this run because of a shell-quoting bug in the
  test itself (fixed). Its listen-after-refusal case therefore has no recorded RED. It is green
  now: `refused=denied unspec=denied`.

### Fixes
- **I1-r:**
  - The filter allows socketpair (aarch64 199, x86_64 53) only for AF_UNIX with masked type
    STREAM or SEQPACKET; everything else gets EACCES.
  - The BPF-interpreter SDK test asserts this for both architectures.
  - The inventory asserts `pair-dgram`, `pair-raw` and `pair-dgram-cloexec` are EACCES and
    `pair-seqpacket` is allowed.
  - In the conformance suite, under each network kind, every attempt on the sibling server is
    denied and its count stays 0. Under Full access the same client reaches it exactly 7 times.
- **M1-r:**
  - The broker no longer releases ownership on AF_UNSPEC or on a failed connect. A failed unix
    connect is no longer released either, and a non-blocking connect is released only when its
    SO_ERROR is 0.
  - Under none/allowlist, listen() on an unowned socket is EACCES (no CONTINUE). Since ownership
    ends only with a successful connect, an unowned socket is connected, accepted or a socketpair
    end. Environment keeps CONTINUE.
  - Tests: `refused=denied unspec=denied` (Linux test, with an allowlisted closed port
    `refused.test` → 127.0.0.1:18099), and `unspec=denied` in the conformance bind program for
    none and allowlist.
- **Reap:** after pinning each member with a pidfd, reap re-checks that the member is still in
  the session, that it started no earlier than the leader, and that the leader's PID has not been
  taken by another process. The docstring now claims only that a PID reuse within a scan can skip
  a process, never signal a stranger.
- **Session event before user code:**
  - The child waits for one acknowledgement byte, after its restrictions and before exec. The
    supervisor sends it only after writing the `session` event, starting the broker and writing
    `launch`; EOF means the supervisor is gone and the child exits.
  - Test: the agent SIGKILLs the supervisor the moment it reads the `session` event. The first
    event is `session`, the request completes, and no `sleep 2101/2102` survives.
  - This window was not shown RED deterministically. It needs a timed race; I relied on the
    reviewer's analysis plus the green test.
- **candidateArch:**
  - On an unvalidated architecture `probe --candidate-arch` now returns `restricted: null`,
    `validated: false` and the reason, with the primitives' result separately under `candidate`.
    The SDK behavioural test asserts this for x86_64; on aarch64 it is unchanged.
  - Only the test fixture's `support()`, for an agent explicitly created with `candidateArch`,
    reads `candidate`.
- **Portfolio blind spot:** the literal `startDevice(` detection is recorded in
  `tools/checks/README.md`.
- **CI evidence prep:**
  - With `CAPYBARA_TEST_REQUIRE_LINUX_RESTRICTED=1`, a missing Docker or image becomes a failing
    test that names the reason (verified with a missing image: 1 failed, the message names the
    image; log `task-2b-fix2-require-missing.log`).
  - In the same mode, restricted unavailability fails `beforeAll` with the probe's reason, and
    every mechanism skip becomes a failure.
  - The test logs one `[linux-runtime] {...}` line with the candidate probe, kernel (`uname -srm`),
    LSM list (host `/sys/kernel/security/lsm`, falling back to the container; "unreadable" on
    Docker Desktop), the device's Seccomp/NoNewPrivs, Docker's security options and the image
    id/digest/architecture. A second line has the default probe (Landlock ABI, `validated`).
  - No changes to `.github/workflows` or `tools/ci`.

### Results (CAPYBARA_TEST_WORKERS=2)
- **Docker suite**, `pnpm exec vitest run packages/testing/test/sandbox-linux-runtime.test.ts`,
  3 consecutive runs: **19 passed, 1 skipped (20) each**. The skip is the "required" describe,
  which runs only when Docker/the image is missing and the requirement is set.
  - Run 1 ran in default mode; runs 2 and 3 with `CAPYBARA_TEST_REQUIRE_LINUX_RESTRICTED=1`.
  - Logs: `task-2b-fix2-docker-run{1,2,3}.log`.
- **Focused tests** (`sandbox-runtime-source`, permission and native conformance,
  `test-portfolio`): **23/23 passed** (`task-2b-fix2-focused-unit.log`).
- **Checks:** `pnpm typecheck` 0; `check:sdk-api` and `check:sdk-api-changeset --base
  a5185eb77` passed (no API snapshot change); `pnpm check` all passed; Biome clean.

### Still open
- **x86_64:** real-kernel evidence still has to come from the controller's CI job with the
  requirement switch set. That needs a runner kernel at 6.12 or later with Landlock active,
  Docker's default profile allowing Landlock and the seccomp listener, and a public pull of the
  image. `VALIDATED_ARCHES` stays `("aarch64",)`.
- **Unchanged:** supervisor-loss cleanup depends on the consumer running `reap`; broker resource
  bounds are unmeasured; metadata reads outside the roots stay visible (M2).
