---
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
"@capybara-hq/testing": patch
---

The kernel is now one standard NestJS application (`createKernelApp` / `startKernelApp`): global
infra modules (config, logging, the database with transactions, Redis, locks, cache, queues,
schedules, throttling, health, validation), one module per domain whose services are injectable
providers with one instance each, and the role modules `roles` selects (api, worker, gateway).
One lifecycle provider owns the start order and the stop phases. Every concern is done one way,
enforced by the new check `check:kernel-conventions`. Extensions are unchanged: they see only the
SDK `ctx`, which the extension host builds from the injected services. HTTP routes, status codes,
error codes and bodies, queue names, job ids, the event log, config keys and the SDK are unchanged
except where noted below. The decisions made during the work are recorded in the appendix of the
design spec (`docs/superpowers/specs/2026-10-28-nest-kernel-design.md`).

**Operations**

- **`capybara bootstrap` needs Redis.** The bootstrap step runs under the Redis lock
  `lock:bootstrap` (120 s TTL, renewed while it runs), in a starting kernel and in
  `capybara bootstrap` alike, instead of a PostgreSQL advisory lock, so compose `init` and a
  Kubernetes init Job need `CAPYBARA_REDIS__URL` as well as the database; the compose `init` service
  waits for valkey. During the rolling deploy that brings this change an old and a new process do
  not exclude each other; the step is recorded once per manifest and its writes are idempotent. The
  CLI's Redis connection keeps reconnecting, so a `capybara bootstrap` holding the lock survives a
  Redis blip.
