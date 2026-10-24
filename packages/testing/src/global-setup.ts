import {
  PG_ADMIN_URL_ENV,
  REDIS_DATABASES_ENV,
  REDIS_URL_ENV,
  SHARED_REDIS_DATABASES,
  sharingDisabled,
  startPostgresContainer,
  startRedisContainer,
  type TestContainer,
  withRedis,
} from "./containers.js";

/**
 * Vitest `globalSetup`: start one PostgreSQL 17 and one Valkey for the whole run and publish their
 * addresses through `CAPYBARA_TEST_PG_ADMIN_URL` / `CAPYBARA_TEST_REDIS_URL`. Workers (forks pool)
 * are spawned after this runs and inherit `process.env`, so `startTestPostgres()` /
 * `startTestRedis({ shared: true })` in any test file see them.
 *
 * - `CAPYBARA_TEST_NO_SHARED=1` disables sharing: nothing starts, every file starts its own containers.
 * - An address already present in the environment (e.g. a CI service container) is used as is.
 *   For an external Redis the allocator wraps on its `CONFIG GET databases` value (at least 2 needed;
 *   start it with `--databases 1024` for headroom). Where `CONFIG` is disabled the server is assumed
 *   to have 1024 databases, so it must be started with `--databases 1024`.
 *   An external PostgreSQL is not cleaned up: `cap_*` databases of crashed or killed runs (stop()
 *   never ran) accumulate on a long-lived server and need dropping by hand now and then.
 */
export default async function setup(): Promise<() => Promise<void>> {
  if (sharingDisabled()) return async () => {};
  const wanted: [string, () => Promise<TestContainer>][] = [];
  if (!process.env[PG_ADMIN_URL_ENV]) {
    wanted.push([PG_ADMIN_URL_ENV, () => startPostgresContainer({ tuned: true })]);
  }
  const externalRedis = process.env[REDIS_URL_ENV];
  const setDatabases = externalRedis !== undefined && externalRedis !== "";
  if (setDatabases) {
    process.env[REDIS_DATABASES_ENV] = String(await redisDatabases(externalRedis));
  } else {
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
    if (setDatabases) delete process.env[REDIS_DATABASES_ENV];
    await Promise.allSettled(owned.map((c) => c.stop()));
  };
}

/** `CONFIG GET databases` of an external Redis; {@link SHARED_REDIS_DATABASES} when CONFIG is disabled. */
async function redisDatabases(url: string): Promise<number> {
  const reply = await withRedis(url, (r) =>
    (r.config("GET", "databases") as Promise<string[]>).catch(() => undefined),
  );
  const n = reply === undefined ? SHARED_REDIS_DATABASES : Number(reply[1]);
  if (!Number.isInteger(n) || n < 2) {
    throw new Error(
      `${REDIS_URL_ENV} must point at a Redis with at least 2 databases (got ${reply?.[1]}); ` +
        "start it with --databases 1024",
    );
  }
  return n;
}
