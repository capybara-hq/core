---
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
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
