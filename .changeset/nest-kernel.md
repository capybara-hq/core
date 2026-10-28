---
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
"@capybara-hq/testing": patch
---

The kernel is being refactored into a standard NestJS application: shared infra modules (config,
logging, database with `@Transactional`, Redis) come first, with no change in behaviour.

The kernel is now built as one Nest application (`createKernelApp` / `startKernelApp`) whose
lifecycle owns the start order and the stop phases; `createKernel` remains as a facade over it.

Queue and schedule infra: BullMQ root configuration (`QueueModule`, `runJob`, `logJobFailure`), the cron
scheduler and `@LockedCron` (a try-once cross-replica lock around `@Cron`); lock renewal loss is now
reported before expiry.

Redis-backed rate limiting infra: `@nestjs/throttler` with a shared Redis storage (fail-open) and the
kernel's credential limits as named throttlers, applied per route with `@Throttled`.

Health is terminus-based (`HealthModule`, `/healthz` and `/readyz` with unchanged bodies, status
codes and replica header); readiness reads a `ShutdownState` the shutdown service will provide.

Zod DTOs: `createZodDto`, `@ZBody` / `@ZQuery` / `@ZParam` and a global validation pipe with the same
`validation_failed` error as `ZodPipe`; new `http.swagger` (default false) serves the OpenAPI document
at `/docs`.

Graceful shutdown: `GracefulShutdown` is the one shutdown state (readiness, the start abort, the 30 s
stop deadline that the stop phases and the Redis / pool closes now share, `trackInFlight` / `drain`);
event streams close when the shutdown begins and later ones end at once; the main Redis connection
closes with QUIT again. `startKernelApp` handles SIGTERM / SIGINT from before the start (a signal
during the start aborts it; a second signal exits at once). `capybara start` installs process
guards: unhandled rejections and uncaught exceptions are logged, more than 5 within 60 s exit.

The legacy service graph consumes the infra providers (one pool, Redis connection, bus and config
holder).

Breaking export rename: the `KernelDb` type (the `capybara` schema view, a `Kysely<KernelDatabase>`)
is now `KernelSchemaDb` in `@capybara-hq/kernel` and `@capybara-hq/testing`; `KernelDb` now names the
injectable, context-aware database handle class.

Storage, models and skills are Nest modules: `StorageService`, `PricesService`,
`ModelPurposesService`, `SkillsService`, `SkillChangesService` and one `SkillInvoker` are injectable
providers. Export change: the prefixing logic is the plain class `PrefixedStorage` (over a
`StorageSource`, formerly `StorageServiceDeps`), which `StorageService` extends; an extension's
`ctx.storage` and the CLI build a `PrefixedStorage`. The `storage-org-purge` job is an hourly
`@LockedCron` (same name); its old maintenance scheduler is removed when a worker starts.

Breaking export change: `ExtensionHost`'s third constructor argument now requires `registry` (an
`ExtensionRegistry`, the shared provider the host writes and other services read extension points
from); code that builds a host by hand passes `registry: new ExtensionRegistry()`.

`@Transactional` / `TransactionHost.run` accept `propagation: "mandatory"` (join the transaction in
context, throw outside one) for methods that rely on a lock their caller holds.

Identity, orgs and admin are Nest modules (`IdentityModule`, `OrgsModule`, `AdminModule`):
`AccountsService`, one `SessionService`, `ApiTokenService`, one `SettingsService`,
`ExternalIdentities`, `IdentityBinding`, `SsoFlow`, `OrgsService`, `OrgSettingsService`,
`MembersService`, `InvitationsService`, `SetupService`, `Offboarding` and `DirectorySync` are
injectable providers; their constructors take the kernel's providers (export change). The org row
lock and the enterprise admin lock are the providers `OrgLock` and `EnterpriseAdminLock`
(`propagation: "mandatory"`: they join the caller's transaction); transaction-scoped advisory locks
go through the infra `XactLock`. Export changes: `SetupService.createEnterpriseAdmin` /
`createEnterpriseAdminIfNone` moved to `AccountsService`; `LoginRateLimiter` is removed;
`standaloneDatabase(pool, log)` gives the database handles to code that runs outside the kernel
application (the CLI's `admin create` / `admin grant`, `@capybara-hq/testing`'s
`createLocalAccount`, whose signature is unchanged). The `directory-scan` and `offboard-sweep` jobs
are `@LockedCron` jobs (hourly at the top of the hour, every 10 minutes); their old maintenance
schedulers are removed when a worker starts. The credential routes (login, change password, setup
token, invitation accept) are limited by `CredentialThrottler` with the same limits, codes, bodies
and `retry-after`; their counters move to new Redis keys (`throttler:{cred:<group>}:…` instead of
`capk:login-fail:*` / `capk:rl:*`), so the counts reset once at deploy.
