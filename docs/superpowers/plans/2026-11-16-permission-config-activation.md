# Explicit Permission Configuration Activation Implementation Plan

## Task 6c: Explicit startup configuration activation

> Execute through the permission-profile delivery controller with the frozen ownership below.
> Source implementation is authorized; live configuration and service activation are separate gates.

**Goal:** Let a privileged deployment operator explicitly CAS-activate resolved restart-only
permission configuration at startup, while ordinary stale restarts cannot overwrite authority.

**Architecture:** A start-only CLI flag passes an expected active hash through KernelAppOptions.
KernelLifecycle invokes the accepted Task 6b publication service after migrations and before role
startup. Publication reuses the existing DB authority lock, semantic epoch and outbox transaction;
ConfigService receives no new DB constructor dependency.

**Tech Stack:** Existing TypeScript CLI parseArgs, kernel Nest options/DI, PG transactional authority,
Vitest CLI and kernel integration/dual fixtures.

**Spec:** [Explicit startup activation](../specs/2026-11-16-permission-config-activation-design.md).
The semantic design and frozen `429e837f8` binding, including the narrow transaction port, have
passed independent review. Runtime acceptance remains required.

## Global constraints

- Exact proposed flag: `--activate-permission-config <expected-active-hash>`; start command only.
  No `force`, model token, env/config activation field, HTTP route or tenant/UI authorization flow.
- Candidate is the actual validated source+env resolved startup projection; reuse accepted 6b hash
  implementation. Never dump config/secrets or compute a competing CLI fingerprint.
- No active-hash mutation for ordinary mismatch or raw restart-only watch observation. Matching
  replicas remain live until a real committed authority change. Restart-only fields stay non-hot.
- Active config, applicable Full/admission semantic epochs and owed revokes change atomically before
  candidate permission use. Provider IO stays outside the transaction; no automatic postcommit rollback.
- Keep CLI → kernel only. No SDK edge/export changes, local-owner widening, global config framework
  or policy format migration. Task 6c must pass before Task 8 activation.

## Ownership and files

| Work item | Exact scope |
| --- | --- |
| 6c CLI | Modify `apps/capybara/src/args.ts`, `cli.ts`, `commands/start.ts`; extend `apps/capybara/test/args.test.ts`, `start.test.ts`, `env-file.test.ts`. Main-forwarding assertions belong in existing start.test.ts with its mocked startKernelApp; no real start through support/cli.ts runCliInProcess. |
| 6c options | Modify `packages/kernel/src/app.ts` KernelAppOptions. Keep existing `kernel.module.ts` KERNEL_APP_OPTIONS plumbing unchanged. |
| 6c startup/publisher | `packages/kernel/src/lifecycle/kernel-lifecycle.ts`; `packages/kernel/src/sandbox/permission-config-publication.ts` owns existing helpers and initialize/publish/assertCurrent. `permission-authority.module.ts` already exports the service and needs no change. `infra/config/kernel-config.service.ts` is a consumed unchanged effective-hot boundary. |
| 6c narrow transaction port | Extend `packages/kernel/src/infra/database/transaction-host.ts` with runStartupActivation only; create private `packages/kernel/src/infra/database/startup-activation-transaction.ts`. Preserve existing run/fence APIs consumed by Task 7; do not concurrently edit those with Task 7. No db/pool.ts, migrator.ts or broad DatabaseModule rewrite. |
| Tests | Create `packages/kernel/test/config/permission-config-activation.test.ts`, `permission-config-activation.dual.test.ts`, `packages/kernel/test/infra/startup-activation-transaction.test.ts`; extend exact existing `packages/kernel/test/lifecycle/start-order.test.ts`, `roles.test.ts`, `graceful-shutdown.test.ts` only for new ordering assertions. |
| Root-owned shared files | Root integrates `packages/kernel/test/container-tests.json` entry for the dual test. Worker does not edit unit/container lists, registry, profile/approval/event/schema/migration files or permission-ceiling-writes.ts. Shared fixture test/sandbox/permission-wiring.test.ts remains read-only unless separately serialized. |
| Release/documentation | Changesets for affected kernel/CLI published packages; `docs/deploy/README.md` under Roles and scaling and `docs/deploy/upgrade.md` after How an upgrade runs. No SDK snapshot change. |

