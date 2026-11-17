# Task 2b independent security review

Reviewer: independent (read-only on source). Range: `git diff a5185eb77 95395bf47` in
`/Users/grant/Capybara/core/.claude/worktrees/perm-t2b` (branch `perm/t2b`).
I formed these judgments from the code and live probes first. I read the author's report afterwards.

## Verdict: CHANGES_REQUIRED

There are no Critical findings. Three Important findings are confirmed on the real kernel in the
unchanged hardened container. Each one either bypasses a rule the filter is meant to enforce, or
leaves owned restricted work running after its supervisor is lost. The core mechanisms are sound,
and the tests do detect what they target. Those core mechanisms are the pinned roots, the broker's
single-copy reads, ADDFD socket ownership, Landlock ABI-6 coverage and the fail-closed probe.

Line numbers below refer to `packages/plugin-sdk/src/sandbox-linux-runtime-source.ts`, the TS file
that embeds the Python, unless another file is named.

## Findings

### Important

**I1. `socket(AF_UNIX, SOCK_RAW)` bypasses the unix-datagram denial under network `none`/allowlist (lines 263-268).**
The filter denies only `type & 0xF == SOCK_DGRAM` for AF_UNIX. Linux's `unix_create` maps `SOCK_RAW` to `SOCK_DGRAM`.
`sendto()` with an address is not `connect`, so it is never brokered.
Reproduced in the hardened container with network `none`:
`socket(AF_UNIX, SOCK_RAW).sendto(b'..', '/workspace/sibling/dgram.sock')` returned `sendto ok`.
The server outside every root received `dgram-from-RAW`, while `SOCK_DGRAM` gave EACCES as intended.
The process can therefore send datagrams to any pathname datagram service the device user can write to.
On a local Linux device that includes `/dev/log`, `/run/systemd/journal/socket` and notify sockets.
This undermines the rule the inventory test claims (`unix-dgram: EACCES`), and the test missed it
because it checks only `SOCK_DGRAM`.
Fix: when the network is mediated, allow AF_UNIX `socket()` only for `SOCK_STREAM` and
`SOCK_SEQPACKET` (allow-list the masked type; deny everything else). Keep `socketpair` as it is.
Add `unix-raw` to the inventory test, expecting EACCES.

**I2. With scoped filesystem plus network `environment`, pathname AF_UNIX connect/sendto is unmediated (lines 228-230, 264, 270).**
In this mode `connect` is not notified, so a restricted command can reach any host IPC service by socket path.
Reproduced with network `environment`: a stream connect to a socket in the sibling directory got
`SERVED`, and DGRAM and RAW `sendto` both succeeded.
On a local Linux device the same path reaches the user's systemd bus (`/run/user/UID/bus`, where
`systemd-run --user` runs anything unconfined), `docker.sock`, ssh-agent and pathname X11 sockets.
Each of these escapes the filesystem scope entirely.
The contract defines `environment` as removing only the network filter. It must not void filesystem
confinement, and the probe advertises `filesystem: true` on any Linux aarch64 system with ABI 6.
Under `none`/allowlist this is covered, because every `connect` goes to the broker and an unowned
socket gets EACCES (confirmed: `STREAM [Errno 13]`). Note that the report's description of this as a
general "compat limitation" is only true for the mediated network kinds.
Fix, in either network kind: always notify `connect` and `sendto`/`sendmsg` for AF_UNIX, and allow
pathname targets only inside the write roots, resolved by the broker from the pinned descriptors. The
broker could connect its own copy, as it does for TCP. The alternative is to deny pathname AF_UNIX
outright in restricted mode. Add a conformance case with a unix server in the sibling directory for
every network kind.

