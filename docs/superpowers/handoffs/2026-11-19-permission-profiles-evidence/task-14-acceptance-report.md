# Task 14 cross-runtime product acceptance report

Plan: [2026-11-16-permission-profile-delivery.md](../../plans/2026-11-16-permission-profile-delivery.md),
Task 14. Worktree `.claude/worktrees/perm-w4-int` (branch `perm/w4-int`, from `1d3eb1284`). Local
only: no push, no PR. Plugins evidence ran in a fresh worktree
`plugins/.claude/worktrees/perm-provider-acceptance` (branch `perm/provider-acceptance`, at plugins
`origin/main` `84a5307`, no changes). Run on 2026-11-19.

## Commits

- `2fcd0c0d7` fix(kernel): refuse an unenforceable profile with the unsupported tool text
- `5a2cf135c` test: accept permission profiles end to end on two replicas and in the web
- `75dfac927` test(kernel): one test per profile in the acceptance matrix
- `9ccd32beb` test(testing): run the permission conformance on the real macOS backend
- `82f9c010f` test(device): record the macOS case-fold alias denial and the aborted-call hang
- this report

## Findings

1. **Fixed: wrong model text when a device cannot enforce the profile** (`2fcd0c0d7`). Admission
   refused with a bare `ApiError`, so the model read "Tool Bash failed (ApiError). The operation
   may not have completed", although nothing ran. That is what every restricted conversation on
   E2B (Full access only) meets. An `unsupported` availability now throws
   `SandboxPermissionUnsupportedError` → `PERMISSION_UNSUPPORTED_TOOL_TEXT`. RED first in the new
   dual test and the web e2e spec; changeset `kernel-unsupported-profile-text.md`.
2. **Open, reported, not fixed: an aborted restricted macOS command can hang** (`82f9c010f`,
   `packages/device/test/mac-abort-escape.test.ts`, `it.fails`). A descendant that leaves the
   owned process group (`fork` + `setpgid`) is outside what macOS cancellation promises (contract,
   "Explicit background supervision"), but it keeps the command's stdout pipe open. The worker
   bootstrap (`WORKER` in `packages/device/src/exec/operation-worker.ts`) resolves `childClosed`
   on `close`, which waits for the pipe, so the aborted call never completes and `stop()` never
   ends the worker. The acceptance run left two orphaned workers (parent pid 1) and their escapees
   behind after the test process died. They were killed by hand. The escapee keeps its Seatbelt
   profile, and the worker's `manager.reset()` never runs, so the operation's proxy stays up too.
   The fix is probably small (end the call once the owned group has exited after a kill or
   timeout, destroying the stdio streams). But the bootstrap is a sealed runtime-manifest entry
   (its hash is frozen per release), so it is not a drive-by change. It needs its owner's
   decision, and a ruling on whether this is acceptable within the documented macOS limitation.
   **Since fixed** (follow-up commit on this branch): a kill or timeout first stops and kills the
   command's descendants found by parent pid, and once the owned group is gone the bootstrap closes
   the pipes after a bounded grace; the test is a normal passing test now, with sibling and
   timeout cases (contract, "Explicit background supervision", states the launchd limit).
3. **Not a boundary failure: macOS refuses APFS case-fold aliases.** APFS resolves `.git/hooKs`
   (Kelvin sign) to `.git/hooks` and `.zſhrc` (long s) to `.zshrc`. The real worker refuses
   writes through those spellings: regression test in `mac-write-denies.test.ts`. Fullwidth
   spellings (`.ＢＡＳＨＲＣ`) are distinct files on APFS and can be created. The SDK policy text
   says names compare after NFKC folding, and the macOS runtime does not fold compatibility forms
   (Seatbelt sees the resolved path). The harness now states this (`foldedNames: "filesystem"`)
   and asserts that the fullwidth file is distinct and `.bashrc` is untouched. The policy doc in
   `sandbox-write-denies.ts` should say this for macOS in the final doc pass.
4. **Product divergences recorded, not failures** (stricter on macOS):
   - Restricted macOS operations cannot listen at all: loopback and in-root UNIX sockets are
     refused (`allowLocalBinding: false`). Linux allows loopback-only listeners. A restricted dev
     server on a Mac needs Full access.
   - A live macOS operation whose root is moved refuses the moved path. Landlock keeps writing in
     the pinned inode. Neither follows the swap.
5. **From the web e2e subagent:** the unsupported state renders truthfully: restricted rows are
   disabled with "无法限制在项目内", and nothing falls back to 完全访问. The e2e spec now asserts
   the actionable text from finding 1.

## Coverage map (plan item → evidence)

