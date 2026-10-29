# The kernel as a standard NestJS application

Status: implemented (2026-10-30, branch `refactor/nest-kernel`; plan
`docs/superpowers/plans/2026-10-28-nest-kernel.md`). Where the implementation refined this design,
the appendix "Decisions made during implementation" records each decision (R1–R26, N1–N10), and
`AGENTS.md` and `.agents/skills/writing-kernel-api` describe the result.
Decided in conversation on 2026-10-28: the server is a normal Nest application, the web app is
Next.js, extensions never see Nest; keep Kysely (no TypeORM); octok-platform's infrastructure code
may be ported (with the owner's permission; octok's `package.json` says MIT, the repository has no
LICENSE file); prefer official or existing Nest modules over home-grown ones; do this refactor
**before** the manual acceptance.

## 1. Why

`AGENTS.md` and `writing-kernel-api` say "domain classes don't depend on Nest; they are wired with
`useFactory`". In practice the kernel became a hand-wired program with Nest as an HTTP shell:

- `createKernel` (`packages/kernel/src/kernel.ts`, ~1,700 lines) constructs ~59 objects by hand,
  `ApiModule.register` builds 35 more with `useFactory` and passes 31 through with `useValue`;
  `ConversationsService`, `AgentsService` and `SkillInvoker` exist three times, `SessionService`,
  `SettingsService` and `OrgQuota` twice.
- Cycles are broken with late-bound closures (`waits` ↔ approvals / questions / run queue,
  `eventLog` → channel outbound, `host` ↔ installs / deployment configs, channel connections ↔
  outbound ↔ inbound).
- `start()` / `stop()` are 400 lines of hand-ordered steps outside any lifecycle framework.
- Infrastructure that octok already runs in production (transaction propagation, distributed
  locks, cache, Redis throttling, scheduling, health) is either missing or re-invented per call
  site (~150 hand-written `db.transaction()` blocks that pass `trx` down; locks are ad hoc).

That was a misreading of the intended rule, which is only: **extensions** don't depend on Nest.

## 2. Target

```
NestFactory.create(KernelModule.forRoot(config, options), FastifyAdapter)
├─ Global infra (packages/kernel/src/infra/*)
│   ConfigModule     KernelConfigService: current config (getter), onChange, hot appliers,
│                    source watch (file / Nacos) started on bootstrap, stopped on shutdown
│   LoggingModule    KernelLogger (pino, redaction, context) + Nest logger adapter
│   DatabaseModule   Kysely pool; TransactionHost (ALS); `KernelDb` = context-aware handle;
│                    @Transactional(); migrations runner
│   RedisModule      clients (main, bus subscriber), kernel bus
│   LockModule       LockService + @WithLock (octok: SET NX PX, renewal, Lua release,
│                    LOCK_ACQUIRE_FAILED)
│   CacheModule      @Cacheable / @CacheEvict (octok, Redis, fail-open)
│   QueueModule      @nestjs/bullmq BullModule.forRoot (connection, job defaults)
│   ScheduleModule   @nestjs/schedule; cron + @WithLock pattern (octok)
│   ThrottlerModule  @nestjs/throttler + RedisThrottlerStorage (octok)
│   HealthModule     @nestjs/terminus: /healthz (live), /readyz (db, redis, not shutting down)
│   SwaggerSetup     @nestjs/swagger from the zod schemas (dev or `http.swagger: true`)
├─ Domain modules (one per directory): Identity, Orgs, Agents, Conversations (runtime),
│   Tools, Connectors, Channels, Sandbox, Storage, Skills, Catalog, Extensions, Evals,
│   Models, Ui, Admin — services are @Injectable providers, one instance each
├─ Role modules, imported by `roles`:
│   ApiModule      controllers, guards (AuthGuard, OrgGuard), @Public, ZodPipe, ErrorFilter
│   WorkerModule   queue processors, repeatable schedules, cron jobs
│   GatewayModule  channel supervisor, webhook inbound
└─ KernelLifecycle  ordered start / graceful stop on Nest hooks (§4)
```

### 2.1 Rules that change

