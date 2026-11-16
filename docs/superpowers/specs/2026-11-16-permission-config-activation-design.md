# Explicit startup permission configuration activation

Status: accepted technical design and source binding (2026-11-16).
Binding source: accepted Task 6b commit `429e837f8`; original startup anchors use `f6bb72a90`.
Semantic review and binding corrections are independently accepted. Implementation proceeds through
the permission-profile delivery plan; runtime evidence and live activation retain separate gates.

## Problem and selected boundary

`sandbox.limits.egress`, `orgHosts` and `allowHosts` require restart; `devices.autoMode` is hot.
Task 6b publishes hot permission changes under the DB platform authority lock with fingerprint CAS,
semantic epochs and revocation outbox before local effective use. Initial publication only inserts
when absent. Matching replicas work; a startup config hash mismatch fails that replica's permission
admission closed without disabling matching replicas. `source.watch(raw)` has no cross-replica
monotonic version, so an ordinary restart cannot safely overwrite the active fingerprint: it might
be either the new intended config or an old stale replica.

Add exactly one explicit privileged startup option:

```text
capybara start --activate-permission-config <expected-active-hash>
```

It publishes the **actual resolved startup permission configuration of that process**, conditional
on the exact active fingerprint the operator names. It does not receive candidate field values,
force flags, model tokens or an HTTP request. The operator already controls deployment startup,
config and DB credentials. This adds no tenant authorization flow, public UI, model tool or new
API route. An argv fingerprint is a nonsecret concurrency precondition, not a bearer credential.

Normal matching startup needs no flag. Normal mismatch only diagnoses/gates as Task 6b already
defines; observing raw restart-only changes never changes global authority or gates all replicas.
The fields remain restart-required; ordinary config reload and other hot fields remain unchanged.

## Frozen startup chain and concrete extension points

| Baseline anchor | Existing behavior / proposed connection |
| --- | --- |
| `apps/capybara/src/args.ts:9,33,109,246,264` | Command union, usage, parser and start role parsing. Add start-only activation string; preserve start with and without roles. |
| `apps/capybara/src/cli.ts:95–97,149–158` | Env file loads before parse; main passes start options to runStart. Forward expected hash only. |
| `apps/capybara/src/commands/start.ts:31,38–57,66` | Copies environment, applies role env override, loads source and calls resolveConfig(raw, env), then startKernelApp(config, options). Add one app option to this existing options object. Do not reload source or hash in CLI. |
| `packages/kernel/src/config/load.ts:104–123` | Environment overrides raw source before schema validation/defaults. Activation candidate must use this resolved result. |
| `packages/kernel/src/app.ts:26,68–78,130,148,166` | KernelAppOptions passes through build/init/create/start. Add optional bootstrap intent to this existing exported interface. |
| `packages/kernel/src/kernel.module.ts:52–65,90,112` | Private KernelAppOptionsModule already injects KERNEL_APP_OPTIONS as a value. No new public global, setter or lookup mechanism needed. |
| `packages/kernel/src/lifecycle/kernel-lifecycle.ts:121–127,185,201–208` | Lifecycle already receives ConfigService, options and DB services; migrations complete before startup proceeds. This is where to invoke Task 6b's accepted publication service with optional activation. |
| `packages/kernel/src/infra/lifecycle/graceful-shutdown.service.ts:22–43,67–88`; `lifecycle/kernel-lifecycle.ts:201–208` | Existing shutdown signal, in-flight tracking and startup-drain-before-infra-close ordering. Track activation just as startup migration work; retain the existing shutdown budget. |
| `packages/kernel/src/lifecycle/kernel-lifecycle.ts:231,272–285,287,293,304` | Extension load, role gates, watch, presence and listen follow. Activation must complete before any of these can admit candidate permission work; config watch starts later. |
| `packages/kernel/src/infra/config/kernel-config.service.ts:85,101,119,129,152–193` | Constructor receives config+env+logger only; fieldSource preserves source semantics; reload distinguishes hot vs restart. Keep it free of DB-dependent construction. |
| `packages/kernel/src/index.ts:2–9` | KernelAppOptions/start functions already exported. CLI keeps its sole internal package edge to kernel; no plugin-sdk import or new SDK export is required. |

## Proposed exact option and service boundary

The CLI/app option names remain the accepted proposal. The publisher binding below now names
the actual accepted 6b methods; it supersedes the earlier placeholder startup interface.

