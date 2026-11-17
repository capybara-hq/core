# Permission profiles: model handoff, 2026-11-16

## Read this first

The user requested a quota handoff after the nearest coherent small tasks: commit and push the
checkpoints, then supply a continuation prompt. Implementation is **not complete** (roughly 50%
by remaining work, not by test count). No new feature work should be inferred from this checkpoint.
The user previously approved the design and plan, requested subagents, authorized continuous work
until completion except necessary decisions, and authorized merging ready PRs. Do not ask them to
approve the same design again. Follow the repository's design, implementation and review gates.

This document is the durable entry point. Adjacent
[evidence](2026-11-16-permission-profiles-evidence/manifest.json) contains frozen reports, manifests,
the exact unreviewed transport delta, the replay checkpoint delta, and the Task 10 planning material.
The files are committed; do not apply those patches again. Exact patches and the full replay report
are gzip-compressed to preserve diagnostic/context whitespace; use `gzip -dc <file.gz>` to read them. Reports preserve historical paths and
statuses, so this document takes precedence for handoff status. Larger local records remain under
`.superpowers/sdd/2026-11-16-permission-profile-delivery/` in the worktrees; that directory is ignored
and is not a remote backup. Never assume temporary files survive a machine change.

## Branches and checkout locations

Repository: `capybara-hq/core`. Never push directly to main. Keep the main checkout on main.

| Purpose | Branch | Source checkpoint | Existing checkout |
| --- | --- | --- | --- |
| Main | `main` | `62d1deea7c4406539fb8aaaaa2fcb7a8483a8227` | `/Users/grant/Capybara/core` |
| Primary feature and this handoff | `docs/conversation-permission-profiles` | `09de26a53a59f43fd6c58c65f5529d0f604340c2` (handoff docs follow) | `/Users/grant/Capybara/core/.claude/worktrees/fix-project-file-read-mode` |
| Transport checkpoint | `codex/permission-output-transport` | `3001ad3824ad80d35dc42005620f47cd45966f70` | `/Users/grant/.codex/worktrees/vpn-web-verification/core` |
| Ready binding fix, PR 320 | `codex/fix-bind-hydration` | `ae01833a9f294120c3164b6dcd7c3adf6829813d` | `/Users/grant/.codex/worktrees/permission-native-sdk/core` |
| Accepted web data foundation | `codex/permission-web-data` | `daac85234` (already merged into primary) | `/Users/grant/Capybara/core/.claude/worktrees/fix-project-context-notice` |

The primary branch includes accepted config/policy foundations, Task 10A and the dormant Task 9.2
checkpoint. It **does not yet include the separate transport checkpoint**. Do not accidentally drop
either side or treat either as a complete activated feature. All three active checkpoint branches
were pushed normally. Resolve their current remote heads before continuing; this document cannot
embed its own final commit hash.

## Approved product constraints

- Conversation presets: `request-approval`, `approve-for-me`, `full-access`; default Approve for me.
  All three controls use the same neutral colors. Full access must not acquire orange styling.
- Device selects where execution happens. Device owner, organization, OS and provider ceilings
  remain independent. Remove everyday auto/sandbox UI; internal ceiling encoding can remain.
- Request approval asks for extra scope. Approve for me uses separate command review: deny means
  deny; uncertain, unavailable, unconfigured or error means ask. Full access skips discretionary
  credential/sudo/persistence prompts and child filtering, under the existing OS user. Explicit
  denials, fixed asks and real owner/org/OS ceilings survive. No root or cloud-host privilege.
- Arbitrary in-project Python and writes may avoid discretionary approval only with real
  confinement. Do not replace confinement proof with a script counter or mocked allow decision.
- Children inherit the live root profile. Unattended schedules need explicit task grants. Started
  work retains its starting envelope; actual ceiling revocation stops precisely affected work.
- Full consent binds stable device/root/semantic scope. Widening or changed identity resets it;
  rename/restart under unchanged authority preserves it. Restricted-only owner/network edits must
  not invalidate unrelated Full consent or running work.
- One environment and filesystem. No per-profile VM/container, detached-process discovery, broad
  PID scan/adoption, weakened host hardening, raw execution fallback or optional readOutput stub.
