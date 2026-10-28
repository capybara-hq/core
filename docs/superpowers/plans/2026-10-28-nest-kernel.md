# Nest Kernel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** the kernel becomes a standard NestJS application with one convention per concern (spec §2.4) and no residue; extensions keep seeing only the SDK `ctx`.

**Architecture:** infra modules first (config, logging, database with `@Transactional`, Redis, locks, cache, queues, schedule, throttler, health, zod DTOs), then each domain directory is converted straight to its final form (providers + all conventions) behind a temporary `createKernel` facade that keeps the 281 kernel test files running; the last phase deletes the facade, converts tests and CLI, and turns every residue check from "pending list" to "no exceptions".

**Tech Stack:** NestJS 12 + Fastify, Kysely, BullMQ via `@nestjs/bullmq` 12.0.0, `@nestjs/schedule` 12.0.2, `@nestjs/throttler` 6.7.1, `@nestjs/terminus` 12.1.0, `@nestjs/swagger` 12.0.5, ioredis, zod 4, pino, vitest.

**Spec:** `docs/superpowers/specs/2026-10-28-nest-kernel-design.md`

## Global Constraints

- One convention per concern, exactly as the spec §2.4 table; no compatibility code survives Phase 5.
- Explicit `@Inject(Token)` on every constructor parameter of a provider / controller / guard (esbuild and tsx emit no decorator metadata).
- Ported octok code (`/Users/grant/Octok/octok-platform/libs/common/src`, owner-approved) keeps a header comment `// Ported from octok-platform <path> (owner-approved, 2026-10-28).` and is adapted to Kysely / Fastify / pino; comments translated to English.
- `nestjs-zod` does not support Nest 12 (5.5.0 peers `@nestjs/common ^10 || ^11`): DTOs use our own `createZodDto` (zod 4 `z.toJSONSchema`), same API shape as octok's `createI18nZodDto`.
- Behaviour unchanged unless the spec says so: HTTP routes, status codes, error codes and bodies, queue names, job ids, event log, SDK, config keys (new keys only for new infra), multi-replica rules in AGENTS.md.
- Every residue check (Task 2.9) is proven red on a fixture first; during Phases 2–4 it has a `PENDING` directory list that only shrinks; Phase 5 empties it.
- Each task ends with: `pnpm lint && pnpm typecheck && pnpm check` and `pnpm exec vitest run packages/kernel apps/capybara packages/testing` green (Postgres / Valkey from `docker/compose.dev.yaml`).
- Commits: Conventional Commits, English, body ≤ 100 chars, `git -c user.name=Grant -c user.email=284885069@qq.com`, trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Changesets: `@capybara-hq/kernel` and `@capybara-hq/capybara` patch (and `@capybara-hq/testing` when its API changes). No SDK change.
- Never run CI / third-party action code against the real home directory; no force-push.

## Review Focus

- Start order: nothing is served (no `listen`) before bootstrap and extension load finish, on every role; a required bootstrap failure still keeps the process from listening.
- Stop: SIGTERM during a running conversation drains it within the existing budgets; Redis and the pool close last; a second SIGTERM does not hang.
- `@Transactional` across a BullMQ processor / bus handler boundary: the job starts a fresh context; a test proves a transaction never leaks into it.
- `@WithLock` renewal: a job longer than the TTL keeps the lock; a crashed holder's lock expires within the TTL; another replica logs INFO, not ERROR.
- Dual-replica: two replicas starting together still run bootstrap, migrations and each cron job once (existing dual tests plus one per converted cron).

---

## Phase 1: Skeleton

### Task 1.1: Infra modules (config, logging, database, Redis)

**Files:**
- Create: `packages/kernel/src/infra/config/{config.module.ts,kernel-config.service.ts}`, `infra/logging/logging.module.ts`, `infra/database/{database.module.ts,kernel-db.ts,transaction-host.ts,transactional.decorator.ts,after-commit.ts}`, `infra/redis/redis.module.ts`, `infra/tokens.ts`
- Test: `packages/kernel/test/infra/{config,database,transactional,redis}.test.ts`

