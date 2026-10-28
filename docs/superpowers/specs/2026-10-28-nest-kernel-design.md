# The kernel as a standard NestJS application

Status: draft for maintainer review (2026-10-28). Decided in conversation on 2026-10-28:
the server is a normal Nest application, the web app is Next.js, extensions never see Nest;
keep Kysely (no TypeORM); octok-platform's infrastructure code may be ported (with the owner's
permission; octok's `package.json` says MIT, the repository has no LICENSE file); prefer official
or existing Nest modules over home-grown ones; do this refactor **before** the manual acceptance.

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

- `packages/testing`: `startTestKernel` returns the Nest app; the dual-replica harness and the
  replica runner start `createKernelApp`; fakes override providers with Nest's testing
  utilities instead of `KernelOptions` hooks (`loop`, `runHooks`, `evalHooks`).
- The 139 kernel test files that start a kernel and the 67 that read `k.<field>` are converted
  (`k.host` → `app.get(ExtensionHost)`, …).
- `apps/capybara`: `start` builds the app; `admin create`, `bootstrap`, `extensions *` and
  `plugins *` use `NestFactory.createApplicationContext` with the modules they need.

During the phases a temporary facade may exist on the branch so each phase can run the full
suite; it is deleted in the last phase, and a check forbids `createKernel(` afterwards.

## 6. Phases (each one PR-sized, full suite green, behaviour unchanged unless stated)

1. **Infra skeleton**: `KernelModule.forRoot`, Config / Logging / Database / Redis / Queue
   modules; `createKernel` builds the Nest app and the existing hand-wired graph becomes one
   provider factory inside it; `KernelLifecycle` takes over start / stop.
2. **Domain modules**: convert directory by directory to `@Injectable` providers; remove
   `useFactory` / `useValue` wiring, duplicates and closure cycles (§3). Order: infra-adjacent
   (storage, models, skills) → identity / orgs → extensions / catalog → tools / connectors →
   conversations / runtime → channels → sandbox → evals / ui / admin.
3. **Lifecycle and roles**: Api / Worker / Gateway modules, graceful shutdown service, terminus
   health and readiness; every kernel queue consumer on `@nestjs/bullmq` processors
   (the run worker included).
4. **Ported infrastructure, applied everywhere**: `@Transactional` on Kysely + `afterCommit`
   (all explicit transaction blocks converted), `LockService` / `@WithLock` (all locks
   converted, sandbox leases rebuilt on it), `@Cron` for fixed-period jobs, `@Cacheable`,
   Redis throttler (login limiter included), `nestjs-zod` DTOs + swagger, process guards
   (octok `process-guards.ts`).
5. **No residue**: delete the temporary facade, convert the remaining tests and CLI commands,
   add the §2.4 checks, rewrite AGENTS.md, `writing-kernel-api` and `writing-extensions`
   (host as a provider), README sections; remove the "framework-agnostic" comments.

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
