---
"@capybara-hq/testing": minor
---

Share test containers across a vitest run. New `globalSetup` (`@capybara-hq/testing/global-setup`)
starts one PostgreSQL 17 and one Valkey and publishes them via `CAPYBARA_TEST_PG_ADMIN_URL` /
`CAPYBARA_TEST_REDIS_URL`. Under it `startTestPostgres()` returns a fresh random database (`stop()`
drops it with `WITH (FORCE)`), `startTestRedis({ shared: true })` returns a free logical database
(`stop()` flushes it), and the dual-replica harness uses the shared PostgreSQL when no `pgUrl` is
given. `createFreshDatabase` is now exported. `CAPYBARA_TEST_NO_SHARED=1` restores per-call containers.
With an externally provided `CAPYBARA_TEST_REDIS_URL` the allocator wraps on its `CONFIG GET databases`.