The accepted 6b binding is `429e837f8`; there are no publisher/fixture/operator-document filename
placeholders. Task 7/8a source work is disjoint. The one shared code port is TransactionHost:
root has assigned its narrow startup extension to 6c while Task 7 consumes existing fences. Any
necessary common-port or lower-writer change requires serialized integration, not parallel edits.
Reuse accepted 6b tests only when their assertions cover the exact new activation behavior.

## Review focus

1. Early start return when roles absent drops the new flag (`args.ts:248`): assert both forms (A).
2. Same candidate after lost commit acknowledgment doubles epochs/revokes: assert no-op (B/C).
3. Source/env/delegation ambiguity activates a different authority than displayed: pin projection
   and DB-fallback semantics using accepted helper, including source edits after load (B/C).
4. Provider/bootstrap failure after committed activation triggers accidental rollback: pin committed
   authority and safe diagnostic, while precommit failure fully rolls back (B/C).
5. Old replica/hot watcher races restore old config or old Full consent: actual two-replica barriers
   demonstrate CAS fencing and monotonic semantic epochs (C).

## Task A: bounded CLI and KernelAppOptions plumbing

**Interfaces:** Extend start Command and runStart options with `activatePermissionConfig?: string`.
Extend KernelAppOptions with `permissionConfigActivation?: Readonly<{expectedActiveHash:string}>`.
Map the former to the latter; no candidate value/hash calculation in CLI.

- [ ] Add failing parser cases: valid flag with/without `--role`, equals and separate forms; absent
  option preserves old command object; missing/empty/whitespace/malformed/repeated hash refuses;
  every other command refuses it. Pin lowercase 64-hex syntax from accepted permissionProjectionFingerprint.
- [ ] Add failing runStart/main-forwarding assertions: expected hash passed unchanged; candidate
  remains resolveConfig(source.load(), captured env); role override and env-file precedence intact;
  no activation instruction placed in source/env. Use existing mock startKernelApp seam, no services.
- [ ] Update args union/help/parser, main forwarding, runStart opts and KernelAppOptions member.
  Ensure duplicate-option detection uses parseArgs tokens or equivalent rather than last-wins;
  no new generic CLI parser. Translate edited test titles/comments only as required by AGENTS.md.
- [ ] Run `pnpm exec vitest run apps/capybara/test/args.test.ts apps/capybara/test/start.test.ts` and
  `apps/capybara/test/env-file.test.ts`. Expect PASS without live DB/config/network writes.
  These tests prove plumbing only, not authority activation.

## Task B: accepted publication CAS and post-migration lifecycle ordering

**Interfaces:** Extend `PermissionConfigPublication.initialize(options?)` with optional activation
and startup controls exactly as bound in the proposal. Its candidate is captured from config.get()
using existing PermissionConfigProjection/functions; no provenance-label hashing or new candidate type.
Return initialized/matching/already-active/activated or ordinary mismatch; explicit CAS conflict
throws a safe startup error. Keep `publish(before,next)` and `assertCurrent()` caller contracts.

- [ ] Review the exact `429e837f8` binding and proposed startup-only TransactionHost port. The old
  projection is stored and validated in permission_config_publication; use it rather than current
  candidate config for old semantics. Admission remains gated by assertCurrent before use.
- [ ] Add runStartupActivation(fn, {connectionString,connectTimeoutMs?,signal,remainingMs}) and its
  private owned-session helper. Reject existing transaction; preserve inherited fences, mandatory
  lower-writer context, host pool identity, permissionLocks, confirmed-commit hooks and done flag.
  Do not decorate the outer initialize with requires_new around this separate session: it chooses
  the startup runner, while its default path can use existing run. Keep private locked mutation
  mandatory-transaction; hot publish retains its ordinary transaction and calls the same core.
- [ ] Use installed Kysely 0.29.6 controlled transaction startTransaction/commit/rollback APIs and
  an owned one-connection PG pool. Capture immutable original PID/secret key from BackendKeyData;
  use bounded protocol CancelRequest through pg's existing encoding, never SQL PID signaling or
  PID/start-time lookup. No new pg_signal_backend privilege; never log the key. Sending cancellation
  is not completion: observe statement/rollback or server fallback and report uncertainty honestly.
- [ ] Establish session-level statement/lock/idle-transaction defaults (at most 500 ms each) through
  connection-start options before BEGIN/identity/setup/fence SQL; preserve them after abort/rollback.
  Independently bound connect/authentication and destroy unfinished handshakes on abort. SET LOCAL
  or timeout setup only before authority lock is insufficient. Later tightening is additional.
