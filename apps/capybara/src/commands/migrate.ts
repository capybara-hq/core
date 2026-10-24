import {
  createDb,
  KernelConfigSchema,
  type KernelLogger,
  loadConfig,
  migrateAll,
  secretValues,
} from "@capybara-hq/kernel";
import { BUILTIN_PLUGINS } from "../builtin-plugins.js";

/** Oldest supported PostgreSQL (`server_version_num`): migrations use `UNIQUE NULLS NOT DISTINCT`. */
export const MIN_PG_VERSION_NUM = 150_000;

/** The server's version: `server_version_num` (e.g. 170002) and `server_version` (e.g. "17.2"). */
export type ServerVersion = { num: number; text: string };

/** Reads the PostgreSQL server version over one short-lived connection. */
export async function queryServerVersion(
  url: string,
  connectTimeoutMs: number,
): Promise<ServerVersion> {
  const db = createDb(url, 1, undefined, { connectTimeoutMs });
  try {
    const row = await db
      .selectNoFrom((eb) => [
        eb.fn<string>("current_setting", [eb.val("server_version_num")]).as("num"),
        eb.fn<string>("current_setting", [eb.val("server_version")]).as("text"),
      ])
      .executeTakeFirstOrThrow();
    return { num: Number(row.num), text: String(row.text) };
  } finally {
    await db.destroy();
  }
}

export type MigrateDeps = {
  /** Injected in tests; defaults to querying the configured database. */
  serverVersion?: (url: string, connectTimeoutMs: number) => Promise<ServerVersion>;
};

/** `capybara migrate`：跑内核与所有已配置插件的迁移，返回退出码（0 成功 / 1 失败）。 */
export async function runMigrate(
  log: KernelLogger,
  env: NodeJS.ProcessEnv,
  deps: MigrateDeps = {},
): Promise<number> {
  try {
    const config = await loadConfig(env);
    log.addSecrets(secretValues(KernelConfigSchema, config));
    log.setLevel(config.log.level);
    const version = await (deps.serverVersion ?? queryServerVersion)(
      config.db.url,
      config.db.connectTimeoutMs,
    );
    if (!(version.num >= MIN_PG_VERSION_NUM)) {
      log.error(`PostgreSQL 15 or newer is required (found ${version.text})`);
      return 1;
    }
    const results = await migrateAll(config, {
      builtinExtensions: [...BUILTIN_PLUGINS],
      log,
      onPending: (pending) => {
        log.warn(
          "extensions awaiting permission approval were not migrated; run `capybara extensions review`",
          { plugins: pending.map((p) => p.plugin) },
        );
      },
    });
    for (const r of results) {
      log.info("migrations applied", { schema: r.schema, applied: r.applied });
    }
    log.info("migrate finished");
    return 0;
  } catch (e) {
    log.error("migrate failed", { err: e });
    return 1;
  }
}
