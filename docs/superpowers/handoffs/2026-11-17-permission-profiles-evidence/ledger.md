# Ledger (resumed 2026-11-16, new machine; handoff f3c8e1402)
- PR 320 merged 37094e799 (all required checks green, head ae01833a9).
- Worktrees recreated: primary .claude/worktrees/docs-conversation-permission-profiles (f3c8e1402),
  transport .claude/worktrees/codex-permission-output-transport (3001ad382).
| Task | Files | Risk | Wave | Review |
|---|---|---|---|---|
| 9.2 close gap + matrix + warnings | primary: runtime/context, evals/reconstruct, conversations/events, tests | high | 1 | opus alone |
| 8.1 independent review | transport worktree, read-only | high | 1 | (is the review) |
- 2026-11-16 user ruling: the "platform-blocked" Linux same-pinned-root proof was a Codex platform
  access control; it does not bind this session. Linux confinement proof is back in scope (plan order),
  done for real on local Docker; product constraints (no seccomp/cap relaxation, no mocked proof) stay.
  Update PLATFORM HELD wording in docs only after a real proof lands.
- 8.1 independent review: CHANGES_REQUIRED (I1 fence drops results/kills cmds on reconnect, I2 transport
  before holder -> untyped errors; M1-M9). Fix dispatch: I1,I2,M1-M7,M9. M8 (v2 stop/killAll/killTagged
  rejected by staged drain) recorded as explicit 8.6 activation gate.
- 9.2 fix bbcd3b92d (221/221). Independent review APPROVE as dormant checkpoint. Folded minors:
  M1 marker check into shared permissionContextHistory (live build) -> before 9.3 producer;
  M2 RecordedPermissionContextError -> registered 4xx eval.snapshot_invalid or classify -> 9.4;
  M3 DriftReason i18n/parity/skill list -> with first reachable producer; M4 reuse coversHost.
- PR 316 merged 6f40dd433 (release rc). Registry verification pending.
- Release verified on registry: sdk rc.25, kernel rc.35 (visible ~4 min late), testing rc.20, plugin-tools rc.15, device rc.13, model-fake rc.26; provenance ok; outside-workspace install dedupes. Images rc.36.
- 8.1 fix 31dc64cbf; re-review APPROVE (740 local-devices/device tests). 8.6 activation gates:
  M8 (v2 stop/killAll/killTagged vs staged drain), N1 pending sweep/cap, N2 StagedSessionState per
  credential, graceMs = reconnectGraceSeconds*1000, queued non-read stale-label refusal -> held unknown.
