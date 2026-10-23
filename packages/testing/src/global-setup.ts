import {
  PG_ADMIN_URL_ENV,
  REDIS_URL_ENV,
  SHARED_REDIS_DATABASES,
  sharingDisabled,
  startPostgresContainer,
  startRedisContainer,
  type TestContainer,
} from "./containers.js";

/**
 * Vitest `globalSetup`: start one PostgreSQL 17 and one Valkey for the whole run and publish their
 * addresses through `CAPYBARA_TEST_PG_ADMIN_URL` / `CAPYBARA_TEST_REDIS_URL`. Workers (forks pool)
 * are spawned after this runs and inherit `process.env`, so `startTestPostgres()` /
 * `startTestRedis({ shared: true })` in any test file see them.
 *
 * - `CAPYBARA_TEST_NO_SHARED=1` disables sharing: nothing starts, every file starts its own containers.
 * - An address already present in the environment (e.g. a CI service container) is used as is.
 */
export default async function setup(): Promise<() => Promise<void>> {
  if (sharingDisabled()) return async () => {};
  const wanted: [string, () => Promise<TestContainer>][] = [];
  if (!process.env[PG_ADMIN_URL_ENV]) {
    wanted.push([PG_ADMIN_URL_ENV, () => startPostgresContainer({ tuned: true })]);
  }
  if (!process.env[REDIS_URL_ENV]) {
    wanted.push([REDIS_URL_ENV, () => startRedisContainer({ databases: SHARED_REDIS_DATABASES })]);
  }
  const started = await Promise.allSettled(wanted.map(([, start]) => start()));
  const owned = started.flatMap((s) => (s.status === "fulfilled" ? [s.value] : []));
  const failed = started.find((s) => s.status === "rejected");
  if (failed) {
    await Promise.allSettled(owned.map((c) => c.stop()));
    throw (failed as PromiseRejectedResult).reason;
  }
  wanted.forEach(([env], i) => {
    process.env[env] = (owned[i] as TestContainer).url;
  });
  return async () => {
    for (const [env] of wanted) delete process.env[env];
    await Promise.allSettled(owned.map((c) => c.stop()));
  };
}