```ts
// apps/capybara/src/args.ts: start command member
{ command: "start"; roles?: Role[]; activatePermissionConfig?: string }

// apps/capybara/src/commands/start.ts: opts
{ roles?: Role[]; activatePermissionConfig?: string }

// packages/kernel/src/app.ts: additional KernelAppOptions member
permissionConfigActivation?: Readonly<{ expectedActiveHash: string }>;
```

CLI maps `activatePermissionConfig` to `permissionConfigActivation.expectedActiveHash`. The
option is process bootstrap intent, never KernelConfigSchema/env-config input, never hot-reloaded
or persisted as an instruction to activate on every future observation. Existing role override
and `--env-file` behavior apply unchanged.

Hash syntax: `permissionProjectionFingerprint` in the accepted publication file produces canonical
lowercase 64-hex SHA-256. Reject empty,
whitespace, malformed, missing and repeated flag values with UsageError (exit 2); reject on every
non-start command. Do not silently take a last repeated flag, lowercase arbitrary text or support
`any`, `force`, `latest` or an absent-record sentinel. The CLI validates that syntax only and never
computes a fingerprint.
Validate the same option at the kernel entry boundary for programmatic create/start callers.
Malformed intent fails before initialization or an already-active shortcut; it must never silently
become absent intent. This uses existing kernel options, not a new SDK API or token.

Lifecycle invokes the accepted publication service at its post-migration publication checkpoint.
The required logical interface is:

```ts
// Extend PermissionConfigPublication.initialize in its existing file.
initialize(
  options?: {
    activation?: Readonly<{ expectedActiveHash: string }>;
    startup?: { signal: AbortSignal; remainingMs: () => number };
  },
): Promise<
  | { outcome: "initialized" | "matching" | "already-active" | "activated"; activeHash: string }
  | { outcome: "mismatch"; activeHash: string; candidateHash: string }
>;
```

The candidate is captured once inside `initialize` using existing
`permissionConfigProjection(this.config.get())`; its type is `PermissionConfigProjection`, not a
new CLI-public type. No caller supplies candidate values. Lifecycle always passes startup controls;
preserve existing no-argument initializer compatibility for current internal test/ordinary callers.
Explicit-activation conflicts throw a typed startup error with nonsecret hashes, rather
than returning ordinary `mismatch`. No raw setter on KernelLifecycle, ConfigService or HTTP API is
needed. ConfigService continues depending only on config/logger primitives. Lifecycle/publication
may depend on both ConfigService and DB; DB can still depend on ConfigService without a cycle.

The initial config object can exist in memory before publication so infra can connect. It must not
authorize permission work until the accepted Task 6b admission gate sees a matching active record.
Do not describe object construction as successful activation.

## Fingerprint and semantic authority

Use **one accepted Task 6b projection/hash implementation** for initial publication, hot publication,
startup comparison, activation and admission. Never hash a raw source document, whole config,
secret-bearing object, timestamp, environment dump or file path. Do not duplicate normalization
in CLI. Freeze the candidate once from the actual startup config and captured environment before
the source watch starts; a later source update is a separate hot/restart observation.

The projection must cover the resolved permission-relevant config fields exactly:

- `sandbox.limits.egress`, `orgHosts`, normalized `allowHosts`, including schema defaults and
  environment overrides, as they actually govern permission evaluation.
- `devices.autoMode` with the distinction between explicit configured value and absence. Absence
  delegates to the current deployment setting/default; it is not equivalent to explicit `allowed`.
  The accepted helper preserves configured-versus-delegated identity and winning effective values;
  it does not hash file/Nacos/env provenance labels. Different winning permission values yield
  different candidates, but equal configured values from different source labels need not.
  Ignored raw changes cannot become a different effective candidate.

Baseline evidence: schema `config/schema.ts:1707–1723` intentionally has no autoMode schema default;
`sandbox/platform-auto-mode.ts:80–84,104–114` resolves config/source before PG/default;
`KernelConfigService.fieldSource:129–137` identifies env overrides diagnostically. Hashing only the resolved
string `allowed` would erase who may change it. For host lists, use the same canonical semantics
as accepted publication; do not invent a different sort/case/dedup algorithm for activation.