- Domain services are Nest providers (`@Injectable()`), injected by class with explicit
  `@Inject(Class)` (esbuild / tsx emit no decorator metadata, so constructor types are not
  available at runtime; this stays as today). No more `useFactory` wiring of domain classes.
- Domain code may use Nest and the infra decorators (`@Transactional`, `@WithLock`,
  `@Cacheable`, `@Cron`, `@Processor`). Pure functions stay pure.
- **Extensions are unchanged**: the SDK, `ctx`, the extension lifecycle (setup / dispose /
  signal), the permission manifest. `ExtensionHost` becomes a provider that builds each `ctx`
  from injected services (`KernelConfigService` for `ctx.config`, `KernelDb` for `ctx.db` on the
  extension's schema, Redis for `kv` / `lock` / `bus`, queues, storage, secrets). Nothing Nest
  crosses into `ctx`. No SDK API change.
- Multi-replica discipline (AGENTS.md) still holds: state in PG / Redis, `ctx` has no timers,
  BullMQ names without `:`. Fixed-period jobs are `@Cron` + `@WithLock` (try once); dynamic or
  delayed work is BullMQ delayed jobs (both as in octok; §2.4).

### 2.2 Transactions on Kysely (ported from octok)

- `TransactionHost`: `AsyncLocalStorage<{ trx: Transaction<Db> }>`.
- `@Transactional()` (REQUIRED): join the transaction in context, else open one with
  `db.transaction().execute()`; throw → rollback; return → commit. Optional `{ propagation:
  "requires_new" }` (separate connection) when a caller needs it.
- `KernelDb` (what services inject): every call resolves to the context transaction when there
  is one, else the pool. All ~150 explicit `db.transaction()` blocks and every `trx` parameter
  are converted; none remain (§2.4).
- `afterCommit(fn)`: run side effects (enqueue, publish) only after the root commit.
- Ported rules and checks: no `@WithLock` inside a transaction (the lock would be released
  before COMMIT), no queue / Redis side effects inside a transaction (use `afterCommit`); octok's
  `check-lock-tx` / `check-transactional` become `pnpm check` rules (proven red first).

### 2.3 What stays

Kysely and the SQL migrations (kernel `capybara`, extensions `plugin_<name>`); the config schema
and its sources (env > file / Nacos > PG > default); error codes and the HTTP error contract the
web app relies on (octok's 200-envelope is **not** adopted); the event log and replay
invariants; queue names and job ids; the SDK; `apps/capybara` commands; Fastify; pino logging and
optional OTel (done on 2026-10-28).

### 2.4 One convention per concern, no residue

The refactor ends with every concern done one way. Nothing old stays "for compatibility", and
each removed pattern gets a `pnpm check` rule (proven red first) so it cannot come back.
Exceptions must be listed in the check with their reason.

| Concern | Convention | Removed (checked) |
|---|---|---|
| Wiring | `@Injectable` providers in modules, `@Inject(Class)` | `createKernel` hand wiring, `useFactory` / `useValue` for domain classes, late-bound closures, duplicate instances, the `Kernel` facade |
| Config | `KernelConfigService` (`get`, `onChange`) | `config: () => current` closures passed around |
| Transactions | `@Transactional()` + `KernelDb` + `afterCommit` | `db.transaction()` / `startTransaction()` outside `infra/database`, `trx` / `KernelDb \| Transaction` parameters, `isTransaction` branching |
| Distributed mutual exclusion | `LockService` / `@WithLock` (Redis, renewal, `LOCK_ACQUIRE_FAILED`) | `pg_advisory_lock` outside migrations, hand-rolled `SET NX` locks and renew timers (`ConversationLock`, bootstrap lock, …) |
| Row locking | `FOR UPDATE` / `FOR NO KEY UPDATE` inside `@Transactional` queries | (SQL semantics, not a lock convention) |
| Fixed-period jobs | `@Cron` + `@WithLock` (try once, INFO when another replica holds it) | `Maintenance.schedule()` repeatable schedulers for fixed periods |
| Dynamic / delayed jobs | BullMQ delayed jobs with deterministic ids via `@nestjs/bullmq` | — |
| Queue consumers | `@Processor` / `WorkerHost` (`@nestjs/bullmq`), queues via `BullModule.registerQueue` | `new Worker(...)` / `new Queue(...)` in the kernel (extension queues behind `ctx.queue` stay: they are the extension contract) |
| Cache | `@Cacheable` / `@CacheEvict` | ad-hoc Redis caches in services |
| Rate limiting | `@nestjs/throttler` + `RedisThrottlerStorage` (login uses a login+IP tracker) | `LoginRateLimiter` and other hand-written counters |
| Validation / DTOs | `nestjs-zod` DTO classes + global pipe (feeds swagger) | per-parameter `new ZodPipe(schema)` |
| Health | `@nestjs/terminus` | hand-written `/healthz` / `/readyz` |
| Shutdown | Nest hooks + graceful shutdown service | `kernel.stop()` step list |
| Logging | injected `KernelLogger` | module-level loggers |

Shared / exclusive sandbox leases (`sandbox/leases.ts`) are a domain feature (reader-writer
leases with fencing); they are rebuilt on `LockService` primitives, not kept as a second lock
implementation.

## 3. Cycles and duplicates

- Duplicates become single providers.
- Each closure-broken cycle is redesigned, in this order of preference: (a) move the shared part
  into its own provider both sides depend on; (b) a domain event on the kernel bus or an
  in-process event emitter provider (only for same-process notifications that are already
  allowed to be lost / re-derived); (c) `forwardRef` as the last resort, listed in the plan.
  The four known cycles: waits ↔ approvals / questions / run queue; event log → channel outbound;
  extension host ↔ installs / deployment configs; channel connections ↔ outbound ↔ inbound.

## 4. Lifecycle

- `KernelLifecycle` (a provider) owns the start order in `onApplicationBootstrap`, so the order
  stays explicit and testable: Redis ready → kernel migrations → official marketplace sync →
  bootstrap (advisory lock) → extension host load → role parts (workers, schedules, gateway) →
  mount extension routes → extension lifecycle reconcile → config watch. `app.listen()` runs
  after `app.init()` resolves, so nothing is served before the extensions are loaded.
- Stop: `app.enableShutdownHooks()`; `beforeApplicationShutdown` flips readiness (503),
  aborts extension requests and drains in-flight runs / jobs / extension calls within the
  existing budgets (`STOP_BUDGET_MS`, `extensionHost.drainSeconds`); each module closes its
  own resources in `onModuleDestroy`; Redis and the pool close last in
  `onApplicationShutdown`. Workers pause (never `queue.pause()`), as octok does.
- Worker-only and gateway-only processes still create the Fastify app (health endpoints);
  `ApiModule` is simply not imported. CLI commands that need services (`admin create`,
  `bootstrap`, `extensions *`) use `NestFactory.createApplicationContext` with the modules they
  need (config loaded once, no watch).

## 5. Tests and callers

There is no compatibility facade in the final state. `createKernel` / `Kernel` are replaced by
`createKernelApp(config, options): Promise<INestApplication>` (plus `startKernelApp` that also
starts and listens). Tests and helpers use `app.get(Service)`:

- `packages/testing`: `startTestKernel` returns a `TestKernel` `{ app, http, port, close() }`
  started with `startKernelApp` (its own signal source, no process handlers); the dual-replica
  harness's replicas start with `startKernelApp` too and stop through the same shutdown path.
  Extension and plugin tests drive a real kernel this way and never replace a kernel provider.
- Test seams (decision R22): the old option hooks (`loop`, `runHooks`, `evalHooks`) and the mutable
  test fields became named seam tokens (`AGENT_LOOP_FACTORY`, `RUN_HOOKS`, `EVAL_REPLAY_HOOKS`,
  `TOOL_PIPELINE_HOOKS`, timing and clock tokens, `APP_INTERCEPTOR`), optional providers the kernel
  never provides. `KernelAppOptions.overrides` accepts only those tokens (`KernelOverride`) and
  refuses any other, so no domain class can be replaced; they serve the kernel's own tests only:
  the tokens are not exported, and `startTestKernel` takes no overrides.
- The 139 kernel test files that start a kernel and the 67 that read `k.<field>` are converted
  (`k.host` → `app.get(ExtensionHost)`, …).
- `apps/capybara`: `start` builds the app; `admin create`, `bootstrap`, `extensions *` and
  `plugins *` use `NestFactory.createApplicationContext` with the modules they need.

During the phases a temporary facade may exist on the branch so each phase can run the full
suite; it is deleted in the last phase, and a check forbids `createKernel(` afterwards.

## 6. Phases (each PR-sized, full suite green; details in the plan)

Ported infrastructure comes **before** the domain conversion, so each domain directory is
converted once, straight to its final form.

1. **Skeleton**: infra modules (config, logging, database + `@Transactional`, Redis),
   `KernelModule.forRoot`, `KernelLifecycle`, a temporary `createKernel` facade over the Nest app.
2. **Ported infrastructure and residue checks**: locks, cache, queues + `@LockedCron`,
   throttler, health, zod DTOs + swagger, graceful shutdown and process guards; the
   `check:kernel-conventions` rules with a shrinking pending list.
3. **Domain modules**, directory by directory, each to its final form (providers and every
   §2.4 convention; cycles and duplicates removed).
4. **Roles**: Api / Worker / Gateway modules imported by `roles`.
5. **No residue**: tests, testing package and CLI on `createKernelApp` / `app.get`; facade
   deleted; pending lists empty; AGENTS.md and skills rewritten.

## 7. Out of scope

TypeORM; changes to the HTTP error contract; the web app; the SDK and extension contracts;
service RPC / RabbitMQ (octok's `service-rpc`, `messaging`); snowflake ids (Capybara uses UUIDs).

## 8. Risks

- Start / stop ordering regressions → `KernelLifecycle` keeps one explicit sequence; the existing
  stop-budget, dual-replica and cleanup tests must pass unchanged.
- Decorator metadata: explicit `@Inject` everywhere (lint rule if a constructor parameter lacks
  it, proven red first).
- ALS boundaries: BullMQ processors, bus handlers and timers start fresh contexts; a transaction
  never spans them (documented, tested).
- Size: ~59 + 35 services, 42 controllers, 281 test files. Phases keep each PR reviewable; the
  facade keeps tests stable while internals move.

## Appendix: Decisions made during implementation

The plan left some questions open, and review raised others. Each decision below has a stable id.
The R-numbers are the ones used while the work was done; N-ids are decisions that had no number.
Code comments, `AGENTS.md` and the skills cite them as "decision R19 of the Nest kernel spec". Each
entry gives the decision, the reason and the cost. Decisions whose code is gone are listed at the
end as transitional.

### Conventions and behaviour

- **R1. DTOs use our own `createZodDto`, not `nestjs-zod`.** Reason: `nestjs-zod` peers Nest ≤ 11.
  The intent of §2.4 (a zod DTO, the global pipe, swagger) is kept. Cost: the helper is ours; it can
  be swapped later with the same API shape.
- **R4. The two migration runners keep their session-level `pg_advisory_lock`.** These are the
  kernel's `capybara-migrate:<schema>` and an extension's `capybara.plugin-migrate:<name>`
  (`extensions/migrate-lock.ts`), listed exceptions of `kc-lock`. Reason: migrations run before any
  Redis lock semantics matter, and the lock must live in the migrating PG session. Cost: two listed
  exceptions.
- **R5. The bootstrap step runs under `LockService.run("bootstrap")`.** The Redis key is
  `lock:bootstrap`, TTL 120 s, renewed while the step runs. §4's "(advisory lock)" is read as "the
  bootstrap lock". Reason: §2.4 removes `pg_advisory_lock` outside migrations. Cost: the mutual
  exclusion of bootstrap moved from PG to Redis; a dual-replica test guards it.
- **R6. `ExtensionRegistry` is one shared provider.** It holds the loaded instances, manifests and
  call tracking. The extension host fills it; storage, model purposes, connectors and sandboxes read
  it, never the host. Reason: this cuts the storage → host → installs → blobs → storage cycle with
  §3's option (a). Cost: the host's API is split in two.
- **R9. `pg_advisory_xact_lock` is transaction semantics, not a distributed lock.** It is like
  `FOR UPDATE`. It is allowed only through `XactLock.lock(key)` inside a
  `@Transactional({ propagation: "mandatory" })` method of one small `*Lock` provider per lock
  (`OrgLock`, `EnterpriseAdminLock`, `SetupLock`, `CatalogItemLock`, …). Session-level
  `pg_advisory_lock` / `pg_try_advisory_lock` stays forbidden outside the migration runners (R4).
  Reason: a Redis lock cannot live inside a transaction; it would add Redis to setup and the CLI and
  turn waits into 409s. Cost: §2.4's "pg_advisory_lock outside migrations" is read as session-level
  only.
- **R11. One consumer of `cap-kernel-maintenance`.** `MaintenanceProcessor` dispatches each one-off
  job by name (`wait-timeout`, `sandbox-destroy-for`, `drift-connector`, `directory-sync`). Reason:
  two consumers on one queue would race for each other's jobs. Cost: one switch.
- **R12. Lock providers and a pure audit helper.** `OrgLock` (org row lock, `orgs/org-lock.ts`) and
  `EnterpriseAdminLock` (`identity/enterprise-admin.ts`, `lockAndAuthorize`) are providers with
  `mandatory` methods that join the caller's transaction. `audit(db, …)` stays a pure helper over
  `KernelSchemaDb`. Reason: one implementation of "lock, then re-check the actor". Cost: none.
- **R13. CLI commands run on a Nest application context.** `openKernelCli(config, opts)` builds
  `KernelCliModule.forRoot(config, { modules })`: the config is loaded once, with no watch. This
  covers `extensions *`, `plugins *`, `bootstrap` and `admin *`. Reason: hand wiring would bypass
  the wiring rules. Cost: none beyond the context's start time.
- **R14. `capybara bootstrap` takes the same `lock:bootstrap` as a starting kernel.** So compose
  `init` and a Kubernetes init Job need Redis, and compose `init` waits for valkey.
  `LockService.acquire` takes a `signal` and `waitMs: Infinity` (an abortable, unbounded wait). The
  run body gets `AbortSignal.any([signal, handle.lost])`. Reason: one lock keeps an init Job and a
  replica from running the step at once. Cost: an init container needs Redis reachable.
- **R15. `@LockedInterval(name, (config) => ms)` for config-driven periods.** It is a sibling of
  `@LockedCron`: the tick marker is `floor(now / period) * period`, with the same renewed try-once
  run lock and the same INFO on skip. `plugins-reconcile`, `catalogs-refresh` and `drift-scan` use
  it. Reason: a cron expression cannot express an arbitrary number of seconds from the config. Cost:
  two schedule decorators.
- **R16. `@LockedInterval` takes `runOnStart`.** The job runs once at start, once across replicas,
  through the same tick-marker layer with a start marker. `catalogs-refresh` and `drift-scan` use it,
  as their old schedulers ran at once. Reason: behaviour unchanged (a fresh deployment refreshes its
  marketplaces at start, not after `refreshIntervalMinutes`). Cost: one option.
- **R17. A conversation lease whose renewals fail until expiry is lost.** The run aborts at its
  next step boundary and is re-queued; a delivery throws `DeliveryLostError`. Before, the run went
  on after its key expired, so a second replica could start a second run on the conversation.
  Reason: a correctness fix (one run per conversation). Cost: runs are interrupted (re-queued, not
  lost) by a Redis outage of about 20 s.
- **R18. How the runtime cycles are cut.** `Waits` owns a child's finish and stop. `RunJobs` is a
  producer-only provider. In-process `KernelEvents` (`run.orphaned`, `run.started`,
  `run.wait-stopped`) are emitted after the commit; if one is lost, the wait sweep or the next
  append derives it again. `QueueShutdown` closes queues and workers within the stop budget minus a
  2 s reserve, abandoning what cannot close, so a stop with Redis down takes about 30 s. The model
  list cache key moved to `cache:capk:models:…` and the cache fails open. Reason: §3 options (a) and
  (b). Cost: in-process events may be lost; every subscriber is re-derivable.
- **R19. A lease is lost at a deadline, not after a count of failures.** The deadline is the send
  time of the last successful renewal (or the acquire) + TTL − interval, where the interval is the
  renewal period, TTL/3. Any successful renewal through the handle (the watchdog or an explicit
  `renew()`) moves it. When the deadline passes without one, `handle.lost` aborts, even with a
  renewal in flight. This applies to every `LockService` lease that is kept alive (R17's lease too).
  Reason: a holder must let go before the key can be taken elsewhere, so there are never two holders.
  Cost: on a Redis blip longer than about 2/3 of a TTL a holder gives up early (a run is re-queued, a
  connection re-established, a quota slot lapses; an eval slot after an outage of about 40–60 s).
  Fake-timer tests pin it.
- **R20. Route parameters that need validation go through `@ZParam` DTOs.** `details[].path` then
  names the parameter (it was `""`). Code and status are unchanged. Reason: one validation path.
  Cost: one documented change in the error detail.
- **R21. No scheduled tick runs before the worker role started.** This covers cron, interval and
  `runOnStart`. `WorkerRole.start` opens the gate (`ScheduledRuns.open()`) after the migrations, the
  bootstrap step and the extension load. A tick before that skips at INFO (`cron skipped: the
  scheduler is not started`) and claims no marker or lock. `runOnStart` jobs run when the gate opens,
  and the stop closes it first. Reason: Nest arms the timers at application bootstrap, before the
  start sequence; the old schedulers ran only after it. Cost: none.
- **R22. Test seams are for the kernel's own tests.** `KernelAppOptions.overrides` takes only the
  named seam tokens of `KernelOverride` (`src/overrides.ts`) and refuses any other token when the
  application is built. The tokens are not exported, and `startTestKernel` takes no overrides.
  Reason: no kernel service can be replaced from outside. Cost: plugin tests drive a real kernel
  only.
- **R23. The maintenance consumer still accepts the periodic job names.** A periodic job's name
  enqueued on `cap-kernel-maintenance` runs that job's body once
  (`ScheduledRuns.runNow(name)`: no tick marker and no run lock, outside any transaction, with the
  stop signal). This is how a test or an operator triggers a sweep now. Reason: compatibility; the
  base's handler map ran these names. It is not a second schedule. Cost: one fallback in the
  dispatch.
- **R24. The package index does not export `KernelModule` or the infra decorators.** These are
  `Transactional`, `afterCommit`, `WithLock`, `Cacheable`, `CacheEvict`, `LockedCron`,
  `LockedInterval`, `Throttled`, `createZodDto` and `ZBody` / `ZQuery` / `ZParam`. Reason: no
  outside consumer could use them (`TransactionHost`, `LockService` and `KernelDb` are not exported),
  and exporting them would lock them under semver. Cost: re-export them when a consumer exists.
- **R25. The `inTransaction` callback options are gone.** The catalog's install and upgrade call
  `@Transactional()` methods (`PluginInstaller.enableExtension`, the skills'
  `createUploadedVersionIn`) that the writes join through the async context. They are REQUIRED, not
  `mandatory`, because the install opens no outer transaction. Reason: no generic callback
  transaction API (§2.4). Cost: none; the locks, the transaction and the order are unchanged.
- **R26. Two scoped `KC_EXCEPTIONS` for the `...overrides` spread in `KernelAppOptionsModule`.**
  These are `kc-wiring` and `kc-worker-only`, scoped by their `what` field to that one entry. Each
  override is a `{ provide: seam token, useValue }` checked when the application is built against
  `KERNEL_OVERRIDE_TOKENS` (R22), never a class. Reason: the build-time check is the guard there.
  Cost: two exception entries.
- **N1. `lock.acquire_failed` (409).** `LockService.run` / `@WithLock` raise it with the key in
  `details[0].lockKey`. Reason: `ApiError` has no data field, and the HTTP error contract stays
  unchanged (§2.3). Cost: none.
- **N2. Shared (multi-holder) leases are `LockService` primitives.** These are `tryShared`,
  `tryExclusive` and downgrades, used by the sandbox leases. Reason: §2.4 says the sandbox leases are
  rebuilt on `LockService`, not on a second lock implementation. Cost: `LockService` grows a ZSET
  API.
- **N3. `@LockedCron` runs once per tick.** It sets a per-tick marker (`SET NX
  cron:<name>:<scheduled tick ms>`, never released, TTL at least one period) and holds the renewed
  run lock, so a long run does not overlap the next tick. Reason: §2.4's "try once" must mean once
  per tick across replicas, as BullMQ's repeatable jobs did; releasing the lock alone would let two
  replicas run one tick. Cost: one Redis key per tick.
- **N4. Credential limits use `CredentialThrottler`.** It works over the same `NAMED_THROTTLERS`
  table and `RedisThrottlerStorage`: `reserve(names, req)` takes all of them or none in one EVAL,
  with the largest TTL, and `succeeded(names, req)` refunds. The credential routes call it at the
  same point as before. It fails closed on Redis errors, like the old `LoginRateLimiter`. The
  `@Throttled` guard stays the convention for plain per-route limits, which fail open. Reason: a
  pre-handler guard could not keep today's semantics (counting after validation, all-or-nothing,
  refunds). Cost: two entry points over one storage; the counter keys move to `throttler:{cred:…}`,
  so the counts reset once at deploy.
- **N5. Every pooled `pg` client gets an `error` listener** (warn `pg client error`). Reason: a
  PostgreSQL restart while a client is checked out must not become an `uncaughtException`, and the
  database module now owns the pool. Cost: one listener per client.
- **N6. DTO parameters use `@ZBody(Dto)` / `@ZQuery(Dto)` / `@ZParam(Dto)`.** The DTO travels as
  pipe metadata. `kc-zod-pipe` forbids a bare `@Body()` / `@Query()` / `@Param()` typed with a DTO.
  Reason: esbuild / tsx emit no `design:paramtypes`, so a pipe keyed on the metatype never sees the
  DTO. Cost: three decorators.
- **N7. `startKernelApp` installs `handleShutdownSignals`, not `app.enableShutdownHooks()`.** A
  signal flips readiness to 503 at once and aborts a start in progress. A second signal exits 1 at
  once. This supersedes §4's "Stop: `app.enableShutdownHooks()`". Reason: Nest's handler changes
  nothing before `onModuleDestroy`, ignores a second signal and re-raises. Cost: one small signal
  handler of our own.
- **N8. `@Transactional({ propagation: "mandatory" })` throws outside a transaction.** It is used on
  methods whose correctness depends on the caller's lock (`softDeleteIn`, `revertVersionIn`, the
  `*Lock` providers, …). Reason: it restores the guarantee the old `trx` parameter gave. Cost: one
  more propagation mode.
- **N9. Pending kernel-convention violations were a count ratchet** (`KC_PENDING`, `{ path, max }`;
  empty since the refactor finished). Late binding is checked by proxy: `forwardRef(` only through
  an allowlist with reasons, and `ModuleRef` `get` / `resolve` only in `infra/`. Reason: a general
  closure analysis is not feasible statically. Cost: a closure cycle could slip past the check, so
  review must catch it.
- **N10. `LockService` logs a failed release at WARN** (`lock release failed`). Reason: the key
  expires within its TTL anyway, so this is not an error. Cost: none.

### Transitional, removed

These shaped the branch while it was converted; their code is gone.

- **R2.** Test hooks (`loop`, `runHooks`, `evalHooks`) went through an internal token until the
  runtime was converted. Replaced by the R22 seams.
- **R3.** `ScheduleModule` lived in infra until the roles existed. Now the schedules are provided
  only under `WorkerModule`.
- **R7.** `LegacyPorts`, a late-bound bridge from converted providers to the legacy graph.
- **R8.** `legacyKernelView().transaction()` ran legacy transactions through `TransactionHost`, so
  converted helpers joined them.
- **R10.** `standaloneDatabase(pool, log)` gave code outside the Nest app (the CLI, the testing
  package, test helpers) a database and a transaction host. Replaced by `openKernelCli` /
  `openKernelCliOverPool` (R13).