**I3. Losing the supervisor leaves owned restricted descendants running with their write grant (lines 885, 948-961, 778-801).**
`PR_SET_PDEATHSIG` covers only the direct child, and the subreaper role dies with the supervisor.
Reproduced: I SIGKILLed the `linux-sandbox.py` supervisor of a running command. `sleep 2001` and
`sleep 2002` survived (PPID 1, SID 105, the session the launcher created) and kept write access to the root.
The agent's request also never completes, because the orphans hold the output pipes.
There is a second, related window. SIGTERM/SIGINT handlers are installed in `supervise()` only after
fork, exec and the broker start. A cancel that arrives in that window kills the supervisor by default
action and produces the same orphans.
The spec says: "A lost supervisor must fail closed and clean up its exact owned work". The report's
"providers must stop with SIGTERM" does not meet that, because supervisors can also be OOM-killed or crash.
Fix:
- Install the handlers, or block SIGTERM/SIGINT, before `fork()` (unblock in the child before exec).
- Make cleanup independent of supervisor survival. `setsid` is denied, so the session is a closed
  owned set that the consumer can terminate by SID, with recorded start-time identity. Where
  available, use a cgroup the consumer owns, which is not a privilege relaxation.
- Add a conformance case that SIGKILLs the supervisor and expects no survivors.

### Minor

- **M1. TCP/IPv6 `bind`/`listen` on every interface is allowed under network `none` (line 326 handles only `CONNECT_TCP`; lines 651-662; inventory test expects `tcp-listen: ALLOWED`).**
  Confirmed: `0.0.0.0:19999` and `[::]:19998` listen. On a LAN-connected local device, a "no network"
  command can serve data to inbound peers. The spec forbids reaching unapproved destinations, not
  inbound connections, so this is a product decision. It should be decided and documented explicitly,
  or restricted to loopback with `LANDLOCK_ACCESS_NET_BIND_TCP` plus a brokered bind.
- **M2. Metadata reads outside the roots are unmediated** (stat, access, readlink, getxattr, statfs, inotify, and `/proc/<pid>/cmdline` of other processes).
  This is acceptable, not must-fix: the approved design already records "stat metadata stayed
  visible", the contract protects content, and macOS behaves the same way. It must appear in the
  provider support notes (Task 12), and readlink/xattr values must not be described as protected.
- **M3. Local-Linux syscall surface.**
  `keyctl`/`add_key`/`request_key` (user keyrings, e.g. Kerberos KEYRING caches) and
  `unshare`/`clone` with namespace flags are allowed by this filter. Here Docker's default profile
  returned EPERM for both, but on a local Linux host they would succeed. Deny them in the restricted
  filter, since Landlock does not cover keyrings.
- **M4. Children close only fds 3..1023 (line 901).**
  An inheritable consumer fd at 1024 or above would survive exec. Use `close_range(3, ~0U, 0)` and
  keep the root fds only in native mode.
- **M5. Probe crashes are not reported.**
  A non-`OSError` exception in `probe()` exits 125 with no stdout, which makes the consumer's
  `json.loads` fail. Catch every exception and print `{restricted: null, reason}`.
- **M6. Tests that assert text or pass vacuously.**
  - The SDK test "fails closed outside the validated inventory"
    (`packages/plugin-sdk/test/sandbox-runtime-source.test.ts`) checks source strings, not behaviour.
  - On x86_64 CI the probe is unavailable because of the architecture. The mechanism tests then skip,
    and the two "fails closed" cases pass for the architecture reason, not because the outer filter
    removed Landlock or the listener. CI therefore proves nothing about the mechanism; note this
    explicitly, or assert that the reason names the removed primitive.
- **M7. Test portfolio.**
  `testing-container` takes its membership from an inline array in `vitest.config.ts:35`, not a
  checked-in JSON list like `packages/kernel/test/container-tests.json`. Its timeouts match the
  container category, which is fine. `check:test-portfolio` scans only kernel tests, so nothing
  enforces this. Move the list to `packages/testing/test/container-tests.json` and read it as the
  kernel list is read.
- **M8. IPv6 `sin6_scope_id` is not compared (line 676).**
  A granted link-local endpoint is reachable on any interface.

## What I verified (code review)

- **Broker time-of-check races.**
  - Target memory and `/proc/pid/fd` objects are opened first, then `NOTIF_ID_VALID` is checked.
  - The sockaddr and path are copied once, and the connect uses the broker's copy on a socket the broker owns.
  - Metadata targets are resolved independently from the pinned write roots with no-follow traversal
    and applied through an O_PATH fd. For AT_EMPTY_PATH, a dev/ino re-resolution identity check is used.
  - Ownership is recorded before ADDFD|SEND. The struct layouts and ioctl numbers are correct.
