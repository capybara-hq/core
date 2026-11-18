# Recorded permission context and replay implementation plan

Status: technically accepted on 2026-11-16 after B1–B5 correction review. Implementation starts with dormant Gate9.2 after a fresh zero-drift baseline; later authority/producer integration remains bound to Task8. Spec: [recorded permission context](../specs/2026-11-16-permission-context-replay-design.md).

## Gate 9.0 — freeze shared inputs before code

1. Consume accepted Task 7 commit `ce94b4d2bd0f0e35e3cb5f413406cab5441ee237`, `task-7-accepted-binding.json`, `task-7-accepted-rereview-1.md` and `task-7-accepted-wire-handoff.md` (hash cab311e12f366005843fbee985fd2888d02421740d7c1843ef0fde3ee2160063). I1–I3 and file-only clarification are closed. Current primary integration is 55979ebb89fe1a7bd730e5f5c854d0b6e9b1af1f; the copied older binding's pending-integration note is historical. No fileOnlyRestriction field or prose-derived grant is introduced.
2. Controller reviews this exact design/plan; an independent builder reviews payload bounds, authority/claim order, request-attempt integration and replay semantics. Resolve findings in these documents before implementation. This plan does not ask the user for another product decision.
3. Resolve Task 8 B6 using these two Task 9 documents plus independent acceptance artifact and exact SHA-256 manifest before shared writer edits. Task 8 corrected handoff has technical GO at hash ed0b8e01f4e28ed9646d7703f8ae63206b44c9a728b25c69529f2fd7359b4c52; its plan is 10519e7d7f53395d5ededa42b1220b80ab9a9ad9ec10fb9bc42222379da6a080. That accepted dependency remains frozen. Task 8 supplies applied/held facts and wiring; Task 9 owns event recorder/text/rendering. No second publisher or owner-ceiling API change. Independent Task 8 output transport may proceed; shared writers and paired activation retain their gates.
4. Assign serialized ownership: Task 9 edits `conversations/events.ts`, runtime context/producer and replay files; Task 8 edits `tools/builtins/sandbox/common.ts` to consume the accepted helper contract. The shared lower authority extraction in `sandbox/operation-authority.ts`/its module is a separately serialized Task 9 change after Task 7 acceptance, reviewed against actual admission. Do not let two implementers modify event schemas or common.ts simultaneously.
5. Rebind any subsequent integration from the current combined baseline before implementation. No TransactionHost modification, moving Task 7 worktree-source inspection, SDK/protocol change, migration or live-runtime proof is required by Task 9. Exact commit git-show reads are allowed; no Git mutation. If implementation reveals a dependency change, return a bounded correction to the controller.

## Gate 9.1 — immutable baseline and new failing cases

Immediately before source edits run from the implementation checkout root:

```sh
pnpm exec vitest run packages/kernel/test/evals/reconstruct.test.ts packages/kernel/test/tools/rename-compat.test.ts
```

Record exact commit, command and result. Earlier reported 62/62 is historical evidence, not this implementation's baseline. Do not regenerate or alter old fixtures to obtain passing output.

Create `packages/kernel/test/runtime/permission-context.test.ts` as an integration test (default project, one real app per file) covering recorder and request integration. Pure renderer cases may live in that file to avoid a gratuitous new unit portfolio entry. Put actual two-kernel race/claim cases in `packages/kernel/test/runtime/permission-context.dual.test.ts` and register it in `packages/kernel/test/container-tests.json` in the same change. Existing runtime/model fake helpers and provider capture are preferred; no arbitrary sleeps or per-test timeout overrides.

Add red cases in existing `test/evals/reconstruct.test.ts` and `test/evals/run-replay.test.ts` for the new behavior and absence-of-behavior constraints. Before implementing each piece, demonstrate the relevant new assertion fails for its intended reason (not import/compiler/setup failure). The exact matrix follows below.

## Gate 9.2 — schemas, pure rendering and diagnostics

Owned source:

- `packages/kernel/src/conversations/events.ts`: new strict `permission_context` v1 payload; marked managed `device_paths` union branch; optional request permission metadata. Serialize this edit after accepted Task 7 event work. Preserve old profile/review events as non-model-visible.
- New `packages/kernel/src/runtime/context/permission-profile.ts`: complete snapshot renderer, fold/latest, canonical payload hash and rendered-contribution metadata helpers from design.
- `packages/kernel/src/runtime/context/device-paths.ts`: marker-only new branch and full-payload change helper; preserve old text, helpers, comparisons and keys exactly for old payloads.
- `packages/kernel/src/runtime/context/build.ts`: normal ordered case, summary restoration after paths/before plugins, metadata collection only for new markers. Preserve initial system segment and compaction transcript behavior.
- `packages/kernel/src/evals/reconstruct.ts`: add ordered `permission_profile_changed` reason and executable metadata comparison, shared pure checker exported if full-run diagnostics need it.

Required tests: byte equality for old roots-only, tier/isolation, auto local, sandbox local and cloud device-path events; audit-only profile/review events do not render; absent new metadata stays absent. New event/schema bounds reject malformed/oversized arrays and mixed marked+legacy shape. Normal latest state and A→B→A rendering are append-only. Summary before/at/after the transition restores only latest covered complete snapshot and then renders later changes. Candidate instructions/model changes preserve recorded permission input. Unchanged new snapshots reconstruct with `drift:[]`; missing/altered context, changed managed paths and bad active locator produce exactly the new reason as applicable. Old logs without new markers remain zero drift.

Review this pure/schema delta before wiring a live publisher. It may land dormant without claiming feature completion.

B5 additions: literal expected-output table across local/cloud × restricted/Full and all four availability states, including scope-null nonsupported cases; exact quote/newline/control/markup escaping; rejection of inconsistent effective/selected profiles, null fields, filesystem/network/outer combinations and unnormalized arrays. Hash tests use frozen canonical tuples, reordered object keys, normalized array order, explicit null versus omitted, predecessor 0 and full 64-hex hashes. No historical expected bytes change.

## Gate 9.3 — one authority projection and fenced recorder

Owned source:

- `packages/kernel/src/sandbox/operation-authority.ts`, `permission-facts.ts` and existing module: extract the call-independent portion of accepted snapshot for admission/readContextLocked; add B1's exact readAppliedEnvironmentLocked adapter to Task 8 installed binding/current attestation. Put shared PermissionContextSubject/HeldDeviceContextEvidence types in new sandbox/permission-context-types.ts, not a runtime service import. No policy duplication, call expansion or fabricated call. Review alone as a trust-boundary change.
- New `packages/kernel/src/runtime/permission-context.service.ts`: `record`/`appendLocked` contract, real execution claim, ordered authority prelude, publication check, recorded comparison/append under conversation lock and after-commit notify.
- `packages/kernel/src/runtime/runtime.module.ts`: one provider with explicit imports/injection. Lower authority module must not import runtime or tools to call this recorder.

Use currentRun execution identity as identity only, then PG validation. No `runOutsideTransaction`, authority acquisition inside an already entered claim transaction, temporary handle scope, cache or per-process revision memo. Old→new, same-value/no-op and A→B→A dedupe are persisted-log decisions. Initial discovery and one bounded changed-subject retry occur outside the new transaction; abort/replaced claim/deletion never append.

Required tests: real running claim; same payload no extra event; profile/authority revision changes; rolled-back append; two replicas racing same predecessor (one snapshot); stale/replaced claim cannot append; changed device during initial discovery cannot acquire out of order or log mismatched facts; authority writer versus context recorder completes in fixed order. Inject readiness barriers, capture distinct kernels/pools; do not substitute two objects over one transaction host. A recorder call with no inherited claim wrapper cannot mutate even when given a plausible input.

Cases also cover unbound/no device, suspended/unprobed and unsupported provider (zero create/resume/probe/prepare), root/child live inheritance, scheduled root and scheduled child/wake with actual `scheduled_task_run_id`, explicit task grant narrowing, stale Full consent, nonowner trigger with owner Full (effective unavailable, no copied owner scope), and restricted-only authority revision changes. Compare context base rights with actual accepted admission projection; no call expansion leaks into the next request or another child.