| Plan item | Evidence |
|---|---|
| Profile × operation matrix (3 profiles × Bash/Read/Write/Edit/background start+stop, outside write) through the owner API, two replicas | `packages/kernel/test/sandbox/permission-profiles.dual.test.ts` cases 1–3 (new); per-rule order: `sandbox/review-pipeline.test.ts` "the permission review order" |
| First read of a project outside the fixed workspace | dual case 5: a protocol 3 machine, project `~/code/app` added through replica B, a restricted first `Read` reaches the machine with the project as its root, with no earlier exec; device side: `mac-operation-backend.test.ts` "first native read uses its explicit outside project without an earlier exec" |
| Read and write after a profile change | dual case 4 (Full → Request approval: a started task keeps its grant and is not stopped; a new outside read and write ask; in-project work runs under the new revision; the task stops by its ref); `runtime/permission-activation.test.ts` "a profile change … appends a new context before the next request" |
| Approval late-click race | `tools/permission-approvals.dual.test.ts` ("profile writer wins before late click", "click wins but resume sees newer profile", "request insertion loses to supersession", "duplicate reordered recheck and lost response converge…", "terminal human refusal survives %s revision"); `sandbox/review.dual.test.ts` |
| Replay context | `runtime/permission-context.dual.test.ts`, `evals/recorded-permission-context.test.ts`, `evals/run-replay.test.ts`, `evals/reconstruct.test.ts` (sandbox-fake's own permission support) |
| Injected delayed launch | `sandbox/platform-revocation-e2e.test.ts` ("a revocation that lands before the start is dispatched: the start is never sent", "… arrives before the start is acknowledged stops it by its ref once known"); `sandbox/permission-wiring.test.ts` "revocation before launch acknowledgement…" |
| Lost acknowledgement | `background/revocation-reconnect.dual.test.ts` B-5 cases; Docker provider R8 "a lost acknowledgement after a genuine bind…"; E2B live "a lost acknowledgement keeps the one genuine start" |
| Replica failure | `sandbox/operation-scopes.dual.test.ts` "unknown effects require the current new run claim…"; `platform-revocation-e2e` "a crashed holder's revocation survives a failed inline revoke…"; `background/permission-lifetime.dual.test.ts` "recovery on one replica never re-sends a start…" |
| Ceiling revocation | `platform-revocation-e2e` "Full-off revokes only Full work: a restricted sibling keeps its grant and keeps running"; `config/permission-config-activation.dual.test.ts`; `operation-scopes.dual` "admitted grants survive profile changes; ceiling revocation covers dispatch before acknowledgement" |
| Provider rebuild | `sandbox/sandbox.service.test.ts` "the outcome stays unknown and fn is not retried; the instance is rebuilt…" (`fc92fd194`); `permission-wiring` "instance recreation preserves consent…", "authority is read after waiting for the shared lease and gone after dispatch never gets a new ID retry"; `background/protocol-upgrade.dual.test.ts` |
| Exact cancellation, no duplicate, no sibling interruption | `revocation-reconnect.dual` "… stops exactly the revoked task; the sibling keeps running"; `platform-revocation-e2e` "two deliveries of the revoke running at once stop the task exactly once"; the conformance's cancellation step on each runtime (below) |
| Unsupported state (no widening) | dual case 6 (provider reports `restricted: null`: Approve for me and Request approval refused with the actionable text, nothing reaches the provider, Full access explicitly chosen runs); web e2e test 3; E2B live fail-closed branch |
| UI: picker, approval card, unsupported | `apps/web/e2e/permission-profiles.spec.ts` (3 tests) |
| Same behavioural assertions per runtime | `runSandboxPermissionConformance` (`packages/testing`), run on every runtime below |

## Real-runtime results

The same harness, `runSandboxPermissionConformance`, runs on every runtime. It checks:

- restricted reads and writes stay inside the grant: the sibling project, protected home files,
  and symlink, hard-link and swap races;
- mandatory denies inside a write root;
- network goes only to the granted host. Same-port peers, IPv4/IPv6 ungranted endpoints, a raw
  connect that bypasses the proxy, pointer races and wildcard binds are all refused;
- UNIX sockets outside the roots are unreachable;
- a fresh narrowed scope applies on the next operation (a per-call grant);
- Full access versus restricted overlap;
- abort and timeout end the owned tree while a sibling survives;
- background ownership.

| Runtime | Version / image / template | Result |
|---|---|---|
| (a) local macOS, capybara-device macOS backend (real Seatbelt via SRT 0.0.81, sealed runtime closure, native helper), temp home with synthetic `~/.ssh/id_ed25519` and `~/.zshrc` | macOS 27.2.1 (26B131) arm64, Node 24.15.0, `/usr/bin/python3` 3.9.6, device 0.1.0-rc.14 from the worktree | `packages/testing/test/device-mac-backend.test.ts`: **4/4 passed** (support report, full conformance with the stated macOS fields, background test-runner task started, tailed and stopped by exact ref while a sibling keeps running, Full access refused once the owner ceiling forbids it), 173 s |
| (a′) macOS regressions | same | `pnpm exec vitest run packages/device`: **565 passed, 1 expected fail (finding 2), 1 skipped**, 44 files |
| (b) local Linux host backend and Docker-mode device (local-Docker backend) in a hardened container | Docker 29.9.3, linuxkit kernel 7.0.14 (linux/arm64), Landlock ABI ≥ 6 | `device-linux-backend.test.ts` + `sandbox-linux-runtime.test.ts` + harness self-test: **32 passed, 3 skipped**. Skipped: two "runtime is required" guards (only with `CAPYBARA_TEST_REQUIRE_LINUX_RESTRICTED=1`) and the bind-mounted variant (unavailable here, see below) |
| (b′) sandbox-docker provider, real image and socket proxy | plugins `84a5307`, sandbox-docker 0.1.0-rc.19, plugin-sdk 0.1.0-rc.32 / testing 0.1.0-rc.24 from npm, image built from `plugins/sandbox-docker/image/Dockerfile` (debian trixie-slim `sha256:62bd423a…`) | `plugins/sandbox-docker/test/permission-scopes.test.ts`: **42 passed, 1 skipped** (required-runtime guard) |
| (c) E2B live | sandbox-e2b 0.1.0-rc.19, template alias `capybara-sandbox-0-1-0-rc-19` (image `ghcr.io/capybara-hq/capybara-sandbox:0.1.0-rc.19`), template kernel Linux 6.1.189+ x86_64, Landlock ABI 2 | permission live suite **17/17 passed**: restricted reported unavailable ("Landlock ABI 2 is below the required 6"), conformance fail-closed branch passed, Full access behaviour, revocation, background, lost ack, cleanup. Owned VM `i1l0c4grb1hgzgaom79ua` was deleted and verified absent. Base live suite **17/17 passed** (abort and timeout kill the command) |

The first E2B attempt ran both live files at once. Their concurrent template builds cancelled
each other ("build was cancelled"), failing 16 tests. Rerunning the files one after the other
passed both, so this was not a provider defect.

## Unavailable environments and gaps

- **macOS allowlisted-name positive:** no hermetic way to lead a valid allowlist name to the
  endpoint without editing `/etc/hosts`. This Mac's DNS returns fake `198.18.x` addresses (a VPN,
  left untouched), and SRT refuses an allowlisted name that resolves to loopback, by design.
  `namedReach: "unavailable"` skips only the by-name positive. Every negative ran, and the
  granted endpoint saw no connection. The positive reach is covered by the device test
  "overlapping real immutable workers retain their separate network grants" (IP-literal grant).