**Interfaces (Produces):**
- `KernelConfigService`: `get(): KernelConfig`; `onChange(listener: (next: KernelConfig, changed: string[]) => void): () => void`; `apply(raw: unknown): void` (re-resolve, run `HOT_APPLIERS`, warn restart-only keys — moved from `kernel.ts:377-394,1277-1309`).
- `KERNEL_LOGGER` token → `KernelLogger`.
- `KernelDb` (injectable class): `get db(): Kysely<KernelSchema> | Transaction<KernelSchema>` plus the Kysely query methods proxied (`selectFrom`, `insertInto`, `updateTable`, `deleteFrom`, `with`, `fn`, …) resolving to the context transaction or the pool; `pool: Kysely<…>` (only for infra).
- `TransactionHost`: `run<T>(fn: () => Promise<T>, opts?: { propagation?: "required" | "requires_new" }): Promise<T>`; `current(): Transaction | undefined`.
- `@Transactional(opts?)`: method decorator using the `TransactionHost` found on `this` (injected property `txHost`), REQUIRED by default.
- `afterCommit(fn: () => void | Promise<void>): void`: queued on the root transaction, run after COMMIT, dropped on rollback; outside a transaction runs immediately.
- `RedisModule`: tokens `REDIS` (ioredis), `REDIS_SUBSCRIBER`, `KERNEL_BUS`; closes in `onApplicationShutdown`.

- [ ] Step 1: tests: `get()` returns the resolved config; `apply` runs the `log.level` applier and reports restart-only paths; `@Transactional` nested → one transaction (a row written by the inner call is rolled back by an outer throw); `requires_new` survives an outer rollback; `afterCommit` runs after commit, not after rollback; `KernelDb` outside a transaction hits the pool; ALS does not leak into a `setImmediate` started after the method returned.
- [ ] Step 2: run, see them fail; implement; pass.
- [ ] Step 3: commit `feat(kernel): config, logging, database and redis infra modules`.

### Task 1.2: KernelModule, KernelLifecycle and the temporary facade

**Files:**
- Create: `packages/kernel/src/kernel.module.ts` (`KernelModule.forRoot(config, options): DynamicModule`), `packages/kernel/src/lifecycle/kernel-lifecycle.ts`, `packages/kernel/src/app.ts` (`createKernelApp`, `startKernelApp`)
- Modify: `packages/kernel/src/kernel.ts` (body moves into a single `LEGACY_GRAPH` factory provider and `KernelLifecycle`; `createKernel` becomes the facade over `createKernelApp`), `packages/kernel/src/http/app.ts` (Nest app created once by `createKernelApp`, root module = `KernelModule`), `packages/kernel/src/index.ts`
- Test: existing suite; new `packages/kernel/test/lifecycle/start-order.test.ts`

**Interfaces (Produces):**
- `createKernelApp(config: KernelConfig, options: KernelAppOptions): Promise<NestFastifyApplication>` — builds, `init()` (runs `KernelLifecycle.onApplicationBootstrap`), does not listen.
- `startKernelApp(…)` — `createKernelApp` + `enableShutdownHooks` + `listen(config.http.port)`.
- `KernelAppOptions` = today's `KernelOptions` minus the test hooks, which become provider overrides: `overrides?: { provide: unknown; useValue: unknown }[]`.
- `KernelLifecycle`: `onApplicationBootstrap()` runs the start sequence of spec §4 in order; `beforeApplicationShutdown()` / `onApplicationShutdown()` run today's stop phases with `STOP_BUDGET_MS`.