- **Filter.**
  - A foreign architecture is killed; the x32 bit and syscall numbers above 469 get ENOSYS.
  - io_uring, userfaultfd and `setsid` are denied.
  - `MSG_FASTOPEN` is denied on sendto, sendmsg and sendmmsg (correct argument indexes).
  - The aarch64 ioctl list is handled.
  - ptrace, process_vm_*, pidfd_getfd and kcmp are blocked by Landlock's ptrace scoping.
  - Mount APIs are denied by Landlock. open_by_handle_at needs CAP_DAC_READ_SEARCH.
- **Landlock ABI 6.**
  - All 16 filesystem rights are handled, including REFER, TRUNCATE and IOCTL_DEV.
  - CONNECT_TCP is handled when the network is mediated.
  - The abstract-unix and signal scopes are set.
  - Rules use the pinned fds, whose identity is checked by fstat and `/proc/self/fd` readlink;
    no root path is reopened.
- **Supervisor isolation.** Signals, `environ`, `mem` and `/proc/1/root` are denied (also tested).
- **Root swaps and fail-closed probing.** Root swaps are refused (`ROOT_CHANGED`). The fail-closed
  paths, with stricter outer filters and no relaxation, refuse with `UNAVAILABLE` before running anything.
- **Mutants.** The three mutants (no Landlock, reopened root, double fetch) are real behavioural
  detections, not fixture flags. The runtime report is the launcher's own probe.

## Live probes (reviewer, hardened container, aarch64, kernel 7.0.14-linuxkit, Landlock ABI 8)

| Probe | Result |
|---|---|
| AF_UNIX `SOCK_RAW` sendto to a sibling dgram socket, network `none` | **succeeded (I1)** |
| AF_UNIX DGRAM / stream connect, network `none` | EACCES / EACCES |
| AF_UNIX stream connect + DGRAM/RAW sendto, network `environment` | **all succeeded (I2)** |
| listen on `0.0.0.0` / `::`, network `none` | allowed (M1) |
| keyctl / unshare(CLONE_NEWUSER) | EPERM, but only because of Docker's default profile (M3) |
| SIGKILL of the supervisor during a run | **two descendants survived, PPID 1 (I3)** |

The probe script is outside the repository:
`/private/tmp/claude-501/-Users-grant-Capybara-core/3c06d80f-5364-4c73-8472-47a47fd00814/scratchpad/probe/probe.mts`.
All probe containers were removed.

## Test counts

- Docker conformance, `pnpm exec vitest run --project testing-container packages/testing/test/sandbox-linux-runtime.test.ts`:
  **14/14 passed** (60 s; aarch64, so the mechanism tests really ran).
- Focused SDK/testing tests (`sandbox-runtime-source`, `sandbox-permission-conformance`,
  `sandbox-native-conformance`, `sandbox-native-helper`): **14/15 passed**.
  - The failure is `sandbox-native-helper.test.ts` timing out at 5 s. That file and the native
    source are unchanged in this diff.
  - With `--testTimeout 60000` it passes 8/8, so it is a load-related problem from before this change.

## Comparison with the author's report

- **Matches:** the inventory, the mutant proofs, fail-closed behaviour, the metadata-read gap and
  orphaning after supervisor SIGKILL, which the report acknowledges.
- **Missed:** the SOCK_RAW datagram bypass, and that unix connect is unmediated under `environment`.
  The report presents "AF_UNIX pathname connect is denied" as unconditional.
- **Rated lower than warranted:** the report treats orphaning after supervisor loss as acceptable
  under "providers must stop with SIGTERM". The spec requires cleanup that fails closed.

---

# Re-review round 1 (af124224c, scoped to `git diff 95395bf47 af124224c`)

## Verdict: CHANGES_REQUIRED