- Local Full uses host networking; `sandbox.limits.egress: none` does not cut that host network.
  Cloud and restricted execution still obey their actual outer boundary.
- Active device wire remains **v2** until the complete paired Task 8.6 activation gate. Dormant
  codec/transport support is not production v3 activation or a provider capability claim.

## External limitation that must survive the handoff

A Linux same-pinned-root confinement proof/fix follow-up was explicitly blocked by platform cyber
access controls (Daybreak). The user has no confirmed access. **Do not retry, rephrase, delegate,
switch models or use another tool to get around that block.** Ordinary permitted Mac, API, web,
documentation and source-review work may continue. Do not claim Linux restricted/cloud support or
full cross-provider completion based on helpers, ordinary tests or another platform's evidence.
Disclose the held gate when reporting readiness. This is a platform access limitation, not an
assertion that the user's project is unlawful.

## Accepted work and evidence limits

Earlier PRs 314/315 fixed project loading and skill parsing. PR 318 (main `50eaf97c9`) fixed generic
dev CSS/login readiness. PR 317 (main `5408b24e8`) added SDK contracts without activating wire v3.
PR 319 (main `62d1deea7`) fixed a device-detail browser test's lost pre-hydration click. Main's
backstop run `43848265645` completed with all 21 jobs successful at the last verified snapshot.

Accepted feature foundations:

- Config activation 6c: `c9fde6f16`; CAS publisher, effective authority, non-hot activation,
  revocation, Full semantic preservation and bounded PG cancellation. Accepted integration with
  policy used merge `55979ebb89fe1a7bd730e5f5c854d0b6e9b1af1f`, including two reviewed fixture
  corrections; 112 focused tests passed. Do not revive the earlier positional-constructor diagnosis.
- Policy/call grants 7: `ce94b4d2bd0f0e35e3cb5f413406cab5441ee237`; fixed policies precede Full,
  durable starting evidence, terminal human denials survive profile changes, child budget/hooks
  preserve ancestry, and profile/instance writers notify after commit. Source review approved;
  component 360 passed / 24 live skipped; controller 74 passed. Fifteen new test-style warnings and
  narrow fixture-vs-OS proof limits were disclosed, not silently dismissed.
- Retained output 8a: `1f380b456` (preserved branch `codex/retained-background-output`), reviewed
  after three fix rounds; 165 component and 89 controller tests passed. Do not reopen accepted
  component code without evidence from the new transport delta. Native helper SHA-256:
  `601f51c1c46bedac5ab56f7ca38d7c15fdea8481efc6476d5a5b3243318ef79b`.
- Web data 10A: `daac85234`, merged into primary `57884ecc9`; owner-only query/prefetch/preview
  foundation, no picker or runtime activation. Independent owner/cache review approved. Focused
  61 and consumer 459 tests passed; normal unweakened web typecheck passed after exact reviewed
  PR 318 web source integration. Future actual observers still need strict owner, hydration-error,
  retry and revision-watermark tests; query probes do not prove UI behavior.

The tracked specs and plans are authoritative:

- `docs/superpowers/plans/2026-11-16-permission-profile-delivery.md`
- `docs/superpowers/specs/2026-11-16-conversation-approval-profiles-design.md`
- `docs/superpowers/specs/2026-11-16-permission-operation-contract.md`
- `docs/superpowers/{specs,plans}/2026-11-16-permission-runtime-cutover{-design,}.md`
- `docs/superpowers/{specs,plans}/2026-11-16-permission-context-replay{-design,}.md`

The last two shorthand paths mean the actual `specs/*-design.md` and `plans/*.md` files. Expanded
Task 8 and Task 9 plans passed their bounded independent technical rereviews. Source acceptance is
separate. Task 10 proposals and amendments in the evidence directory remain implementation inputs,
not proof that the remaining web work exists.

## Transport 8.1: committed checkpoint, not source accepted

Commit `3001ad382` preserves the accepted output component plus 28 new bridge paths. Start review
with `task-8-1-new-code.patch.gz` and its manifest, not the entire merge against main. The full 58-path
integration manifest, preservation record, frozen report and hashes are also included.