Config fingerprint and live DB semantic authority are related but not interchangeable. A delegated
autoMode source remains delegated in config fingerprint material. Read current DB settings under
the platform authority lock when comparing old/new effective permission semantics. Existing DB
setting writers continue their own authority-epoch/outbox path; do not bake one transient PG value
into startup config as a permanent override or force every DB setting change to require CLI startup.
The active record must carry enough accepted projection material to compute the old semantics;
the new replica's candidate config cannot be used as a substitute for the old active config.

## Transaction and state transitions

After migrations and before extension/worker/gateway start, acquire Task 6b's existing exclusive
platform authority lock in a transaction. Read the active config record and any relevant DB
settings in the established lock order. Use the same publication mutation path as hot changes.

| Active state / request | Required result |
| --- | --- |
| No record, no activation flag | Existing insert-if-absent initialization. Concurrent initializers re-read the winner; no unconditional upsert. |
| Active hash equals candidate, no flag | Matching startup; no epoch or revoke duplication. |
| Active differs, no flag | Existing mismatch/admission-closed state for this replica only. No mutation/outbox/global gate from observing it. |
| No record, explicit expected hash | Fail explicit activation; no fake expected value and no initialization to make CAS succeed. Diagnostic says first startup should run normally. |
| Active equals candidate, flag present | Already-active idempotent success, even if expected names the previous hash. No write, epoch bump or duplicate outbox. This permits lost-ack retry. |
| Active differs from candidate and from expected | Conflict; transaction changes nothing; explicit startup fails before role start/listen (exit 1). Show current and candidate fingerprints. |
| Active equals expected and differs from candidate | CAS activate candidate, semantic authority changes and revocation intents in the same transaction; return only after commit. |

The update still compares the exact observed active hash in SQL despite serialization by the
authority lock. Evaluate actual semantic changes using Task 6b's accepted Full-consent vs general
admission epoch separation: bump only the applicable semantic epochs, invalidate obsolete consent
when its authority changed, and persist affected-operation revocation obligations. No-op or purely
equivalent effective input must not manufacture revocation. Fingerprint/source-policy changes
still need a correctly shared semantic classification; do not equate every hash change with a
Full-consent change or skip every same-value source change.

Consent preservation is an explicit acceptance condition, checked through the accepted real
consent/admission reader and effective profile/scope revision, not only epoch-update spies:

- An unrelated config change leaves the permission fingerprint, Full semantic revision and valid
  Full consent unchanged; repeating activation of that same candidate is a no-op.
- An activated restricted-only network change may change the admission fingerprint and affected
  restricted-operation revoke obligations while preserving Full consent and its scope revision.
  Use a cloud auto device whose Full network remains `open-public`, changing its restricted
  allowlist with egress enabled (`sandbox/modes.ts:137–153` at the frozen baseline). The accepted
  6b Full-scope projection must confirm the unchanged semantic scope in that fixture.
- For a true Full-scope change A→B and explicit B→A rollback, affected semantic revisions advance
  and old consent remains invalid through the real reader. Restoring config A or retrying the
  same candidate cannot restore an old consent revision or manufacture a new consent record.
- A source-label change alone cannot invalidate Full consent unless accepted semantic comparison
  identifies a real Full-scope change. Configured/delegated input identity remains represented in
  the config fingerprint even when a particular Full scope is unchanged.

Active record, epochs and owed cancellation rows commit atomically. A failure before COMMIT is
authorized rolls all back; the candidate cannot pass permission admission. No transaction spans provider RPC, device
stop, extension initialization, bus delivery or queue drain. After-commit wakeups are hints; outbox
rows carry the durable obligations and the existing workers execute them. Pending required
cancellation must remain fenced by accepted Task 6b rules before affected work can be reused.

Upon commit, the candidate replica still follows normal startup. Already-running old-config
replicas fail future permission admissions when their local fingerprint differs from the committed
active one. They need not crash or stop unrelated APIs. Publication must not wait for all replicas
to acknowledge, and memory/bus notification must not be the only revocation/admission gate.

If startup later fails (extension failure, port conflict, shutdown), do **not** automatically revert
the committed activation: other replicas may already have observed it and revocations may have
run. Log confirmed committed activation before a later failure; rerun the same candidate/flag
safely or perform an explicitly intended rollback with the then-current hash.