- **macOS `outside` ptrace/environ probe:** omitted. It reads Linux `/proc`. Full access shares
  the device's OS user, which can signal or trace its processes: known limitation M5.
- **macOS regrouped descendants:** outside the contract (`regroupedDescendants: "not-promised"`).
  The hang they cause is finding 2.
- **macOS conformance runtime:** about 170 s, under the 240 s `testing-container` category
  bound, but close under load. CI (Linux) skips the file.
- **Docker bind-mounted workspace:** Docker Desktop's file sharing drops Landlock rules, so the
  backend reports restricted unavailable and the case skips with that reason. On Linux hosts it
  runs.
- **E2B restricted profiles:** unavailable by ruling (Full access only). The truthful unavailable
  state is verified on the live template and in the kernel and web.
- **Linux local without Docker:** no Linux machine; Linux is covered only by the hardened
  container (b).
- **Real capybara-device process against a full kernel:** the kernel-side tests use the protocol
  3 fake machine. The device-side runs use the real backends in process. No separate
  laptop-to-kernel daemon run was done (that is Task 15's dogfood run).

## Commands (secrets loaded only inside the command, never printed)

```bash
# core worktree
pnpm exec vitest run packages/kernel/test/sandbox/permission-profiles.dual.test.ts --maxWorkers=1   # 6/6
pnpm --filter @capybara-hq/web e2e permission-profiles                                            # 4 passed (setup + 3)
pnpm exec vitest run packages/testing/test/device-mac-backend.test.ts --testTimeout=900000        # 4/4
pnpm exec vitest run packages/testing/test/device-linux-backend.test.ts \
  packages/testing/test/sandbox-linux-runtime.test.ts \
  packages/testing/test/sandbox-permission-conformance.test.ts --maxWorkers=1                     # 32 + 3 skipped
CAPYBARA_TEST_WORKERS=2 pnpm exec vitest run packages/device                                       # 565 + 1 expected fail
# plugins worktree perm/provider-acceptance (origin/main 84a5307)
pnpm exec vitest run plugins/sandbox-docker/test/permission-scopes.test.ts                         # 42 + 1 skipped
(set -a; . ~/.capybara-test.env; set +a; pnpm exec vitest run plugins/sandbox-e2b/test/live/permission-scopes.live.test.ts)  # 17/17
(set -a; . ~/.capybara-test.env; set +a; pnpm exec vitest run plugins/sandbox-e2b/test/live/sandbox-e2b.live.test.ts)        # 17/17
```

Gates: `pnpm lint`, `pnpm typecheck`, `pnpm check` and `pnpm check:english-comments --base
origin/main` pass. `CAPYBARA_TEST_WORKERS=2 pnpm verify` passes: the affected-package tests ran
1136 files, 18412 tests passed, 1 expected fail (finding 2) and 66 skipped. Bootstrap against npm
and commitlint passed too; commitlint gave one pre-existing footer warning on an older commit.
