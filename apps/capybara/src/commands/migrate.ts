import {
  KernelConfigSchema,
  type KernelLogger,
  loadConfig,
  migrateAll,
  secretValues,
} from "@capybara-hq/kernel";
import { BUILTIN_PLUGINS } from "../builtin-plugins.js";

/** `capybara migrate`：跑内核与所有已配置插件的迁移，返回退出码（0 成功 / 1 失败）。 */
export async function runMigrate(log: KernelLogger, env: NodeJS.ProcessEnv): Promise<number> {
  try {
    const config = await loadConfig(env);
    log.addSecrets(secretValues(KernelConfigSchema, config));
    log.setLevel(config.log.level);
    const results = await migrateAll(config, {
      builtinPlugins: [...BUILTIN_PLUGINS],
      log,
      onPending: (pending) => {
        log.warn(
          "plugins awaiting permission approval were not migrated; run `capybara plugins review`",
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