- [ ] Fix absolute 30-second work and 1,500 ms cleanup deadlines, capped by remaining shutdown
  budget and existing 2-second startup drain; cancellation connect/send/close uses at most 500 ms
  of the same cleanup deadline. No per-phase budget refresh or zero/unbounded timeout. Server
  fallback plus owned disposal handles unavailable cancellation, with uncertain remote outcome
  when unconfirmed. Keep this fail-closed operational limit explicit and normal hot publish unchanged.
- [ ] Latch a private startup-only abort/deadline guard synchronously; check every owned driver
  dispatch after dequeue before pg sends SQL, and reject queued/late domain work. Serialize domain
  dispatch so pg has no unguarded pending domain queue. Guard TransactionHost.current/run before
  shared-pool fallback/new transaction; retain this startup ALS guard in late async descendants
  after ordinary done/context cleanup. runOutsideTransaction must not erase it; nested requires_new
  is refused in this context. Normal transaction/fence callers remain unchanged. Captured transaction
  handles remain guarded. Only fixed owner-private ROLLBACK/disposal may bypass the closed gate,
  never arbitrary callback SQL. Confirmed-commit hooks alone leave the guard; preserve nonawaited
  outbox wakes. Commit dispatch/ack uncertainty still forbids hooks or a false rollback claim.
- [ ] In new `test/infra/startup-activation-transaction.test.ts`, add real PG barriers
  `startup-owned-session-lock-abort`, `startup-cancel-unavailable-server-timeout`,
  `startup-final-commit-gate`, and `startup-commit-ack-uncertain`. Assert actual lock release/backend
  disposition, no late publication after blocker release, complete transactional rollback before
  commit, CAS idempotency after committed lost ack, context/fence preservation and no reusable dead
  session. Cover abort during connect and no second connection carrying domain writes. Assert
  KernelDb's capybara schema, inherited fence and mandatory lower writers all use the owned context;
  borrowed/shared pool remains usable. The helper owns all startup/cancellation socket cleanup,
  including rollback failure. Record
  cleanup within existing startup/shutdown budgets; do not infer it from raced promise settlement.
- [ ] Add `startup-delayed-old-cancel-key-replacement-safe`: hold a captured old CancelRequest,
  end its original session, establish an independent replacement session and release the packet;
  the replacement's blocked query and committed sentinel remain unaffected. Also send a wrong-old
  key paired with the replacement PID to exercise the server key check without requiring OS PID
  reuse. Assert no SQL signaling path, no key leakage, and sending/closing the cancel packet is
  never recorded as confirmed rollback. Label that controlled-key assertion precisely; it is not
  proof that real PID reuse was forced. Never obtain broad signaling privileges for the test.
- [ ] Extend `startup-cancel-unavailable-server-timeout` with cancellation disabled: inspect real
  session timeout defaults before BEGIN/fence, force statement abort, then observe real lock/backend
  release by rollback or surviving idle-transaction fallback. Assert the timeout values survive
  transaction failure/rollback; add `startup-abort-during-begin-and-setup` barriers before/after
  controlled BEGIN and any identity/setup operation. No setup SQL precedes protected session defaults.
- [ ] Add `startup-late-continuation-cannot-dispatch`: pause callback and a queued query, abort or
  expire the absolute work deadline, complete cleanup, then release both. Try the captured owned
  handle, KernelDb and a new transaction/runOutsideTransaction continuation; assert no domain write
  reaches owned or shared pool, no late lock acquired and no COMMIT. Independently show unrelated
  normal shared-pool work still succeeds. Real DB sentinel rows/locks are required alongside dispatch
  observation; rejection spies alone do not prove absence of fallback. Verify fixed cleanup rollback
  can still settle without opening general SQL to the paused callback.
- [ ] Add `programmatic-invalid-activation-intent`: call the exported kernel entry with malformed
  expected hash; assert refusal and unchanged active/epoch/outbox state even for absent or matching
  active record. Invalid intent cannot fall through to initialization/already-active success.
- [ ] Add failing integration cases using one test app per file: normal initial insert, matching,
  mismatch no-write; explicit absent-record refusal; expected-match activation; stale expected
  refusal; same-candidate stale-expected no-op. Assert active record plus exact epoch/outbox effects.
- [ ] Test equivalent host normalization, winning env override, ignored raw source change,
  configured-vs-delegated autoMode and current DB setting resolution. Use accepted shared helper;
  assert a field-source semantic change cannot be erased by flattening the effective string.