I3, M3, M4, M5, M7 and M8 are resolved. I2 is resolved for connect and bind. Two new escapes remain,
both confirmed on the real kernel in the same hardened container:

- **I1-r:** unix datagrams still reach pathname sockets outside the roots, through `socketpair`.
- **M1-r:** the new loopback-only TCP bind/listen can be bypassed by dropping broker ownership
  first, after which `listen()` binds every interface.

Line numbers refer to `packages/plugin-sdk/src/sandbox-linux-runtime-source.ts` at af124224c.

## Still open

**I1-r (Important). `socketpair(AF_UNIX, SOCK_DGRAM | SOCK_RAW)` + `sendto(path)` reaches any pathname datagram socket, in every network kind (filter lines 291-311, sendto lines 270-273).**
The fix routes `socket()` through the broker and refuses datagram/raw types there. `socketpair` is
still allowed for every type. For AF_UNIX datagram sockets the kernel honours an explicit `msg_name`
even on a connected pair. Nothing filters `sendto` or `sendmsg` with an address, except the
`MSG_FASTOPEN` check.
Reproduced: `a, b = socketpair(AF_UNIX, SOCK_DGRAM); a.sendto(b'..', '/workspace/sibling/dgram.sock')`
returned 6 (bytes delivered) under `none`, allowlist and `environment`. The `SOCK_RAW` pair behaved
the same. The documented rule "datagram and raw are refused" is therefore false.
Fix: in the filter, allow `socketpair` (aarch64 199, x86_64 53) only when arg0 is AF_UNIX and the
masked type is STREAM or SEQPACKET; return EACCES otherwise. Add `pair-dgram-sendto` and
`pair-raw-sendto` to the inventory test, expecting EACCES.

**M1-r (Important now: it defeats a documented guarantee). Loopback-only bind/listen is bypassed by releasing ownership first (lines 803-819, 837-856).**
`connect()` with `AF_UNSPEC` is accepted and the broker then drops its reference
(`self.release(inode)`, line 855). A later `listen()` on the no-longer-owned TCP socket returns
`"continue"` (line 808). The kernel then autobinds it to 0.0.0.0, and Landlock (ABI 8) has no listen
right that would stop this.
Reproduced under `none`, allowlist and `environment`: `connect(AF_UNSPEC)` returned 0, and `listen()`
gave `('0.0.0.0', 36043)`. A connect that the kernel refuses (ECONNREFUSED, line 853) also releases
the socket and opens the same path.
Fix:
- Do not release a TCP socket on AF_UNSPEC or on a failed connect. Release it only on a successful
  connect or after the broker's own listen.
- Under network `none`/allowlist, refuse `listen()` on an inet socket the broker does not own,
  instead of returning CONTINUE. Only accepted sockets are unowned, and they cannot listen anyway.
- Add `unspec-then-listen` to the inventory test, expecting EACCES or a loopback address.

## Minor (new)

- **Reap PID-reuse race (lines 1055-1091).**
  Each pass checks the leader's start time once, then scans and signals members matched only by SID.
  Suppose that, during a pass, the last member exits, the PID number is reused and the new holder
  calls `setsid()`. The pass could then signal members of an unrelated session. This needs a full PID
  wraparound inside one pass, so it is negligible in practice, but the docstring claims soundness.
  Fix: after opening each member's pidfd, re-check `start_time(sid) == started`, or stop if the
  leader is gone and absent before; better, also compare each member's start time against the
  launch time (members cannot predate the leader).
- **Session-event window (lines 1146-1187).**
  The child does not wait for the supervisor after fork. It can exec and fork before the parent has
  written the `session` event. If the supervisor is SIGKILLed in that window, PDEATHSIG kills only
  the direct child, and the consumer has no SID to reap.
  Fix: before exec, the child should block until the parent sends one byte after writing `session`.
- **`candidateArch` is a convention, not a gate (lines 1108, 1264, 1336-1339).**
  It is a consumer-supplied request field or probe flag, not reachable from a model or scope. But a
  candidate probe returns a non-null `restricted` with only `validated:false` to distinguish it, so a
  consumer that maps `restricted` to support would advertise x86_64. The fixture uses it only in
  tests (`docker.ts:212`, `agent.py:148,184`); no production code sets it.
  Fix: have the candidate probe return `restricted: null` plus a separate `candidate` result, or make
  the SDK or conformance harness reject support whenever `validated !== true`.
