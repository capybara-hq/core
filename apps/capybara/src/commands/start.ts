import {
  createKernel,
  type KernelLogger,
  resolveConfig,
  selectConfigSource,
} from "@capybara-hq/kernel";
import type { Role } from "../args.js";

/**
 * `capybara start`：加载配置 → 创建并启动内核 → 安装 SIGTERM / SIGINT 处理（触发优雅停机后退出）。
 * `--role` 以环境变量覆盖 `CAPYBARA_ROLES` 的形式注入，热更新重新合并配置时也保持生效。
 * 返回 undefined 表示已启动并常驻；返回数字为应立即使用的退出码。
 */
export async function runStart(
  opts: { roles?: Role[] },
  log: KernelLogger,
  baseEnv: NodeJS.ProcessEnv,
  exit: (code: number) => void = (code) => process.exit(code),
): Promise<number | undefined> {
  const env: NodeJS.ProcessEnv = { ...baseEnv };
  if (opts.roles) env.CAPYBARA_ROLES = JSON.stringify(opts.roles);
  let kernel: Awaited<ReturnType<typeof createKernel>>;
  try {
    const source = selectConfigSource(env);
    const config = resolveConfig(await source.load(), env);
    kernel = await createKernel(config, { source, logger: log, env });
  } catch (e) {
    log.error("cannot load configuration", { err: e });
    return 1;
  }

  let signalled = false;
  const onSignal = (signal: NodeJS.Signals) => {
    if (signalled) {
      log.warn("second signal received; exiting immediately", { signal });
      exit(1);
      return;
    }
    signalled = true;
    log.info("signal received; shutting down", { signal });
    kernel.stop().then(
      () => exit(0),
      (err: unknown) => {
        log.error("shutdown failed", { err });
        exit(1);
      },
    );
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);

  try {
    await kernel.start();
  } catch {
    // start 失败时内核已记录原因并自行关闭资源
    return 1;
  }
  return undefined;
}