Activation participates in the **existing GracefulShutdown startup lifetime**. Track its entire
promise (authority acquisition through transaction settlement) in existing in-flight tracking so
startup work drains before infra closes. Use the existing shutdown signal and budget. Verify the
startup publisher uses the bounded/cancellable transaction addition specified below; accepted 6b
does not already provide it. Passing AbortSignal alone does not cancel a PostgreSQL wait. The
addition must establish actual cancellation/timeout and rollback/connection disposition within
that budget, not add a generic lifecycle API.

Check abort before work, after authority acquisition and immediately before authorizing COMMIT.
An abort observed before commit authorization must prevent COMMIT, roll back all publication,
epochs and outbox writes, and release authority without late activation. A blocked lock waiter
must settle via the accepted cancellation/bounded timeout path rather than becoming an orphan
that publishes after shutdown. Cancellation/failure settlement remains tracked; it cannot release
the startup-drain obligation while the transaction can still mutate authority.

Once COMMIT has been dispatched, abort or lost acknowledgment **cannot establish rollback**.
Treat that outcome as uncertain unless committed/aborted authority is confirmed. Resolve through
an authoritative reread when safe, or the next same-candidate idempotent startup; do not compensate,
replay revokes or report confirmed rollback. Shutdown must not introduce an unbounded reread past
the existing drain budget. A known commit remains committed. After publication settles, re-check
lifecycle shutdown before any bootstrap, extension/provider initialization, worker/gateway role,
watch, presence or listen startup. Neither a commit nor a late callback authorizes startup after
shutdown. These distinctions require real PG lock/commit-boundary tests; mocks prove wiring only.

## Races, rollback and diagnostics

- A→B with expected A wins once. Another B/expected A startup is already-active, not a second
  epoch bump. Competing C/expected A loses after B commits and cannot overwrite it.
- Stale ordinary A restart after B observes mismatch only. Stale A with expected A cannot roll
  B back. An operator deliberately starting A with expected **B** may activate A; that is explicit
  rollback intent, with new semantic epochs/revokes as required, never restoration of old epoch
  numbers or old Full consent. A→B→A does not resurrect stale consent tokens.
- Hot publication and explicit activation serialize under the same lock/CAS. If hot publication
  changed the active hash first, activation fails unless its candidate is already active. If
  activation wins, a stale hot event cannot overwrite from an obsolete expected fingerprint.
- A candidate loaded before a concurrent config-source edit activates only that frozen resolved
  startup candidate. It does not fetch/apply a different payload after verifying expected hash.
  Pending non-hot watch changes still report restart-required and never become active via watch.
- A single raw watch payload may change hot `devices.autoMode` and restart-only network limits.
  Its publication candidate is the **current effective non-hot network plus the new hot value**,
  with accepted source semantics, never the fully resolved raw future network. Publish before
  applying that hot effective projection locally; keep pending network values restart-required.
  Assert committed projection/hash, local network fields, applicable Full/admission revisions
  and another matching replica's admission. Run the same mixed payload against explicit startup
  activation in both authority-acquisition orders: CAS rejects a stale writer and pending network
  cannot become active through watch. This pins the shared effective-config boundary without
  changing ordinary reload or inventing source ordering/consensus.
- DB setting changes racing delegated autoMode evaluation use the shared authority lock ordering;
  both execution semantics and consent invalidation derive from the serialized committed state.

Nonsecret diagnostics provide outcome, activeHash, candidateHash and, for mismatch/conflict, the
actionable command template:

```text
Permission configuration differs from the active deployment configuration.
active=<hash>; candidate=<hash>
To intentionally activate this resolved startup configuration, run:
capybara start --activate-permission-config <active-hash>
Keep the same config source, environment/env-file and role options.
```

Never execute/retry the displayed command automatically. For an explicit conflict tell the operator
to inspect the new active fingerprint before choosing it. Do not print the raw permission lists,
full config, DB URL, credentials or environment. The hash display is diagnostic, not an assurance
that file/env contents have not changed; exact frozen candidate evaluation remains authoritative.

## Frozen 429e837f8 interface/file binding and narrow transaction addition

The exact accepted semantic implementation is
`packages/kernel/src/sandbox/permission-config-publication.ts`: `PermissionConfigProjection`,
`parsePermissionConfigProjection`, `permissionConfigProjection`, `permissionProjectionFingerprint`,
`permissionConfigFingerprint`, and `PermissionConfigPublication.initialize/publish/assertCurrent`.
Projection validation limits its nonsecret JSON to 65,536 bytes and normalizes hosts by unique/sort.
It preserves configured autoMode versus `deployment-setting`; PG fallback is read under authority.
Reuse these functions unchanged. `PermissionAuthorityModule` in
`packages/kernel/src/sandbox/permission-authority.module.ts` already provides/exports publication.