- **Portfolio check marker.** `check:test-portfolio` recognizes a container test only by the
  literal `startDevice(`. This is acceptable; record it as a blind spot in tools/checks/README.md.

## Resolved (verified)

- **I2: connect and bind.**
  - Every AF_UNIX/inet `socket()` is now created by the broker, in all network kinds (lines 291-311, 684-717).
  - Pathname connect/bind go through `unix_target` (lines 733-755): no-follow resolution from the
    pinned write roots, then a connect to `/proc/self/fd/N`, or a bind in `/proc/self/fd/<parent>/<name>`.
  - Probes, in all three network kinds:
    - sibling socket: EACCES
    - in-root symlink to the sibling socket: EACCES
    - relative `../sibling`: EACCES
    - bind into the sibling: EACCES
    - bind through an in-root directory symlink to the sibling: EACCES
    - in-root socket: `SERVED` (positive control)
    - nothing was planted in the sibling directory
  - Abstract and unnamed addresses are refused (line 736).
  - Autobind via `listen` on an unbound unix socket is impossible: the kernel requires an address.
  - The residual datagram path is I1-r.
- **I3: lost supervisor.**
  - Handlers are installed and SIGTERM/SIGINT blocked before fork; the child resets them and unblocks
    them before exec (lines 1144-1187).
  - The closed session is reported with its start time, and `reap` kills it.
  - The committed test "losing the supervisor (SIGKILL) ends every owned restricted descendant" passes.
  - The leader start-time check is sound for the cross-pass case: a PID stays reserved while its
    session has members. The in-pass race is the Minor above.
- **M3: keyrings and namespaces.**
  - `keyctl`/`add_key`/`request_key`/`setns` return EPERM; `clone3` returns ENOSYS.
  - `unshare`/`clone` with any namespace flag return EPERM: `NAMESPACE_FLAGS` = 0x7E020080 is
    correct, and arg0 is the flags argument on both architectures.
  - The aarch64 numbers (97, 217-220, 268, 200) and x86_64 numbers (272, 248-250, 56, 308, 49, 134)
    are correct.
  - The inventory test asserts these behaviours.
- **M4.** `close_except` uses `close_range` up to `~0`. There is a new fd-1500 leak test, and a mutant
  (close below 1024 only) is detected.
- **M5.** The probe never raises (lines 1274-1281).
- **M6 (partly).** The x86_64 default probe still reports "not validated" without the flag, as the
  test asserts. The fail-closed cases now assert the specific reason. The CI evidence gap is below.
- **M7.** `packages/testing/test/container-tests.json` is read by `vitest.config.ts`. The new
  `test-portfolio-container-unlisted` rule, plus missing-file and overlap rules for that list, are
  proven red by the `testing-container` fixture: the test expects all three findings.
  `pnpm check:test-portfolio` passes.
- **M8.** The IPv6 scope ID is part of the endpoint tuple (lines 976-995, 765-775); a v4-mapped
  address is normalized.

## CI on x86_64: what actually runs

The `test` job runs `vitest run --shard ... $DIRS` on `ubuntu-latest` (x86_64, Docker available)
with no `--project` filter. So `testing-container` runs whenever `packages/testing` is in the set:

- every `packages/testing/**` change runs everything;
- a `plugin-sdk` change runs its dependents, which include testing;
- `main` runs everything.

The suite always passes `candidateArch`, so the x86_64 table is exercised whenever the primitives
probe OK. Four things are missing for real x86_64 evidence:

1. **A runner kernel with Landlock ABI ≥ 6 (Linux ≥ 6.12) and Landlock in the active LSM list.**
   I could not verify the ubuntu-latest kernel from here. If it is 6.11 or older, or Landlock is not
   active, the probe reports unavailable and every mechanism, fail-closed and mutant test calls
   `context.skip()`. CI stays green with zero evidence; the only trace is a `console.info` line.
