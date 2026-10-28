import {
  AccountsService,
  ApiError,
  createDb,
  KERNEL_MIGRATIONS_DIR,
  KERNEL_SCHEMA,
  KernelConfigSchema,
  type KernelLogger,
  loadConfig,
  migrate,
  secretValues,
  standaloneDatabase,
} from "@capybara-hq/kernel";

/** admin grant / revoke 的输出流（测试可替换）。 */
export interface AdminGrantIo {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
}

/**
 * `capybara admin grant|revoke <login>`：授予或撤销本地账号的企业管理员。跑内核迁移（幂等）后，
 * 在企业管理员锁的事务里改 `is_enterprise_admin` 并写审计 `account.updated`（无发起账号，`via: "cli"`）；
 * 撤销最后一个活跃企业管理员 → `account.last_enterprise_admin`。只连 PG，不连 Redis
 * （鉴权每次请求实时读账号，各副本无需通知）。
 * 退出码：0 成功（含已是目标状态）/ 1 失败（账号不存在、最后一个企业管理员等；用法错误的 2 由 parseCli 负责）。
 */
export async function runAdminGrant(
  opts: { login: string; grant: boolean },
  log: KernelLogger,
  env: NodeJS.ProcessEnv,
  io: AdminGrantIo = { stdout: process.stdout, stderr: process.stderr },
): Promise<number> {
  const verb = opts.grant ? "grant" : "revoke";
  let raw: ReturnType<typeof createDb> | undefined;
  try {
    const config = await loadConfig(env);
    log.addSecrets(secretValues(KernelConfigSchema, config));
    log.setLevel(config.log.level);
    const connectTimeoutMs = config.db.connectTimeoutMs;
    await migrate(
      config.db.url,
      { schema: KERNEL_SCHEMA, dir: KERNEL_MIGRATIONS_DIR },
      { connectTimeoutMs },
    );
    raw = createDb(config.db.url, 2, (err) => log.error("pg idle client error", { err }), {
      connectTimeoutMs,
    });
    // Until Task 5.2 runs the CLI on a Nest application context (R10)
    const { db, txHost, xactLock } = standaloneDatabase(raw, log);
    const { account, changed } = await new AccountsService(
      db,
      txHost,
      xactLock,
    ).setEnterpriseAdminByLogin(opts.login, opts.grant);
    const state = opts.grant ? "is now an enterprise admin" : "is no longer an enterprise admin";
    const already = opts.grant ? "is already an enterprise admin" : "is not an enterprise admin";
    io.stdout.write(`${opts.login} ${changed ? state : already}\n`);
    if (changed) {
      log.info(`enterprise admin ${opts.grant ? "granted" : "revoked"}`, {
        accountId: account.id,
        login: opts.login,
      });
    }
    return 0;
  } catch (e) {
    const msg =
      e instanceof ApiError
        ? `${e.code}: ${e.message}`
        : e instanceof Error
          ? e.message
          : String(e);
    io.stderr.write(`capybara: admin ${verb} failed: ${msg}\n`);
    return 1;
  } finally {
    await raw?.destroy().catch(() => {});
  }
}