- [ ] Add `unrelated-config-preserves-full-consent`: seed real valid Full consent, change unrelated
  config, then run normal/same-candidate startup. Assert unchanged permission hash, Full scope
  revision/consent record and effective Full profile through accepted consent/admission reader.
- [ ] Add `restricted-network-activation-preserves-full-consent`: cloud auto device, enabled egress,
  Full network still open-public, changed restricted allowlist. Confirm accepted semantic scope;
  assert changed admission hash/only applicable restricted revokes, unchanged Full revision/consent
  and effective Full profile through the real reader. Include source-label/delegation identity
  cases: different config identity alone cannot erase consent absent actual Full-scope change.
- [ ] Implement single transactional CAS path under existing exclusive platform authority lock,
  sharing hot publication's semantic epoch/revoke logic. Do not use unconditional upsert. Inject
  faults before outbox/commit: active record, semantic epochs and revoke intents all roll back.
  Extract private publishLocked(expectedHash,nextProjection) in the existing publication file;
  validate stored projection/hash and SQL affected-row count. Reuse unchanged PermissionCeilingWrites
  lock/invalidateDeviceConsentUnderPlatform/publishLocked; no new profile/approval mutation service.
- [ ] Wire lifecycle's existing post-migration publication checkpoint through KERNEL_APP_OPTIONS;
  run before extension/bootstrap/worker/gateway start or candidate permission admission. Do not
  initialize ConfigService through DB or install a late-bound callback/setter.
  Replace accepted lifecycle line 212's initialize call with tracked initialize({activation?,startup})
  and immediate checkpoint. Existing lifecycle watcher and ConfigService.apply(updated) remain intact.
- [ ] Track the full activation promise in existing GracefulShutdown in-flight startup work,
  preserving the shutdown budget and startup drain before infra closes. Check abort before work,
  after authority and immediately before authorizing COMMIT; re-check shutdown on completion before
  bootstrap/provider/role/watch/presence/listen. Use accepted actual PG cancellation/bounded waits,
  not an AbortSignal-only assumption or a new lifecycle abstraction.
- [ ] Test roles individually/all: activation not gated on worker role; producers can commit outbox
  while consumers remain worker-only. Transaction contains no device/provider calls. On explicit
  CAS conflict start fails before role/listen; normal mismatch retains accepted 6b behavior.
- [ ] Add real PG barrier case `shutdown-while-authority-blocked`: hold authority from another
  connection, begin tracked activation, signal shutdown after proving lock wait, then release the
  blocker. Assert bounded settlement and unchanged active/epochs/outbox, no late publication and
  no provider/role/listen startup; infra closes only after tracked transaction settlement. Exercise
  accepted cancellation/timeout path with barriers and existing budget, not fixed sleeps.
- [ ] Add `abort-after-authority-before-commit`: stop at the commit-authorization barrier after
  staging writes, observe abort, release; real DB state rolls back completely, lock is released,
  no late candidate admission or provider/role startup. Include abort already set before entry.
- [ ] Add `shutdown-after-commit-dispatch-lost-ack`: control COMMIT dispatch/ack separately, trigger
  shutdown after dispatch and suppress ack. Assert no false rollback claim or compensation; reread
  real authority and retry the same candidate/expected hash. If committed, retry is already-active
  with unchanged epochs/revokes/consent; no role/provider starts after shutdown. Keep uncertainty
  explicit until authoritative resolution and never exceed shutdown budget for diagnostic reread.
- [ ] Add `postcommit-bootstrap-failure-keeps-activation`: confirmed activation survives later
  startup failure and retry is idempotent. Test diagnostics contain only hashes/command template,
  with secret sentinels absent (DB URL/environment/host lists). Wiring mocks are not DB evidence.
- [ ] Run `pnpm exec vitest run packages/kernel/test/config/permission-config-activation.test.ts packages/kernel/test/infra/startup-activation-transaction.test.ts`
  plus touched lifecycle tests named in ownership. Expect PASS; use isolated test databases only. Existing
  restart-field warnings/hot behavior remain unchanged in regression cases.

## Task C: dual-replica authority races and activation gate

**Files:** `packages/kernel/test/config/permission-config-activation.dual.test.ts` and checked-in
container membership. Use two replicas from existing testing helpers, controlled promises/transaction
barriers; no fixed sleeps, live service/config modifications or per-test timeout overrides.

- [ ] Add concurrent initialization with different candidates: one insert winner, loser mismatch;
  neither writer overwrites the established value on ordinary startup.