2. **A hard requirement in CI.** For example, an env flag such as
   `CAPYBARA_TEST_REQUIRE_LINUX_RESTRICTED=1`, set in the job, that turns "unsupported" into a test
   failure. Without it, a skip cannot be told apart from evidence.
3. **Docker's default seccomp profile on the runner must allow `landlock_*` and `seccomp` with
   `SECCOMP_FILTER_FLAG_NEW_LISTENER`.** This is unverified; otherwise it is a skip again.
4. **The image `ghcr.io/capybara-hq/capybara-sandbox:0.1.0-rc.15` must be publicly pullable from
   CI.** If the pull fails, the whole file skips with that reason.

Until a CI run shows the mechanism tests executing on x86_64 (not skipped), `VALIDATED_ARCHES` must
stay `("aarch64",)`. It does.

## Commands and counts (round 1)

- Docker suite at af124224c, `pnpm exec vitest run --project testing-container packages/testing/test/sandbox-linux-runtime.test.ts`:
  **17/17 passed** (46 s, aarch64, mechanism tests executed), run once.
- `pnpm exec vitest run tools/checks/test/test-portfolio.test.ts packages/plugin-sdk/test/sandbox-runtime-source.test.ts packages/testing/test/sandbox-permission-conformance.test.ts`:
  **21/21 passed**. `pnpm check:test-portfolio`: passed.
- Reviewer probes are in
  `/private/tmp/claude-501/-Users-grant-Capybara-core/3c06d80f-5364-4c73-8472-47a47fd00814/scratchpad/probe/probe2.mts`
  (outside the repository, same hardening). The results are above, and every container was removed.

---

# Re-review round 2 (e6e4bd142, scoped to `git diff af124224c e6e4bd142`)

## Verdict: APPROVE

I1-r and M1-r are closed under `none` and allowlist, and the `environment` behaviour matches the
documented contract (detail below). The four Minors from round 1 are resolved, and the
`CAPYBARA_TEST_REQUIRE_LINUX_RESTRICTED` switch fails instead of skipping.
The extra adversarial pass found no new escape.
One CI gap is still open, but it does not block the source change: the switch is not set in
`.github/workflows/ci.yml`, so x86_64 evidence still depends on the maintainer wiring it (see below).

## Verified closed (live, same hardening, `none` / allowlist / `environment`)

- **I1-r.** Two changes close it:
  - `socketpair` is filtered to AF_UNIX STREAM/SEQPACKET only (filter `socketpair` label; aarch64
    199, x86_64 53, both correct).
  - Datagram and raw `socket()` calls were already refused.

  | Probe | none | allowlist | environment |
  |---|---|---|---|
  | `socketpair(DGRAM)` + `sendto(sibling dgram)` | EACCES | EACCES | EACCES |
  | `socketpair(RAW)` + `sendto(sibling dgram)` | EACCES | EACCES | EACCES |
  | stream pair `sendmsg` with `msg_name` | EISCONN | EISCONN | EISCONN |
  | seqpacket pair `sendmsg` with `msg_name` | name ignored, delivered to its own peer | same | same |
  | unconnected seqpacket `sendmsg` | ENOTCONN | ENOTCONN | ENOTCONN |
  | unconnected stream `sendto` | EOPNOTSUPP | EOPNOTSUPP | EOPNOTSUPP |

  The sibling server's log shows only in-root (`INROOT`) connections and no `DGRAM` receipt.
- **M1-r.**
  - Ownership is now released only after a successful connect (TCP and UNIX). The AF_UNSPEC path
    and the `SO_ERROR` result of `settle` keep ownership.
  - Under `none`/allowlist, `listen()` on an unowned socket returns EACCES.

  | Probe (`none` and allowlist) | Result |
  |---|---|
  | `connect(AF_UNSPEC)`, then `listen()` | EACCES |
  | refused `connect()`, then `listen()` | EACCES |
  | non-blocking refused `connect()`, then `listen()` | EACCES |

  Under `environment` all three listen on `0.0.0.0`, as the contract's "environment lifts the
  network filter" states.