- **Periodic jobs** were BullMQ repeatable schedulers on the maintenance queue; they are now
  schedules inside the worker processes, each run once per period across all worker replicas
  (another replica's attempt logs at info). Names and periods are unchanged: `wait-sweep`,
  `usage-report-sweep`, `attachment-cleanup`, `storage-org-purge`, `sandbox-suspend-idle`,
  `sandbox-destroy-inactive`, `drift-scan`, `catalogs-refresh`, `output-cleanup`,
  `app-staging-cleanup`, `directory-scan`, `offboard-sweep`, `plugins-reconcile`,
  `channel-gateway-check`. A starting worker removes the old schedulers from Redis. They still run
  only on processes with the `worker` role, as do all queue consumers; an `api`- or `gateway`-only
  process builds no BullMQ worker and no scheduler.
  - A worker runs no periodic job before its start sequence (migrations, the bootstrap step, the
    extension load) has started its queue consumers; a tick that fires earlier is skipped with the
    info line `cron skipped: the scheduler is not started`. `catalogs-refresh` and `drift-scan` run
    once at that point, as their schedulers' first run did. At shutdown the schedules stop first and
    runs in progress are awaited within the stop budget, so a stop leaves no run lock behind.
  - Every hourly job now fires at the top of the hour (`attachment-cleanup`, `output-cleanup`,
    `app-staging-cleanup`, `directory-scan`, `storage-org-purge`, `sandbox-destroy-inactive`): the
    first run after an upgrade is at the next full hour. The 10-minute and 1-minute jobs fire on
    clock boundaries; their periods are unchanged.
  - A job whose run lock is lost (Redis outage, another holder) has its abort signal fired and a
    failure after the loss is logged at warn; only a job that reads the signal stops early (today
    `catalogs-refresh`). The others are idempotent sweeps and finish their pass.
  - A periodic job's name enqueued on `cap-kernel-maintenance` (by an operator or a test) runs that
    job once, as before; it is not a second schedule.
  - `sandbox-destroy-for`, `wait-timeout`, `drift-connector` and `directory-sync` stay one-off jobs
    on the maintenance queue (names, data, ids and retries unchanged: `drift-connector` still runs
    once), consumed by one maintenance processor on the worker role.
- **Shutdown.** `capybara start` handles SIGTERM / SIGINT from before the start: a signal turns
  `/readyz` to 503 at once and aborts a start in progress at its next step; the stop phases, the
  queue and worker closes, and finally Redis, the bus and the pool (closed together) share the 30 s
  stop budget; a second signal exits 1 at once. Event streams close when the shutdown begins and
  later ones end at once. In-process events raised while the stop drains runs (a run finishing,
  an approval decided) are still handled, so IM final deliveries and resumes are not lost during a
  rolling deploy. With Redis unreachable the stop now uses the whole budget: queues and workers
  that cannot close are abandoned instead of holding the exit, and the pool still gets its share.
  The main Redis connection closes with QUIT.
- **Unhandled errors.** `capybara start` logs an unhandled rejection or uncaught exception and exits
  1 only after more than 5 within 60 s (it exited on the first); other commands still exit on the
  first. A PostgreSQL restart while a pooled client is checked out is logged (`pg client error`,
  warn) instead of crashing the process.
- **Leases give up on a deadline.** Every Redis lock and lease (the conversation run lease
  `capk:conv-run:<id>`, channel long-connection leases, sandbox and path leases, org run and eval
  quota slots) is renewed every third of its TTL and is lost at the send time of its last successful
  renewal + TTL − TTL/3, even with a renewal in flight, so a holder lets go one renewal period
  before the key can be taken elsewhere. Before, a conversation lease whose renewals failed until
  expiry kept running, so a second replica could start a second run on the conversation. After a
  Redis outage longer than about two thirds of a TTL a run is now re-queued (and resumes), a long
  connection reconnects, and a sandbox path lease is lost too; a lapsed quota slot lets the run or
  eval go on, so an org may briefly run more than its concurrency (for evals after an outage of
  about 40–60 s). A lost lease logs one `lock lost: <key>` warning (it replaces `channel lease lost;
  disconnecting`, `sandbox lease lost`, `sandbox path lease lost`, `org quota lease lost` and `eval
  quota renew failed`); a failed release logs `lock release failed` at warn (the key expires within
  its TTL). Keys and values are unchanged. A channel lease lost while its connection's config is
  read is no longer connected on. A shared sandbox lease renewed while it is being downgraded is
  no longer lost.
- **Rate limits.** The credential limits (login, change password, setup token, invitation accept)
  keep their limits, codes, bodies and `retry-after`, and still fail closed when Redis is down;
  their counters move to `throttler:{cred:<group>}:…` (from `capk:login-fail:*` / `capk:rl:*`),
  so the counts reset once at deploy.
- **Directory sync** takes its per-(org, extension) lock as `lock:directory-sync:<org>:<plugin>`
  (was `capk:directory-sync:<org>:<plugin>`): during a rolling deploy an old and a new replica may
  each run one sync of the same pair (harmless: the dirty flag and idempotent writes cover it).
- **Model list cache** keys are `cache:capk:models:…` (old keys expire by TTL), and the cache fails
  open: a Redis error lists the provider's models again instead of failing the request.
- **After-commit work.** Notifications after an org extension config write, an extension install,
  state change or uninstall, and an org plugin uninstall run after the commit; a failing one is
  logged and no longer turns the committed request into a 500. After-commit work always runs
  outside any transaction, and kernel bus handlers run outside any transaction and without the
  log context of the code that subscribed.
- **New error code** `lock.acquire_failed` (409, with the lock key in `details[0].lockKey`; en and
  zh copy in the web app): raised when a kernel lock cannot be taken in time. No route raises it
  today.
- **Validation.** The UI `:plugin/:id` and file preview `:plugin/:previewerId` routes validate their
  parameters with DTOs: `validation_failed` names the parameter in `details[].path` (was `""`);
  code and status are unchanged.
- **Swagger.** New config `http.swagger` (default `false`, `CAPYBARA_HTTP__SWAGGER`) serves the
  OpenAPI document and UI at `/docs` (unauthenticated: development and trials only).
- **CLI.** A kernel that cannot even be built now logs `kernel start failed` (was `cannot load
  configuration`); the exit code is still 1. `capybara admin create` / `admin grant` still need
  only PostgreSQL.

**`@capybara-hq/kernel` API (breaking)**

- Removed: `createKernel`, the `Kernel` facade type, `KernelOptions` and `KernelRuns`. Build the
  kernel with `createKernelApp(config, options)` (started, not listening, no signal handlers) or
  `startKernelApp(config, options)` (started, listening, SIGTERM / SIGINT handled), stop it with
  `closeKernelApp(app)`, reach its HTTP side with `kernelAppHttp(app)` / `kernelAppPort(app)` and a
  service with `app.get(Class)`. The options are `KernelAppOptions` (the old `KernelOptions` fields
  `loop`, `runHooks` and `evalHooks` are gone).
- Removed: `createHttpApp`, `CreateHttpAppOptions` and `HealthOptions`; there is no standalone HTTP
  app any more, only the kernel application's (`KernelHttp` and `KernelHttpApp` stay).
- `KernelAppOptions.overrides` is for the kernel's own tests only: it takes values for the named
  seam tokens of `KernelOverride` and refuses any other token when the application is built, so no
  kernel service can be replaced. The seam tokens are not exported.
- The type `KernelDb` (the `capybara` schema view, a `Kysely<KernelDatabase>`) is renamed
  `KernelSchemaDb`; `KernelDb` is no longer exported.
- Every exported service class (`ExtensionHost`, `ExtensionInstalls`, `ExtensionLifecycle`,
  `ExtensionAdminOps`, `BootstrapService`, `SandboxService`, `StorageService`, `AccountsService`,
  `SetupService`, `SessionService`, `SettingsService`, `OrgsService`, …) is a Nest provider whose
  constructor takes the kernel's providers: take instances with `app.get(Class)` from an
  application or a CLI context instead of constructing them. Removed with that:
  `BootstrapServiceDeps`, `ExtensionAdminOpsDeps`, `ExtensionLifecycleDeps`, `LifecycleHost`,
  `SandboxServiceDeps` and `StorageServiceDeps`. The prefixing storage is the plain class
  `PrefixedStorage` over a `StorageSource` (an extension's `ctx.storage` and the CLI use it), which
  `StorageService` extends.
- Moved or changed: `SetupService.createEnterpriseAdmin` / `createEnterpriseAdminIfNone` are on
  `AccountsService`; `BootstrapService.run` takes the plugin import it uses (`imports`);
  `rewrapDataKeys(handles, keyring)` takes the database handles of an application context
  (`{ db, txHost }`) instead of a Kysely and opens its own transaction; `ExtensionCli` exposes the
  command's application context (`app`) and `bootstrap` instead of `db`; `ExtensionLifecycle` no
  longer publishes the periodic reconcile itself (the worker's `plugins-reconcile` job does).
- New: the type `KernelOverride`; `openKernelCli(config, opts)` (a CLI command's application
  context; `redis: false` leaves Redis and the lock service out), `openKernelCliOverPool(pool,
  opts)` (a context over a pool the caller owns and keeps open), `KernelCliOptions` and
  `AccountsModule`; `handleShutdownSignals` with `ShutdownSignalOptions` / `ShutdownSignalHandle`,
  and `installProcessGuards` with `ProcessGuardDeps`, `GUARD_CIRCUIT_LIMIT` and
  `GUARD_CIRCUIT_WINDOW_MS`.

**`@capybara-hq/testing` API (breaking)**

- `startTestKernel(config, opts)` (options unchanged, no `overrides`) starts the kernel with
  `startKernelApp` on a signal source of its own (no process-wide handlers) and returns a
  `TestKernel` `{ app, http, port, close() }` instead of the `Kernel` facade; `port` is
  `number | undefined` (undefined after `close()`). `app` is the kernel's Nest application, for
  tests that can import kernel classes; a plugin test drives the kernel through `http` and the
  helpers of this package.
- The `Kernel` and `KernelDb` re-exports are removed; `TestKernel`, `KernelApp` (the Nest
  application type) and `KernelSchemaDb` are exported. `login(k, …)` / `joinOrg(k, …)` take any
  `{ http }`.
- `createDualReplicaHarness` keeps its API; each replica starts with `startKernelApp`, and the
  harness's stop sends SIGTERM to the replica's own signal source, so a replica stops through the
  same shutdown path as `capybara start`. `createLocalAccount` keeps its signature.
- Migration for extension tests: type the kernel as `TestKernel` instead of `Kernel`, call
  `k.close()` instead of `k.stop()`, treat `k.port` as `number | undefined`, and import the type
  `KernelSchemaDb` instead of `KernelDb`; `k.http` is unchanged. The official plugins'
  (capybara-hq/plugins) tests need the same migration.