Implemented dormant strict readOutput ref/offset/max (0..65536), canonical raw base64 and range
validation, no filesystem/exec/provision fallback, abort affecting only the read. Added staged device
session and authenticated gateway ready/capacity negotiation, lease-fenced TTL metadata, and framed
read budgets (69632-byte frame -> 3072 raw bytes). Report codec has version/revision/sequence and
independent reachability; runtime identity production/persistence is still future work.

Minimal additive migration `0150_starting_execution_grants.sql` moved earlier with explicit
authorization: persisted original grants provenance and `backgroundStart` method coverage under
the authority fence, admission hash binding, selectors and retry evidence. Missing legacy provenance
fails closed/unknown. No old migration was changed. **Background-running ACK lifetime is not yet
implemented**; subsequent migrations start at 0151 or the then-current free number.

Evidence: 256 passed across nine actual SDK/device files; 136 across seven kernel/provider files;
final transport 17 and authority 43 passed. Counts overlap and must not be summed. One command
included a nonexistent worker-test path and earned no credit for it. Source/device/test noEmit,
custom checks, API generation and changeset/applied-migration checks passed. No full `pnpm verify`,
independent new bridge source review, activated pair or full OS-confinement claim exists.

## Replay 9.2: committed dormant WIP with a known gap

Commit `09de26a53` is based on `94bc2dddde2be5db2e702dc134728d980ff99527`.
Eight source/test/changeset paths and frozen hashes are recorded in the evidence manifest.

Implemented future-only `permission_context` v1 schema, marked device paths, pure literal rendering,
canonical hashes/predecessors, summary restoration and original-request drift diagnostics. No
permission producer, authority reader, common managed recorder, runtime callback, feeder, migration,
SDK change or activation was added. Old historical fixtures remain byte-identical.

Final controlled command passed **170/170** (107 new pure, 51 reconstruct, 12 rename), after a fresh
62-test historical baseline. Both scoped noEmit configs and three scoped checks passed. Biome exits
0 with **26 new test-style warnings**. Expanded test fixture failures (missing ModelInfo.parameters)
were corrected and are not behavioral red evidence. Full branch `pnpm verify` and independent
source review have not run.

**First next fix:** raw snapshot `toEvents` casts payloads. Unsupported managed marker 2 can bypass
the strict event schema and fall into the historical dispatch path. Write a failing reconstruction
test, then reject present invalid new markers/versions before pure dispatch, including covered
payloads under summary restoration. Preserve unmarked historical parsing and bytes. Finish exact
legacy literal/idem matrix, boundary normalization cases and warning cleanup before source review.

Re-run from the primary checkout after the fix:

```bash
CAPYBARA_TEST_WORKERS=2 CAPYBARA_TEST_CONTAINER_STARTS=2 pnpm exec vitest run \
  packages/kernel/test/runtime/permission-context.test.ts \
  packages/kernel/test/evals/reconstruct.test.ts \
  packages/kernel/test/tools/rename-compat.test.ts
```

The two scoped TypeScript configs referenced by the report are copied into the evidence directory;
adjust their absolute checkout paths carefully if moving machines and preserve source/test scope.
Never weaken generated Next guards or checks to obtain a pass.

## Remaining implementation gates

1. Close and review 9.2; independently review 8.1 and address genuine findings, then verify and
   integrate the accepted checkpoint into primary without losing either accepted history.
2. Task 8.2-8.5: durable launch/retained running authority and exact stop, real cursor consumers,
   lifecycle/owner contract, installed runtime identity/generation producer, and conservative legacy
   retirement. New artifacts live at the selected already-authorized working root's
   `.capybara/tasks/<id>.out`; exclusive/no-follow handling, no tmp fallback or implicit grant.
3. Output consumers must handle bounded multi-read progress, terminal invalid UTF-8 using raw byte
   advancement, and an HTTP suffix captured at a fixed ending position through growth. Transport
   preparation alone does not implement these consumers.
4. Owner Full/project reach are independent authenticated facts. Binding generation needs durable
   high-water identity across deletion, same-millisecond and clock rollback. Installed helper,
   interpreter and image identity must be real; no fabricated identity or re-consent loop on the
   first verified probe. Reuse the accepted 6c CAS publisher, not a second authority publisher.