- **Reap re-checks.**
  - The leader's start time is re-checked after the pidfd is pinned.
  - Each member must have a start time no earlier than the leader's.
  - A PID reuse within one scan can now only make reap skip a process.
  - Probe: I SIGKILLed the supervisor directly, outside the agent; the orphan was gone after the
    consumer's `reap` (`alive: []`).
  - The committed SIGKILL test passes.
- **Session ack.** The child blocks on one `A` byte, sent after the `session` event, the broker
  start and the `launch` report; at EOF it exits 125. No user code can run before the consumer
  holds the SID.
- **Candidate probe.**
  - On an unvalidated architecture the probe now returns `restricted: null` with a separate
    `candidate` result.
  - The fixture uses the candidate result only for an agent created with `candidateArch`.
  - Residual, acceptable: `run()` still honours `candidateArch` from the trusted consumer's
    request. It is not reachable from a scope or the model. Task 12 must never set it; reviewers
    should grep for it.
- **README blind spot.** `tools/checks/README.md` now documents that a container test is
  recognized only by the literal `startDevice(`.
- **Require switch.**
  - Run with `CAPYBARA_TEST_REQUIRE_LINUX_RESTRICTED=1` and a missing image: **1 failed | 19
    skipped**, with the error `...=1 but: The sandbox image ... is not available`. So a missing
    image fails rather than skips.
  - Restricted unavailable: `beforeAll` throws, and every mechanism test goes through
    `requireSupport`, which throws instead of calling `context.skip()` (code-reviewed).

## Adversarial pass (new probes; nothing escaped under none/allowlist)

| Attempt | Result |
|---|---|
| connect to a sibling seqpacket socket | EACCES |
| connect via `/proc/self/cwd/../sibling` | EACCES |
| connect through an in-root dir symlink | EACCES |
| hard link of the sibling socket into the root | EXDEV (Landlock) |
| dup of a broker-owned socket, connect to an ungranted endpoint | EACCES (ownership is per inode) |
| SCM_RIGHTS-passed broker socket, connect to an ungranted endpoint | EACCES |
| `listen` on an accepted socket | unreachable under `none`/allowlist: the loopback self-connect is itself refused (EACCES) |
| UDP | EACCES |
| `sendmsg(MSG_FASTOPEN)` | EACCES |
| io_uring | ENOSYS |
| binding the granted loopback port | EADDRINUSE (no hijack while the service holds it) |
| in-root UNIX socket (positive control) | `SERVED` |

The I3 orphan probe (`probe.mts`) passes: orphan reaped.

## Remaining (not blocking this commit)

- **CI x86_64 evidence.** `ci.yml` does not set `CAPYBARA_TEST_REQUIRE_LINUX_RESTRICTED=1`, so
  x86_64 still skips silently, unchanged from round 1. Four things are needed:
  1. a runner kernel ≥ 6.12 with Landlock active;
  2. Docker's default seccomp profile allowing `landlock_*` and the seccomp listener;
  3. a public image pull;
  4. a job (or job env) that sets the switch.

  `VALIDATED_ARCHES` correctly stays `("aarch64",)`.
- **Loopback port squatting (Minor, product note).** Under `none`/allowlist a restricted command
  may bind a free loopback port that a later service expects. This follows from the documented
  loopback-only rule; no fix required.

## Counts (round 2)

- Docker suite at e6e4bd142 with `CAPYBARA_TEST_REQUIRE_LINUX_RESTRICTED=1`, run once: **19 passed
  | 1 skipped (20)**. The skipped test is the `runIf` "required" guard, which only fires when Docker
  or the image is missing.
- Focused unit tests: `tools/checks/test/test-portfolio.test.ts`,
  `packages/plugin-sdk/test/sandbox-runtime-source.test.ts` and
  `packages/testing/test/sandbox-permission-conformance.test.ts`: **21/21 passed**.
- The probes `probe2.mts` (superseded by `probe3.mts`), `probe3.mts` and `probe.mts` are in the
  scratchpad, outside the repository. All containers were removed.