Extend `initialize(options?)` as specified above. Extract its transaction-held mutation core from
existing `publish` into one private `publishLocked(expectedHash, nextProjection)` in the same file.
Both hot `publish(before,next)` and explicit startup call that core. It validates the stored
projection against its hash, checks candidate-equals-active before stale expected, verifies the
SQL CAS affected-row count, and derives old semantics from the **stored old projection**. Do not
construct a fake old KernelConfig from the new replica's current values. Refactor the existing
semantic comparison to consume projections; PG fallback, org networks and device source lookup
remain under the same platform transaction. Keep ordinary initialize insert-if-absent and
`assertCurrent()` admission behavior. No duplicate hash, publisher or second semantic algorithm.

The lower writer is `packages/kernel/src/sandbox/permission-ceiling-writes.ts`:
`lock({}, "platform")`, `invalidateDeviceConsentUnderPlatform(deviceIds)` and
`publishLocked(subject, level, revoke, invalidateFullConsent)` are mandatory-transaction methods.
Use them unchanged, preserving Full versus admission revisions and existing outbox job identity.
The root/profile mutation and revoke rows belong to this accepted writer, not new 6c profile code.

Exact startup call site: `packages/kernel/src/lifecycle/kernel-lifecycle.ts:211–212` now calls
`permissionConfig.initialize()` immediately after migrations. Replace that call with
`shutdown.trackInFlight(permissionConfig.initialize({activation: opts.permissionConfigActivation,
startup: {signal: shutdown.signal, remainingMs: () => shutdown.remainingMs()}}))` (omit absent optional
fields), followed immediately by `checkpoint()`. Existing options token remains in
`packages/kernel/src/kernel.module.ts:52–65`; no module/token/constructor cycle change is needed.
`KernelConfigService.apply` at `infra/config/kernel-config.service.ts:152–218` already builds
`updated` from current plus hot fields before its publication callback; retain that boundary.
The watcher at lifecycle lines 294–297 continues calling `publish(before,next)`.

**Actual missing infrastructure, not a 6b completion claim:**
`infra/database/transaction-host.ts` has only `run(fn, TransactionOptions)` and no signal, timeout
or commit gate; `XactLock.lock` waits in `pg_advisory_xact_lock`. `GracefulShutdown` aborts/tracks
but can abandon promises. Total stop budget is 30 seconds, while startup drain is only
`STOP_BUDGET_MS.migrate = 2_000` in `kernel-lifecycle.ts:70–75,455`. Signal-only or Promise.race
cancellation cannot satisfy the accepted shutdown contract.

Propose this one internal entry on `TransactionHost`, owned by 6c and unused by other callers:

```ts
runStartupActivation<T>(
  fn: () => Promise<T>,
  options: {
    connectionString: string;
    connectTimeoutMs?: number;
    signal: AbortSignal;
    remainingMs: () => number;
  },
): Promise<T>;
```

`initialize` passes only trusted `this.config.get().db` connection inputs and lifecycle controls;
never log those inputs. The method rejects an existing transaction, preserves the inherited fence,
installs the same TransactionStore/permissionLocks/afterCommit context, and tags that context with
the host's existing pool identity so `KernelDb` and mandatory lower writers join this transaction.
It does not alter `run`, `withTransactionFence` or `withTransactionFencePrelude` semantics used by
Task 7. Internal helper file: `infra/database/startup-activation-transaction.ts` for owned PG/Kysely
session mechanics only; no new config schema, public API or generic lifecycle framework.

The extra owned session is necessary because the accepted shared Kysely pool exposes no exclusive
session shutdown handle and Task 7/other requests may use it concurrently. The helper alone creates,
owns and closes the `max: 1` pool/client and any temporary cancellation socket in all return/error/abort
paths; it never returns a terminated client to the shared pool. A failed rollback disposes the
owned checked-out client and closes its pool rather than waiting indefinitely for pool.end().
Capture the original session's PID and secret key from its BackendKeyData before domain writes;
keep that immutable pair private for this one activation. Use PostgreSQL protocol CancelRequest
with that pair, through the installed pg cancellation encoding and a bounded separate socket to
the same endpoint. Never substitute the currently active client's identity after a retry. No SQL
`pg_terminate_backend`, `pg_cancel_backend`, `pg_stat_activity` identity lookup or new signaling
privilege is used. A PID/start-time predicate is not atomic identity binding and is explicitly
rejected. Destroying a cancellation socket cannot retract a packet already received by the server.
Safety of a delayed old request depends on the protocol's PID-and-key check, not socket closure.