- [ ] Step 1: `start-order.test.ts`: with a slow fake bootstrap, `/readyz` is unreachable until bootstrap and `host.load` finish; a required bootstrap failure rejects `createKernelApp` and closes Redis / pool.
- [ ] Step 2: implement; the whole existing suite passes unchanged (the facade returns today's `Kernel` fields via `app.get`).
- [ ] Step 3: commit `refactor(kernel): build the kernel as a Nest application behind a temporary facade`.

## Phase 2: Ported infrastructure and residue checks

Each task: tests first, port, `pnpm check` green, commit `feat(kernel): <piece>`.

### Task 2.1: LockService and @WithLock
- Create `infra/lock/{lock.module.ts,lock.service.ts,with-lock.decorator.ts,key-template.ts}` from octok `decorators/with-lock.decorator.ts`, `lock.initializer.ts`, `utils/common.utils.ts#generateKey`, `libs/flow/src/runtime/redis-token-lock.ts` (renewal at TTL/3, `unref`'d timer).
- `LockService.acquire(key, { ttlMs, waitMs, retryMs }): Promise<LockHandle | undefined>`; `LockHandle { release(); readonly lost: AbortSignal }` (aborts when renewal fails — an improvement over octok, tested); `LockService.run(key, opts, fn)`; `@WithLock({ key, ttl = 30_000, waitTimeout = 5_000, retryInterval = 100 })` throws `ApiError("lock.acquire_failed")` (new error code, 409) with `data.lockKey`.
- Primitives for leases: `LockService.lease(key, holder, ttlMs)` / `renew` / `releaseIf(holder)` (Lua compare-and-delete / compare-and-pexpire), used by Task 3.8.
- Tests: mutual exclusion across two Redis clients; renewal past TTL; expiry after a crash (stop renewing); key placeholders `#{0}`, `#{1.a}`, `#{id}`; `lost` fires when the key is deleted externally.

### Task 2.2: Cache
- `infra/cache/{cache.module.ts,cacheable.decorator.ts}` from octok `cache/*`: `@Cacheable({ key, ttl = 300, cacheNull = false })`, `@CacheEvict({ key | keys })`, prefix `cache:`, fail-open; explicit DI instead of DiscoveryService.
- Tests: hit / miss / null sentinel / evict after success only / Redis down → method called.

### Task 2.3: Queues and schedules
- `infra/queue/queue.module.ts`: `BullModule.forRootAsync` from `KernelConfigService` (redis url, `prefix` unchanged), job defaults; helper `logJobFailure` from octok `logging/bullmq-failure.logger.ts`; `withJobContext` kept as the processor wrapper (ALS log context + tracing).
- `infra/schedule/schedule.module.ts`: `ScheduleModule.forRoot()`; helper decorator `@LockedCron(expr, { name, lockKey, ttl })` = `@Cron` + try-once lock + INFO on contention (octok's two-layer pattern packaged once).
- Tests: a processor registered in a feature module consumes jobs (octok gotcha: module must `registerQueue`); `@LockedCron` runs once across two app instances.

### Task 2.4: Throttler
- `infra/throttler/{throttler.module.ts,redis-throttler-storage.ts}` from octok `throttler/*` (Lua, hash-tag keys, fail-open); trackers read Fastify `request.ip` after `trustProxy`.
- Named throttlers mirror today's limits; the login limiter's per (login, IP) rule becomes a named throttler with a `getTracker` over body login + IP (Task 3.2 removes `LoginRateLimiter`).

### Task 2.5: Health
- `infra/health/health.module.ts`: terminus; `/healthz` liveness, `/readyz` = db ping + redis ping + `GracefulShutdown.isShuttingDown()` → 503; response bodies and status codes equal today's (`http/health.controller.ts`), replica header kept.

### Task 2.6: Zod DTOs, validation pipe, swagger
- `infra/validation/{create-zod-dto.ts,zod-validation.pipe.ts}`: `createZodDto(schema)` returns a class with static `schema`; global `APP_PIPE` validates `body` / `query` / `param` whose metatype has `schema`; errors map to today's `validation_failed` body.
- `infra/swagger/swagger.ts`: `@nestjs/swagger` document built from DTO `schema` via `z.toJSONSchema`; served at `/docs` when `http.swagger: true` (new config key, default false; `docs/config.md` regenerated).

### Task 2.7: Graceful shutdown and process guards
- `infra/lifecycle/graceful-shutdown.service.ts` from octok `service-rpc/src/shutdown/graceful-shutdown.service.ts` (`trackInFlight`, `isShuttingDown`, `beforeApplicationShutdown`).
- `infra/lifecycle/process-guards.ts` from octok `tracing/process-guards.ts` (installed by `apps/capybara` start; circuit breaker >5 errors / 60 s → exit).

### Task 2.8: Infra wiring into KernelModule
- `KernelModule.forRoot` imports every infra module; `LEGACY_GRAPH` consumes `KernelDb`, `REDIS`, `LockService`, `KernelConfigService` instead of constructing its own; suite green.

### Task 2.9: Residue checks (`pnpm check:kernel-conventions`, part of `pnpm check`, full on PRs: cheap source scan)
- `tools/checks/src/kernel-conventions.ts` + `cli/kernel-conventions.ts`, rules (each with a red fixture under `tools/checks/fixtures/kernel-conventions/`):
  - `kc-transaction`: `.transaction()`, `.startTransaction()`, `isTransaction`, parameters typed `Transaction<` outside `infra/database`.
  - `kc-lock`: `pg_advisory` outside migrations; `"NX"` / `SET … NX` outside `infra/lock`; `setInterval` used for lock renewal (heuristic: in files importing ioredis outside `infra/`).
  - `kc-queue`: `new Worker(` / `new Queue(` / `new QueueEvents(` / `upsertJobScheduler(` outside `infra/queue` and `ctx/queue.ts`.
  - `kc-wiring`: `useFactory` / `useValue` with a domain class in `kernel.module.ts` / role modules; `new <Name>Service(` / known provider classes constructed outside tests and `infra/`.
  - `kc-inject`: constructor parameter without `@Inject(` in a class decorated `@Injectable` / `@Controller` / guard.
  - `kc-zod-pipe`: `new ZodPipe(`.
  - `kc-facade`: `createKernel(` anywhere.
  - `kc-lock-in-tx` / `kc-side-effect-in-tx`: ported from octok `scripts/check-lock-tx.ts` / `check-transactional.ts` (method with `@Transactional` calling a `@WithLock` method or `queue.add` / `redis.*` / `bus.publish` not inside `afterCommit`).
- `PENDING` map: rule → directories not yet converted (all domain dirs now); `kc-facade` pending on `kernel.ts` and tests.
- AGENTS.md CI section lists the check (full on PRs).

## Phase 3: Domain modules, each straight to its final form

For every task: convert the listed classes to `@Injectable` providers in `<dir>/<dir>.module.ts`, remove them from `LEGACY_GRAPH` and `ApiModule` factories, apply every §2.4 convention inside the directory (transactions → `@Transactional`, locks → `LockService`, fixed-period maintenance jobs → `@LockedCron`, consumers → `@Processor`, ad-hoc caches → `@Cacheable`, controllers' `new ZodPipe` → DTOs), remove the directory from every `PENDING` list, keep the full suite green. Commit `refactor(<dir>): Nest module with the kernel conventions`.

### Task 3.1: storage, models, skills
- `StorageService`, `PricesService`, `ModelPurposesService`, `SkillChangesService`, `SkillsService`, `SkillInvoker` (one instance); jobs: `storage-org-purge`, `attachment-cleanup` (if storage-owned).

### Task 3.2: identity, orgs, admin, settings
- `AccountsService`, `SessionService` (one), `ApiTokenService`, `ExternalIdentities`, `IdentityBinding`, `SsoFlow`, `SettingsService` (one), `OrgsService`, `OrgSettings`, `Members`, `Invitations`, `SetupService`, `Offboarding`, `DirectorySync`; `LoginRateLimiter` → named throttler; jobs `directory-scan`, `offboard-sweep` → `@LockedCron`; `directory-sync` one-off → delayed job.

### Task 3.3: extensions (host builds ctx from providers)
- `ExtensionHost`, `ReplicaStatusStore`, `OrgExtensionConfigs`, `ExtensionBlobs`, `ExtensionInstalls`, `ExtensionAdmin`, `ExtensionLifecycle`, `ExtensionAdminOps`, `BootstrapService` (advisory lock → `LockService.run("bootstrap", { ttlMs: 120_000 })` with renewal; dual-replica bootstrap test unchanged), `ExtensionDeploymentConfigService`.
- `createExtensionContext` takes `KernelDeps` built from injected `KernelDb` / `REDIS` / `KERNEL_BUS` / `KernelConfigService` / queues; the `host ↔ installs / deploymentConfigs` cycle is removed by moving the shared "desired state" reads into `ExtensionInstalls` and making the host depend on it one way (spec §3a).
- Job `plugins-reconcile` → `@LockedCron`.

### Task 3.4: catalog
- `PluginImport`, `MarketplacesService`, `CatalogService`, `CatalogRequests`, `PluginInstaller`, `OrgCatalog`, `PluginUpgrader`; jobs `catalogs-refresh`, `app-staging-cleanup` → `@LockedCron`.

### Task 3.5: tools and connectors
- `Credentials`, `ToolOutputs`, `ToolRegistry`, `ApprovalsService`, `QuestionsService`, `ToolDrift`, `Breaker`, `ConnectorContent`, `ToolPipeline`, builtin tool factories as providers, `ConnectorsService`, `OAuthFlow`; jobs `drift-scan`, `output-cleanup` → `@LockedCron`, `drift-connector` → delayed job.
- Cycle `approvals / questions → waits`: approvals and questions publish a domain event (`ApprovalDecided`, `QuestionAnswered`) on an in-process `KernelEvents` provider; `Waits` (Task 3.6) subscribes (spec §3b; the wait sweep already re-derives lost resumes).

### Task 3.6: conversations and runtime
- `EventLog`, `ProviderRegistry`, `ConversationLock` (→ `LockService` with renewal), `OrgQuota` (one per prefix via factory token, the only allowed factory: listed in the check), `RunAbort`, `KyselyCheckpointSaver`, `RunQueue`, `Waits`, `RunWorker` (`@Processor` on both run queues, concurrency from config, quota renewal via `LockHandle`), `UsageReporter` (`@Processor`), `TitleQueue` (`@Processor`), `AttachmentsService`, `ConversationsService` (one), `AgentsService` (one), `AgentTemplates`, `Trajectory`, `ConversationStreams`, subagent functions as a `SubagentsService`.
- Jobs `wait-sweep`, `usage-report-sweep`, `attachment-cleanup` → `@LockedCron`; `wait-timeout` → delayed job.
- Cycle `eventLog → channel outbound`: `EventLog` emits `EventAppended` on `KernelEvents`; channel outbound subscribes (Task 3.7).
- Test hooks `loop` / `runHooks` become provider overrides (`AGENT_LOOP_FACTORY`, `RUN_HOOKS` tokens); test helpers updated.

### Task 3.7: channels (gateway)
- `ChannelConnections`, `ChannelOutbound` (`@Processor` for `deliver` / `inbound`), `ChannelInbound`, `ChannelWebhooks`, `ChannelSupervisor` (renew / scan loops → `LockService` leases + `@Interval`-free design: supervisor loop stays a gateway-only provider started by `GatewayModule` lifecycle, its renewals through `LockHandle`); job `channel-gateway-check` → `@LockedCron`.
- Cycle `connections ↔ outbound ↔ inbound`: `onResume` becomes a `ChannelResumed` event.

### Task 3.8: sandbox
- `SandboxService`, leases rebuilt on `LockService.lease` primitives (shared / exclusive, fencing generation kept, `sandbox.maxConcurrentCommands`), jobs `sandbox-suspend-idle`, `sandbox-destroy-inactive` → `@LockedCron`, `sandbox-destroy-for` → delayed job. The sandbox lease tests run unchanged.

### Task 3.9: evals, ui, inbox, files, http plumbing
- `EvalQueue`, `EvalWorker` (`@Processor`), `EvalSets`, `EvalRuns`, `PreviewerRegistry`, `UiViews`, `EmbedTokens`, `OrgUiStreams`, `InboxService`, `ConversationOutputs / Artifacts / Files / Queue / SandboxStatus`, `ConversationToolInfo`; `Maintenance` class deleted (all its jobs moved); `LEGACY_GRAPH` is now empty and deleted.

## Phase 4: Roles

### Task 4.1: Api / Worker / Gateway modules
- `http/api.module.ts` becomes a static module importing the domain modules and declaring the 42 controllers (no `register(deps)`); `WorkerModule` imports the processors and cron providers; `GatewayModule` imports supervisor and webhooks (Fastify routes kept); `KernelModule.forRoot` imports them by `roles`; `ScheduleModule` and processors only in `WorkerModule` (a gateway-only process runs no cron).
- `test/identity/public-routes.test.ts` builds the app with `createKernelApp` instead of re-assembling `ApiModule.register`.
- Tests: worker-only process exposes only health routes and runs crons; api-only runs no processor (assert BullMQ worker count 0).

## Phase 5: No residue

### Task 5.1: Tests and testing package
- `packages/testing`: `startTestKernel` returns `{ app, http, close }` over `startKernelApp`; `replica-runner` / dual harness use `createKernelApp`; fixtures updated; `test/helpers/runs.ts#startKernel` same.
- Convert the 139 kernel test files that start a kernel and the 67 reading `k.<field>` to `app.get(Class)` (mechanical; one commit per test directory).

### Task 5.2: CLI
- `apps/capybara`: `start` → `startKernelApp` (+ process guards); `admin create`, `admin grant`, `bootstrap`, `extensions *`, `plugins *` → `NestFactory.createApplicationContext(KernelCliModule.forRoot(config, { modules }))` without config watch; their tests unchanged in behaviour.

### Task 5.3: Delete the facade and empty every PENDING list
- Delete `createKernel`, `Kernel`, `KernelOptions` hooks, `ApiDeps`; `index.ts` exports `createKernelApp`, `startKernelApp`, `KernelModule`, the infra decorators; `kc-*` rules have no pending entries; `pnpm check` green.

### Task 5.4: Docs
- AGENTS.md (three layers, multi-replica rules mention `@LockedCron` / `@WithLock` / `@Transactional`, CI table row for `check:kernel-conventions`), rewrite `.agents/skills/writing-kernel-api/SKILL.md` (modules, providers, conventions, testing with `app.get` and overrides), `writing-extensions` (host as provider; ctx unchanged), `writing-migrations` (transactions note), README developer sections, spec status → "implemented".
- Changesets: kernel, testing (API change: `startTestKernel`), capybara.
