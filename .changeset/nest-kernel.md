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