Preserve session/DB semantics explicitly: `db/pool.ts` at this commit installs PostgresDialect,
pgConnectOptions and error handling, with no extra Kysely plugins; reproduce those relevant options
for the private session, without logging the DSN. `KernelDb.db` still calls `kernelDb`'s
`withSchema("capybara")` on the context transaction (`db/kernel-schema.ts:2234–2235`). Domain writes
continue through those same builders, not raw SQL copied into a new schema. Preserve the inherited
transaction fence before mutation, transaction-local authority claims and afterCommit ordering;
do not bypass fences because this is operator startup. Real PG tests must prove the schema,
mandatory writer transaction identity and fence ordering; future pool plugins cannot be silently
dropped by this port. Keep connection/control diagnostics to safe labels/outcomes, never DSNs.

Use an owned one-connection PG pool/session and Kysely controlled transaction
`startTransaction().execute()`, then explicit `commit().execute()` / `rollback().execute()`.
The installed Kysely 0.29.6 source confirms these APIs; its default transaction builder commits
automatically, and its default abort strategy may ignore a query. Do not assume generic query
AbortSignal cancels inherited writer queries. The private helper uses the installed pg 8.23.1
PID/key cancellation mechanism; it does not copy the migrator's SQL termination path.

**Timeouts precede all SQL.** Put session-level `statement_timeout`, `lock_timeout` and
`idle_in_transaction_session_timeout` defaults (at most 500 ms each) into the owned PG connection's
startup `options`. Install them before controlled BEGIN, any identity/setup query, and inherited
fence execution; do not install them only with SET LOCAL or only before authority acquisition.
Pin the effective startup values after parsing trusted connection options; a DSN option must not
silently override these bounds. Preserve unrelated connection/TLS settings and keep the DSN private.
These startup defaults survive statement failure and transaction rollback. Later budget tightening
is additional and cannot replace them. TCP/Unix connection and authentication setup is independently
bounded by the smaller of configured connect timeout, the absolute work deadline and remaining
shutdown budget; abort destroys an unfinished handshake and closes the SQL gate before any late
connect callback can begin a transaction. No initial SQL is allowed until startup defaults have
been accepted. The helper owns final connection disposal even if startup never reaches BEGIN.

**Abort fences all later SQL, not just COMMIT.** Abort or either deadline synchronously latches a
closed startup guard. Every owned driver dispatch (including queued statements after dequeue)
checks that guard immediately before calling pg; the helper serializes domain dispatch so no
domain statements are left in pg's queue to run after abort. Pending domain work rejects. The
guard checks the current monotonic deadline as well as the abort latch, not only a timer callback.
It also protects TransactionHost.current/run before any shared-pool fallback or new transaction.
Use a private startup-only ALS guard retained by async descendants even when the ordinary store
is marked done: a late continuation must throw, not see `current() === undefined` and write through
KernelDb's shared pool. Existing runOutsideTransaction/fence exits must not erase this guard.
Normal calls without this startup guard retain existing behavior; nested requires_new from this
owned startup context is refused. Confirmed-commit hooks alone are explicitly run outside that
guard after commit; preserve the existing nonawaited outbox wake behavior. Failed/uncertain-commit
hooks never run. No Task 7 transaction semantics change outside the guarded startup context.

Only the helper's fixed cleanup ROLLBACK/disposal path may operate after the guard closes, through
an owner-private control entry that does not reopen general SQL dispatch. Never use a global
"cleanup enabled" flag that lets concurrent callbacks send arbitrary statements. A captured
transaction handle also retains the closed driver guard. Fence late continuations before clearing
the ordinary context or settling the tracked activation promise; they need not finish arbitrary
non-DB awaits, but can no longer mutate either session. Never reuse the doomed connection.