- [ ] Race A→B expected A against duplicate B expected A and C expected A. Assert one B transition,
  B retry no-op, C conflict; exactly one semantic epoch/outbox transition. Repeat with controlled
  commit-ack loss, no network/provider side effect inside transaction.
  Prove B has acquired authority before releasing C; concurrent promise creation alone cannot
  establish the intended winner.
- [ ] Keep replica A serving while B merely observes mismatch: A admission still succeeds. Activate
  B explicitly: old A now fails permission admission using DB fingerprint gate, B succeeds after
  commit, and only affected old operations receive durable revoke obligations. Notifications may
  be dropped without defeating the gate; unrelated endpoints need not stop.
- [ ] Race old A ordinary restart and A expected A against committed B: neither reverts it. Then
  explicitly activate A using current expected B; assert intentional rollback has fresh semantic
  epochs and stale Full consent remains invalid. Fresh approval/consent requirements still apply;
  no local-owner grant is manufactured.
- [ ] Name that semantic case `full-scope-a-b-a-does-not-resurrect-consent`: seed real valid A Full
  consent, choose an actual Full-scope-changing B from accepted projection fixtures, assert reader
  rejects old consent after B and after explicit A rollback. Verify affected revisions advance,
  no new consent record appears and duplicate retries change nothing. Check effective profile and
  admission with accepted reader, not only epoch values/spies. Reuse Task B's preservation fixtures
  as negative controls; rollback invalidation applies to true Full-scope changes, not all hashes.
- [ ] Race hot autoMode publication against non-hot activation under the shared lock/CAS in both
  orders. A stale watcher cannot revert active config; a non-hot raw watch event alone cannot
  publish or close matching replicas. Race DB delegated-mode writer using accepted lock ordering.
- [ ] Add `mixed-hot-restart-payload-keeps-effective-network`: one raw payload changes autoMode H0→H1
  and network N0→N1. Assert watch commits hash/projection (H1,N0), applies H1 with local N0, leaves
  N1 restart-required, updates only applicable semantic revisions/revokes and permits another
  replica matching that committed projection through real admission. Pure non-hot regression
  alone does not satisfy this case; never hash the fully resolved future raw document here.
- [ ] Add `mixed-watch-explicit-activation-both-orders`: repeat using that same mixed payload and
  an explicitly frozen startup candidate with N1. Barrier the actual authority acquisition in each
  order; assert first writer's exact committed projection, stale CAS refusal/idempotent equality
  as applicable, local effective network/epochs and real matching/mismatching replica admission.
  N1 becomes active only through explicit startup, never watch. Reuse accepted 6b coverage only
  if it proves this exact mixed payload and activation boundary; no duplicate generic reload tests.
- [ ] Root registers the exact dual path in container-tests.json; worker then runs
  `pnpm exec vitest run packages/kernel/test/config/permission-config-activation.dual.test.ts`.
  Verify outcome/epoch/outbox/admission invariants, not merely logs or method calls.

## Acceptance and handoff

- [ ] Independent technical review of privileged option, candidate projection, CAS/idempotency,
  failure window and Full/admission epoch separation. Confirm implementation follows accepted
  `429e837f8` helper/writer semantics and the reviewed bounded startup port.
- [ ] Review named negative/positive consent-reader evidence, mixed hot/restart payload/races and
  real PG shutdown/commit-boundary evidence. Confirm explicit frozen file/interface handoff before
  source work and scoped review of the narrow transaction addition; no claimed proof from spies or
  unexecuted planned tests. If real failure/consent tests require shared lower-writer/profile edits,
  stop that edit and hand the exact issue to root for serialized integration; continue disjoint work.
- [ ] Run relevant required checks for kernel/CLI changes, including dependency and kernel convention
  checks. Add correct published-package changesets and concise operator docs. No SDK dependency or
  API regeneration is introduced by this feature.
- [ ] Root owns eventual commits/PR/activation decisions through the existing workflow. The assigned
  implementer changes only owned source/tests and reports a frozen patch; no service activation.
- [ ] Mark 6c accepted before Task 8 coordinated activation. It may overlap Task 7/8a implementation
  only with frozen disjoint ownership; accepted Task 6b does not prove this new port, and mock-only
  evidence does not prove end-to-end cancellation or activation.

Self-review: parser's no-role path is covered; every CAS state has a test; source precedence and
DB delegation remain distinct; activation has one transactional semantic writer; all five review
risks map to bounded tests. No generic config versioning/consensus system is proposed.