B1 additions: Full-only/restricted-only/neither/both reports against every effective profile; stale Full→Approve on Full-only report; scheduled child/wake on Full-only report; stale/current runtime identity, installed/pending binding, and desired-but-unapplied outer boundary. Missing applied evidence yields unprobed/null scope. Test exact no-device/access null fields, missing actor as no-send, actual scheduled-run host grants, and method-specific optional support. No provider/probe/create/resume/prepare invocation by the reader.

## Gate 9.4 — every actual agent request and Task 8 writer

Owned runtime source:

- `packages/kernel/src/runtime/model-call.ts`: callback/refresh adapter and named no-send error mapping at fit. Add ExecutionRevoked identity bypass before signal/classification; private callback error→RunError before classify. Reread only when callback exists. Keep loadMedia outside callback adapter and preserve provider/media fallback. Every post-compaction rebuild passes this boundary.
- `packages/kernel/src/runtime/run-steps.ts`: live dependency injection; production switch serialized with Task 8 activation.
- `packages/kernel/src/runtime/runtime.module.ts`: final wiring if not already dormant.

Task 8-owned shared edit, after this contract is accepted:

- Task 9 creates `sandbox/managed-device-context.ts` and `managed-device-context.module.ts`: real injected transactional recorder with DB/TransactionHost/EventLog.appendIn/authority/publication/facts dependencies. Its leaf module has no RuntimeModule import.
- Task 8 edits `tools/tools.module.ts`, `tools/builtins/builtin-tools.ts`, `tools/builtins/sandbox/common.ts` to inject/pass the required activated ManagedDeviceContextPort. It adds kernel-private contextEvidence to SandboxUseInfo/entry plumbing in sandbox.service.ts from already-held installed instance/generation/binding/provider and actual working root. No SDK field. Serialize these files with Task 9. Record before preparation/user callback into actual child log; no legacy latestOfType escape.

Capture actual provider requests. Barrier test: hold request A streaming, change root profile, prove A's stored request/bytes unchanged, release it and prove B appends the new context. Include profile change during retry delay/provider fallback, forced compaction and wrap-up; the boundary must run per construction, not only per run or step. Snapshot linearizes at the recorder commit; a change after that affects the next construction, while operation authority remains independently fresh. Changing profile must not modify an admitted task's recorded starting grant or falsely claim it was stopped.

A newly activated request may contain historical old-mode lines in its prefix; the appended v1 permission context explicitly supersedes them for future operations. A managed call with identical paths still emits old→marked transition. Summary restoration preserves that distinction. Test real `common.ts` writer with an outside-workspace selected project; do not claim default workspace/tmp write access unless in the actual base authority.

B2 additions: original ExecutionRevoked reaches RunWorker with no send/stale terminal event; publication/churn/storage/malformed failures have named no-send RunError outcomes, no provider classification/fallback. One rediscovery only. Absent callback preserves evs/toSeq/bytes. Two same-attempt fits separated by change record A then B; fixed absorption and tool/media pairing remain. Change in model.request hook leaves already-built request unchanged; next fit observes change.

B3 additions: actual injected common.ts recorder under real withClaim; two kernels race one predecessor; same device/identical roots but replaced generation/binding between discovery and append fails before callback; missing writer fails before preparation/user callback; rollback notifies nothing; failed afterCommit notification never retries callback/effect; no provisioning or whole-handler replay repairs stale evidence.

Dormant code may be verified with injected scoped dependencies. Do not turn on production recorder alone while tool execution is still legacy. Actual Task 8 phase-8.6 activation and Task 9 producer wiring form one reviewed cutover; absence of provider/runtime prerequisites keeps both dormant.

## Gate 9.5 — recorded-only full-run replay

Owned source:

- New `packages/kernel/src/evals/recorded-permission-context.ts`: exact B4 sparse-coordinate table and monotone visibility algorithm, strict seq<R seeds, target-run seq>R feeds, min(toSeq,callSeq-1) bounds, persistent source-seq idem mapping and undefined feeder for old unmarked recordings.
- `packages/kernel/src/evals/run-replay.ts`: extend loop dependency pick, install recorded feeder, retain existing absorbable-input schedule, and propagate pure recorded-context drift diagnostics.
- `packages/kernel/src/evals/worker.ts`: strip live permission recorder explicitly before copying loop dependencies. Preserve the existing removal of hooks/progress/forks and eval claim/budget checks.
- `packages/kernel/src/evals/recorded-tools.ts`: full marked paths; optional typed ReviewRecord in accumulator/RecordedCall, structured-copy original and verbatim matched result review. Absent/unmatched stays absent; never add to content/matching/metadata or reenact effects.

Test baseline full-run replay across initial/new/mid-run profiles and summaries, child and schedule cases. Mutate current root/profile/device/report/grant DB values after taking the snapshot, then reconstruct and replay: requests use recorded permission content. Install throwing spies at live recorder, reviewer, permission preview/admission, provision/resume/probe and actual device-operation entrypoints; none may run. Parent replay creates no child or background task. Review allow/deny/ask result evidence is reused, and a denied result does not become an allowed effect under today's Full.

Cover multiple original attempts within one step; generated extra retry; candidate ending early; generated extra step; no future-context early feed; repeated build after compaction dedupes. Extra generated attempts/steps retain last known recorded context as defined, not current policy. New recorded corruption produces permission drift without fetching live facts. Existing pre-rename/pre-background/pre-skills fixtures stay unchanged. Old full-run recordings produce no new default profile lines.

B4 additions: original first attempt 2 maps generated attempt 1 to first actually sent request of that step; interior gap uses preceding same-step attempt; missing step uses preceding step only; before-first-step/no-request feeds nothing; extra steps use last request. Prior-run seed copied once, target-run A/B snapshots retain source order. Reentry recovers original→generated mapping from idem keys. Original diagnostics use original bounded range/summary/absorption; tampering is caught even as generated seqs differ. Candidate compaction must not compare generated hash/locator to original. Matched review retains profile/revision/source; old no-review result remains absent. Throwing live-effect spies remain compulsory.

## Gate 9.6 — verification, documentation and acceptance

Run both required zero-drift groups again, the new runtime and dual files, and full-run replay tests. Include existing subagent/schedule suites if the shared authority extraction touches those paths. Run focused TypeScript/lint checks and relevant repository checks, then the required `pnpm verify` selection on the combined branch once prerequisites are integrated. No tests were run while preparing these documents.

```sh
pnpm exec vitest run packages/kernel/test/evals/reconstruct.test.ts packages/kernel/test/tools/rename-compat.test.ts packages/kernel/test/evals/run-replay.test.ts packages/kernel/test/runtime/permission-context.test.ts packages/kernel/test/runtime/permission-context.dual.test.ts
```

Add a kernel patch changeset and update `.agents/skills/replay-evals/SKILL.md` with the exact new event/metadata/replay/old-byte rules after behavior is accepted. No SDK API generation is required for kernel-private types. Keep review provenance truthful: dormant support and zero-drift tests do not prove production provider isolation. Linux restricted support was out of scope here (delivered later: Linux restricted support is delivered: the Linux restricted launcher was proven on Docker (aarch64) and on a CI x86_64 runner (Linux 7.0, Landlock; evidence commit 63a449ae1, `VALIDATED_ARCHES` covers both), and the Linux and local-Docker operation backends (permission activation W2-S, 427f19362) run on it).

Final report records source binding, before/after command results, unchanged fixture evidence, trust-boundary and independent builder verdicts, Task 8 paired writer/activation status, and any remaining provider gate. Root owns commit/integration. Intended implementation commit remains `feat(runtime): log permission context for replay`; a dormant-only subset must be described as such. Do not call the feature delivered while activation or required provider work is outstanding.