After latching the guard, attempt bounded PID/key CancelRequest as an acceleration only. A sent
packet or closed cancellation socket is not cancellation completion. Observe the original statement
settling and confirmed rollback where reachable; otherwise use session timeout fallback and owned
disposal, reporting uncertain remote disposition. CancelRequest cancels a query, not a session.
No new SQL from callbacks can reset the idle-transaction timer after the aborted statement. The
idle-transaction timeout terminates an abandoned transaction/session; the statement timeout alone
does not prove its locks released. Keep the key out of logs/errors/hash material and dispose all
cancellation sockets inside the same cleanup budget. A late request may affect only the original
PID/key session; cleanup cannot claim a cancellation response identifies a replacement backend.

Budgets are absolute: fix the work deadline once at entry to at most 30 seconds, capped by the
shutdown deadline; fix cleanup once at abort to at most 1,500 ms, capped by remaining shutdown
budget, inside the existing 2-second startup drain. Cancellation connect/send/close is at most
500 ms and consumes that same cleanup budget. Recompute remaining time before each blocking phase;
never refresh a full phase allowance or use zero as an unbounded PG timeout. Setup, statements,
rollback and socket disposal all consume their applicable deadline. Server statement then idle
timeouts (500 ms each) provide fallback margin if cancellation is unavailable, but server stalls
and partitions still preclude unconditional remote-completion guarantees. Report uncertainty
rather than infer rollback from elapsed time. This intentional fail-closed startup restriction
can reject slow scans or contention and require a later deliberate retry. It does not apply new
limits to normal hot `publish`, and adds no operator setting or generic cancellation framework.

Check abort after authority and inside the last synchronous commit-authorizing step, with no
await between that check and calling controlled commit. Track commit-dispatched separately from
commit-acknowledged; any dispatch/ack ambiguity uses the already accepted reread/idempotent retry
rules. Await actual rollback/owned-session disposal before settling the tracked promise where
reachable; network uncertainty is reported as such, never verified rollback. Drop hooks for failed
or uncertain commit; confirmed durable outbox rows remain the authority and wakes are only hints.
No provider IO occurs in this port. Independent real-PG barrier coverage must validate these limits
and cleanup/commit outcomes before acceptance; this accepted binding is a requirement, not runtime proof.

Exact CLI forwarding coverage: `apps/capybara/test/start.test.ts` already mocks startKernelApp and
config loading; add main→runStart→kernel option assertions there using a non-starting mock, together
with `args.test.ts` and `env-file.test.ts`. Do not run real start via `test/support/cli.ts`'s
`runCliInProcess`, which explicitly excludes start. Lifecycle fixtures are
`packages/kernel/test/lifecycle/start-order.test.ts`, `roles.test.ts` and
`graceful-shutdown.test.ts`; real activation assertions belong in the new config tests listed in
the plan. Existing semantic regression evidence is `test/sandbox/permission-wiring.test.ts`
(publisher/Full cases near lines 1132–1185), read-only to 6c unless root serializes a specific edit.
Operator documentation is `docs/deploy/README.md`, under Roles and scaling (near line 285), with
rollout/rollback sequencing in `docs/deploy/upgrade.md` after How an upgrade runs. No doc-path TBD.

## Integration handoff and retained gates

Task 6c follows accepted Task 6b and must be accepted **before Task 8 activation**. Proposal work is
independent now; implementation may run alongside Task 7/8a only after a file-ownership handoff
freezes 6b's lifecycle/config/publication interfaces. That baseline is now `429e837f8`; its active
record/projection and epochs need no new migration for this change.

Binding review must confirm the bounded transaction-port addition above; all accepted semantic,
mixed-payload, real-consent and shutdown/ambiguous-commit tests remain mandatory. Ownership:

1. Task 6c owns publisher/startup/CLI/options and the narrow TransactionHost startup port. Task 7
   consumes existing fence ports and must not edit transaction-host concurrently; any required
   common-port change is serialized by root before either implementation relies on it.
2. PermissionCeilingWrites/profile/approval/event/schema/migration files remain outside 6c edits.
   If accepted negative/positive consent tests expose a lower-writer change, report it for isolated
   integration, not parallel profile edits. ConfigService's effective hot projection remains intact.
3. Root owns shared unit/container test lists, registries and any common fixture membership edits;
   6c supplies exact new test paths. Preserve one app per integration file and reuse existing
   semantic coverage without claiming spies prove consent/admission behavior.

If binding review finds the narrow transaction port insufficient, correct that port before dispatch;
do not substitute generic config consensus, a force overwrite, automatic startup publication or
an additional model-callable control plane.