- Wave 1 complete: merge 58a278042 (8.1 into primary), flake split a5185eb77; 3701 tests green.
| Task | Worktree / branch | Files | Risk | Wave | Review |
|---|---|---|---|---|---|
| 8.2 durable launch + artifacts | perm-t8-2 / perm/t8-2 | kernel background/*, bash bg, migration 0143, kernel-schema | high | 2 | opus alone |
| 10B three choices via design slots | perm-t10b / perm/t10b | apps/web components, messages | normal | 2 | sonnet |
| 2b Linux restricted source + conformance | perm-t2b / perm/t2b | plugin-sdk linux runtime source, testing conformance, API snapshot | high | 2 | opus alone |
Base for wave 2: a5185eb77.
- 10B done f0584546f (4488 web+design). Visual gate (Linux COMPARE, visual-update baselines) pending on CI. Flake noted: apps/web change-password.test.tsx failed 2 under load once -> investigate.
- 10B review APPROVE; merged into primary. Minor M2 (usePermissionChoice initial only at mount) -> 10C/D; M1 serial GET -> PR note. check-row flake fixed (clock cache).
| 9.5 recorded full-run replay + 9.2 M1/M2/M4 | perm-t9-5 | kernel evals/*, runtime/context permission-profile/build, events.ts | high | 2b | opus alone |
- 2b done 95395bf47 (Docker aarch64 14/14 x5). Gates: x86_64 unvalidated (reports unavailable) -> run conformance on CI x86_64 runner; metadata outside roots not mediated (judge vs spec). Flake noted: plugin-sdk sandbox-native-helper.test.ts 5s timeout under load.
- Flake detail: testing/sandbox-native-helper 'ordinary native semantics' = one conformance run spawning >25 python3 procs; always >5s at load ~25 (own agents). Re-measure when idle; fix structurally (split conformance cases or cheaper spawns), no timeout bump.
- 8.2 fix 72395058d, re-review APPROVE; merged 4c7a69a89 (kernel 2068 + unit 1388 green). Folded into 8.3:
  R1 claimReconciliation in-flight marker, R2 stop check in claimReconciliation, M6 stopper/readLive/
  cancel-pending terminal. Into 8.4: exact background.stop in revoke worker, call-grant lookup incl
  background-running, B3 selectors.
- 9.5 done af9404023 + dd6d42686 (452 tests). Feeder unwired until 9.4 (needs e2e assertion then).
| 8.3 consumers/cursor/exact completion + R1/R2/M6 | perm-t8-3 | background/{session,status,poll,tasks.service,stop,finish,store}, tools sandbox task-*, bash | high | 3 | opus alone |
- 9.5 review APPROVE (5 minors). F1/F2/F4 fixed by implementer now. Deferred to 9.3/9.4: F3 add throwing
  spies (PermissionProfileStore readRoot/readOwnedRoot/own, PermissionCallGrants, PermissionRuntimeReports.record,
  SandboxService prepare/pathLease/destroyDevice/resetFileSystem, approvals) + mutate device/grant/report rows;
  F5 live recorder fail-closed guard for eval conversations; map live RecordedPermissionContextError ->
  run.permission_context_invalid; 9.4 e2e: target-run context reaches generated request + metadata locator.
- 2b security review CHANGES_REQUIRED: I1 unix SOCK_RAW, I2 unix pathname connect in environment mode, I3 supervisor loss orphans. Decisions: restricted none/allowlist binds loopback only (M1); M2 metadata visibility accepted+documented; x86_64 table added, evidence from CI x86_64 runner only (qemu not valid).
- 9.5 fix 41bb24645 checked by controller; merged 98c8d554f (580 tests, typecheck, check green).
- USER ASK: when 8.4-8.6 + 9.3/9.4 are active on macOS local device, REMIND user and prepare a dogfood trial (Capybara runs a small real dev task on this Mac: approve-for-me/request/full, background pnpm test, replay eval after). Dev stack starts only then.
| 10C atomic first send | perm-t10c | apps/web new chat/composer/conversations, kernel first-message if needed | normal(+consent) | 3 | opus |
- USER UPDATE: no intermediate macOS-only trial; run the real dogfood dev-task scenario as final acceptance AFTER everything is implemented (supersedes the earlier remind-at-8.6 note).
- 2b fix1 af124224c (aarch64 17/17 x5). x86_64 table added, gated by VALIDATED_ARCHES until CI evidence (needs Landlock ABI6 => kernel>=6.12 on runner). Machine load hit 186: cap parallel test runs (CAPYBARA_TEST_WORKERS=2 for agents).
- 2b re-review1 CHANGES_REQUIRED: I1-r socketpair dgram sendto escape, M1-r AF_UNSPEC listen autobind 0.0.0.0. Fix round 2 dispatched + CAPYBARA_TEST_REQUIRE_LINUX_RESTRICTED switch. Controller owns CI x86_64 evidence job (kernel>=6.12/LSM, docker seccomp allows landlock+listener, ghcr image public).
- 2b fix2 e6e4bd142 (Docker 19+1skip x3). CI facts: runner kernel 7.0.0 (aws/azure), ghcr capybara-sandbox:0.1.0-rc.15 public with amd64. Plan: after re-review2 APPROVE, temp branch ci/linux-restricted-evidence with push-triggered workflow + REQUIRE switch; collect; delete branch; evidence commit flips VALIDATED_ARCHES.
- 8.3 review CHANGES_REQUIRED (I1 TaskOutput settles cancel-pending from status). Fix round dispatched (I1,M1-M5,M7,M9,M10). Deferred: M6 lost managed records consumer + hard-delete cascade -> 8.4/8.5 handoff; M8 partial-prefix on abort (only tiny capacities) recorded.
- 2b merged 2590c8723. x86_64 evidence: run 43906202355 (Linux 7.0.0-1019-azure, landlock LSM, builtin seccomp,
  amd64 image) 19 passed + 1 guard skipped with REQUIRE switch. Evidence commit 63a449ae1 flips VALIDATED_ARCHES.
  Temp branch ci/linux-restricted-evidence deleted. Docs' "PLATFORM HELD" wording to update in final doc pass.
- 10C review APPROVE. Slice D blocker: initial full-access without consent (M1). Task 14: e2e journal/queue
  evidence (M6). Minors 2/4/5 (+3 optional) being fixed.
- 10C fix 0ecb95471; merged 9a519a376 (web+design 5074 green). | 10D live PATCH/SSE/supersession + 10C M1 blocker | perm-t10d | apps/web (+kernel conversations SSE if needed) | normal(consent) | 3 | opus |
- 8.3 fix2 86b893203, re-review2 APPROVE; M11 floor fix 854a13865 (controller, RED verified). Merged e6a08b949
  (263 + unit 1457 green). Deferred to 8.4/8.5: M6 (lost records cleanup, hard-delete cascade), M1 residual
  (dead retry dispatcher stays dispatching until revokeHolders/expiry -> PR note), suspended owed stops hold maxTasks.
| 8.4 lifetime/owner contract/identity/revocation (B1-B4) | perm-t8-4 | device cli/client/server-ops/commands, runtime-manifest, kernel local-devices, sandbox modes/publication/ceiling writes, config schema, revoke worker, runtime waits/run-deletion | high | 4 | opus alone |
- 10D fix c0f107524; merged d8974c706 (web+design 5109). Remaining for Task 10: Slice E (needs 8.4 B2 owner contract), visual-update, Task 14 e2e.
- Task 11 split PR #336 (feat/sandbox-linux-runtime from main: 2b + x86 evidence cherry-picked; README conflict
  resolved keeping main's double-boot rule). Verified locally.
- 8.4 PARTIAL: 3069b5d00 B3 exact revocation + M6 consumer, 3ef9ae9e5 staged graceful drain, 473486522 real
  org writer test. Remaining: B4, B2, B1, production lifecycle wiring. 8.5 handoff: revoked backgroundStart
  intents with execution_ref whose generation/provider no longer runs.
| 8.4a review (B3+drain) | perm-t8-4 read-only | high | opus |
| 8.4 B4 identity/bindInstance/manifest | perm-t8-4-b4 | high | opus |
| 8.4 B1 config migration via 6c publisher | perm-t8-4-b1 | high | opus |
- 8.4a review CHANGES_REQUIRED: I1 drain refuses admitted retries, I2 drain false pending, I3 B3 evidence (outbox->worker, real admission now; owner writer after B2 => B3 stays open). Bug found+fixed by controller: 614325137 device runtime bundle 2 (mac backend 'Unsupported runtime bundle'; Linux CI can't see mac-only tests). PR #336 unaffected (main device doesn't consume the bundle).
- 8.4a re-review APPROVE; R2 fix 3de53b43b (controller); merged 1d4e87587 (786 green). B3 open: B2-format owner
  writer, disconnect/reconnect revocation, platform writer e2e; R1 (SQL-seeded local_policy/approvals) -> B2.
- B4 done (fe24223ec, f24188071, 124eb1f9b; mig 0146) -> independent review running. Fixed v2 bug: jsonb root key
  order reset Full consent on every reconnect.
- B1 done (2655a9848, c04a4d1e8, 2ea4298d3; mig 0145). Open: production snapshot() driver (8.6 barrier),
  cloud ownerCeiling PATCH, provider-update reconcile path (B4 instance writer), old-replica write fencing at deploy,
  auto_mode error code rename (8.6/10E/B2).
- B4 review CHANGES_REQUIRED (I1 two supervisors on one journal, I2 binding deadlock, I3 manifest vs published ranges). Fix round dispatched. 8.6 blocker: runtime closure verify->launch TOCTOU. Found unrelated main flake on release PR #337: duplicate title job when a second run completes while attempt N is in flight (real product race) -> fixing on fix/subagent-usage-flake.
- B1 fix2 c674362fa checked by controller (R1 409 removed -> narrower write; R2 environment exec revoked under outer allowlist). B1 accepted; 8.6/B4 obligations: acquire-path reconcile check, snapshot driver, cloud ownerCeiling PATCH (B2), provider outer limit comparison.
- Release #337 merged by another line (fa0bb3c5e); release run 44040440995. B2 done (9777d1470,b3b31737b,4789e33b4; mig 0147); merged B1+B4 fixes into perm/t8-4-b2 (1999 kernel + 1476 unit green). B4 re-review: N1 (env fingerprint compare vs uninstalled previous) Important; R1 undeclared kernel->device test edge; R2 machine_id relogin; R3 mac flakes; R4 Apache modification notice. I3 vendored closure accepted.
- B2 review CHANGES_REQUIRED (I1 unblock resets consent, I2 out-of-order blocks, I3 PATCH on unsnapshotted cloud widens network [live], I4 sidecar repair, I5 platform/org Full-off misses external restricted work). Fix round dispatched. Deferred: M5 web i18n (10E), M6 DEFAULT_POLICY (8.6/10E).
- Task 11 DONE: sdk rc.27 / testing rc.21 / kernel rc.37 on npm, provenance ok, outside install verified (bundle v2, both arches, runSandboxPermissionConformance). Task 12 started: plugins worktree feat-sandbox-docker-permission-scopes.
- B4 ACCEPTED: rounds 2-3 e366658dc, 6acde42d8, 8f03df3d1 (re-review2 APPROVE; R5-R7 closed by implementer with REDs). Pending merge into perm/t8-4-b2 after B2 fix round. 8.6 blocker kept: runtime closure verify->launch TOCTOU.
- B2 ACCEPTED: fix1 28ff1e55c/9521e69f6, fix2 3e12834e6 (R1 regression closed, verified by controller).
- 8.4 B1/B2/B4 merged into primary bc6d28ce2 (typecheck/check/unit 1476 green; full kernel + other suites running).
  Remaining before 8.6 (activation blockers list):
  * B3: revocation across disconnect/reconnect on real device/staged session; platform writer e2e via worker.
  * B4: runtime closure verify->launch TOCTOU; bindInstance/legacy gate wiring (8.5 seam); drain refuses bindInstance.
  * B1: snapshot driver at cutover barrier; acquire-path reconcile_required check; provider outer-limit compare.
  * B2/10E: web i18n for new error codes + audit action; new-install DEFAULT_POLICY {false,workspace} + copy.
  * 8.1: M8 v2 stop/kill frames vs staged drain; N1 pending sweep; N2 per-credential session state; graceMs.
  * Production wiring: commands/start binder, DevicePolicyService v3 send, gateway connectionId to recordHelloV3/PolicyV3.
- Full-suite run on primary after 8.4 merge found: (1) REAL bug since Task 7: Redis-free CLI (admin create/grant,
  openKernelCliOverPool) DI failure -> ab911e315 (PermissionCeilingWritesModule split, optional bus, outbox in
  overPool); (2) missing web copy for 4 device error codes -> 948eebb43; (3) native conformance flake -> listed in
  testing container project 5fdd? (see git log). ctx/queue delayMs timing flake under load: watch.
| 8.5 legacy retirement + fail-closed reuse barrier | perm-t8-5 | background/retire-legacy-tasks.job, retirement store/schema (mig 0148), sandbox.service gate, worker/outbox registration | high | 5 | opus alone |
- Task 12 done 6f2e3e3 (plugins). Review CHANGES_REQUIRED: I1 forgeable bg records (repro), I2 Full bg races, I3
  tombstones on tmpfs. Fix round dispatched. Follow-ups: core testing rc.21 bugs (conformance granted.host name vs
  address; waitFor hang) -> core PR on main; M6 launcher /proc readable (restricted sees sibling Full cmdlines)
  -> core launcher follow-up; M5 Full shares uid (exact-ref trust bound) -> Task 14.
- Primary full suite after fixes: 12660 passed; 2 non-reproducing failures (ops-domains-rest testcontainer port bind timeout under load; channels supervisor-share.dual 6 vs 5, other line's area) - both pass on rerun 15/15. Report supervisor-share flake to user/other line.
- 8.5 done 22617f83b. USER DECISION 2026-11-17: local legacy obligations clear on authenticated boot-ID evidence
  (device reports boot id in hello; changed boot id => OS instance replaced => obligations resolved); user-facing
  copy "restart this computer to finish the upgrade". No owner manual override.
- Core conformance fix 38dba683d + 7c913838a (endpoint name/address split, waitFor bound to op; M6 /proc limit
  documented, cannot be narrowed safely under Landlock). Plugins test needs update after next testing rc.
- Task 12 fix1 142c948 (records root-owned on skills volume, Full bg races, tombstones survive restart, nonce).
- PR #339 merged (conformance endpoint name/address, waitForFile, proxy raw-connect assertion, /proc limitation doc). Next testing rc via release PR; plugins Docker test to migrate.
- Task 12 re-review1 APPROVE; fix round 2 for R1 (FIFO -> SO_PEERCRED socket), R2, R3, R4 spool bound, R5, R6 dispatched.
| 9.3 authority projection + fenced recorder | perm-t9-3 | sandbox/operation-authority, permission-facts, permission-context-types, runtime/permission-context.service, runtime.module | high | 6 | opus alone |
- 8.5 boot-ID evidence 2256b2447. Controller ruling: evidence is the OS instance — any current machine of the device reporting a boot ID different from the obligation's resolves it (re-login must not deadlock); same boot ID -> restart_required.
- 8.5 review CHANGES_REQUIRED (C1 gate open until worker scan + SID cleanup erases rows; I1 ifRunning/browse ungated;
  I2 null-SID generation guessed). Rulings: keep broad enumeration (one reboot per local device with legacy rows);
  unknown-boot obligations never resolve -> distinct error "delete device and reconnect as new"; cutover order:
  device build reporting boot IDs first, confirm, then freeze; remove macOS kern.boottime fallback; suspended-cloud
  destroy accepted (8.6 follow-up: exact cancel on resume).
- Task 12 re-review2 APPROVE (R1 attack blocked). Fix round 3: R7 pre-connect race (accept byte + stdin token),
  migrate to testing rc.22. Core launcher follow-up (8.6 list): make restricted launcher/broker non-dumpable so a
  same-uid Full process cannot ptrace them (no Yama). Task 14: confirm kernel never leaks execution UUIDs.
- Release #340 merged b14c96069: testing rc.22 + sdk rc.28 on npm (conformance endpoint fix). Plugins Task 12 migrating.
- 9.3 APPROVE; merged 077de1ac9. Into 8.6/9.4 list: M1 cloud context always unprobed (needs cloud applied-limits
  evidence from Task 8 or explicit acceptance); M2 admission must share readAppliedEnvironmentLocked; M3 rename cloud
  desired-but-unapplied test; M4 soft-deleted device copy; M7 eval refusal should check root.
- 8.5 re-review1 APPROVE. Rulings: cloud unknown obligations resolve on confirmed current destruction + no prev_handle + recorded after freeze, plus cloudUnknown precheck; deleted devices -> 'abandoned' state (not retired, operator ack at release gate). Fix round 2 dispatched.
- Post-9.3 runtime batch: 3 load failures (reconstruct 'clamped output cap', run-worker 50 steps, subagents/cancel delete root) all pass on rerun 110/110. Investigate reconstruct load sensitivity later (zero-drift test should not be timing-dependent).
- 10E done 780ce49bf (review running). Kernel gaps into 8.6 list: device read view should expose
  permission_reconcile_required; add device.owner_ceiling_changed to MODE_CHANGE_ACTIONS + web label; web copy for
  device.replace_required after 8.5 merges; B2 M6 new-install default {false, workspace} in packages/device; legacy
  local narrowing via mode:"sandbox" must be kept/replaced at 8.6; dev catalog device-blocks still old badges.
- Task 12 fix3 8bf494b (R7 accept byte + stdin token; migrated to testing rc.22/sdk rc.28 with access proxy through the real forwarder). Final re-review running.