5. Retain discoverable `background-running` authority after ACK and launch-run completion; exact
   revocation selectors and real writer/outbox stop survive disconnect. Legacy retirement requires
   all-replica launch freeze and durable incarnation obligations; no SID/PID adoption or broad scan.
   Cloud whole-instance destruction must be confirmed or quarantined. Local restart/no-op destroy
   does not prove old processes died; never reboot the host automatically.
6. Task 9.3 onward: actual ordered managed recorder with real authority/claim/event locks and held
   incarnation, per-model-request callback including fit attempts, strict no-send failure semantics,
   sparse recorded feeder/sequence mapping and exact optional review copying. Review records remain
   audit-only; old `permission_profile_changed` events never become model-visible. Replay uses the
   log, not current DB state. Activation is paired with Task 8.6, never a partial rollout.
7. Task 10B-E: neutral permission menu/design-system slots; first-send session-only atomicity and
   immutable request-ID recovery; revision watermark surviving failed refresh; owner-only root SSE
   with onOpen GET/reconnect/cursor/cleanup; exact scope and superseded approval rendering in chat
   and inbox; advanced owner CLI/device UI only after the actual owner contract. No app-local styles.
   Do not substitute create-then-PATCH, clipped paths, optimistic authority or old mode remapping.
8. Required branch verification, independent reviews, meaningful paired/provider/replica evidence,
   CI and final user acceptance remain. Full cross-provider readiness also requires the held Linux
   access gate to be legitimately resolved; no workaround through a different model.

## Small fix PR and release follow-through

[PR 320](https://github.com/capybara-hq/core/pull/320) is open, head `ae01833a9`.
Production binding controls now stay disabled until their JS handlers attach. Explicit user consent,
pending disabled state, API and styles are preserved. SSR/hydration unit 9/9, actual IM script-barrier
flow 2/2 and page/role/binding tests 165/165 passed. Two independent source reviews approved the
binding delta and the bounded Next page-prop signature corrections. Required local verification
passed; CI-only build/visual/e2e/Docker checks were skipped locally as designed. CI was just started
at handoff; do not claim it green or merge until its actual current required checks pass.

[Release PR 316](https://github.com/capybara-hq/core/pull/316) remains open and **unpublished**.
Latest verified head `6caebc1b70718f87b222b4054ec37eee73333bca` had e2e3 binding failure in
run `43848384319`, which motivated PR 320. No blind rerun, timeout increase or red-CI override.
After 320 passes and merges, observe the version bot refresh, verify metadata/source equivalence
and fresh required CI before merging 316. Merging it triggers npm `next` prereleases and possibly
RC images. Prior authorization covers ready merges; it does not justify claiming failed gates pass.

Version snapshot: SDK rc25, testing rc20, kernel rc35, plugin-tools rc15, device rc13, web/capybara
rc36, design 0.2 rc9, model-fake rc26. Query the refreshed PR rather than assuming these never change.
Exact versioned SDK/kernel/testing tarballs were built and packed; actual manifests/exports and an
outside-workspace consumer (3 tests + TypeScript 6 compile) passed. Published plugin-tools rc15
integrity matched; actual `packFixture` passed and dependency versions deduplicated. Evidence is
included. **This is artifact proof, not registry publication.** After publication, verify registry
versions/dist-tags/integrity/provenance and real registry installation before official plugin work.
Do not use file/link substitutes to claim published compatibility.

## Environment and operational boundaries

The user no longer needs the interactive dev environment. Web, kernel and foreground/launchd device
were stopped; do not restart for handoff. Shared components in `~/Server` (PG/Valkey/SeaweedFS) were
left alone. Isolated test stacks were cleaned. User verified VPN access; no VPN IP was committed.
Never print or commit `/Users/grant/Server/capybara/capybara.dev.yaml` or other credentials. Do not
change TLS trust, VPN, firewall or system hardening as part of this feature. The user's three repos
are core, plugins and github; this checkpoint changes core only. Main remains clean. Worktrees are
kept for the next model; do not remove or archive them before the handoff is consumed.

Begin by reading this file, applicable AGENTS/skills and the named exact reports; inspect Git heads
and status before editing. Reuse the existing worktrees, preserve accepted code, keep tasks disjoint,
and report the difference between tested checkpoints, reviewed source and live activated behavior.
