import {
  configSourceKind,
  createConfiguredLogger,
  createKernel,
  extensionConfigSources,
  type KernelLogger,
  resolveConfig,
  selectConfigSource,
} from "@capybara-hq/kernel";
import type { Role } from "../args.js";
import { startBootstrapDir } from "./bootstrap.js";

/**
 * `capybara start`：加载配置 → 创建并启动内核 → 安装 SIGTERM / SIGINT 处理（触发优雅停机后退出）。
 * `--role` 以环境变量覆盖 `CAPYBARA_ROLES` 的形式注入，热更新重新合并配置时也保持生效。
 * The kernel runs the bootstrap step before loading extensions unless it is done, from
 * `--bootstrap-dir` or the image's `/app/bootstrap` (see {@link startBootstrapDir}); a required
 * bootstrap plugin it cannot install keeps it from listening.
 * 返回 undefined 表示已启动并常驻（或启动中收到信号、由信号路径负责退出）；返回数字为应立即使用的退出码。
 */
export async function runStart(
  opts: { roles?: Role[]; bootstrapDir?: string },
  cliLog: KernelLogger,
  baseEnv: NodeJS.ProcessEnv,
  exit: (code: number) => void = (code) => process.exit(code),
  signals: Pick<NodeJS.EventEmitter, "on"> = process,
): Promise<number | undefined> {
  const env: NodeJS.ProcessEnv = { ...baseEnv };
  if (opts.roles) env.CAPYBARA_ROLES = JSON.stringify(opts.roles);
  let kernel: Awaited<ReturnType<typeof createKernel>>;
  const bootstrapDir = startBootstrapDir(opts.bootstrapDir);
  // The CLI logger until the config is read; then the one `log.*` and `roles` configure.
  let log = cliLog;
  try {
    const source = selectConfigSource(env);
    const raw = await source.load();
    const config = resolveConfig(raw, env);
    log = createConfiguredLogger(config);
    kernel = await createKernel(config, {
      source,
      logger: log,
      env,
      ...(bootstrapDir !== undefined && { bootstrapDir }),
      // 启动配置里有的插件部署配置字段在后台只读并显示来源（D8）
      extensionConfigSources: extensionConfigSources(raw, env, configSourceKind(env)),
    });
  } catch (e) {
    log.error("cannot load configuration", { err: e });
    return 1;
  }

  let signalled = false;
  let stopping: Promise<void> | undefined;
  const onSignal = (signal: NodeJS.Signals) => {
    if (signalled) {
      log.warn("second signal received; exiting immediately", { signal });
      exit(1);
      return;
    }
    signalled = true;
    log.info("signal received; shutting down", { signal });
    stopping = kernel.stop().then(
      () => exit(0),
      (err: unknown) => {
        log.error("shutdown failed", { err });
        exit(1);
      },
    );
  };
  signals.on("SIGTERM", onSignal);
  signals.on("SIGINT", onSignal);

  try {
    await kernel.start();
  } catch {
    // 启动期间收到信号：start 因停机而中断，不算失败；等停机走完，由信号路径以 0 退出
    if (stopping) {
      await stopping;
      return undefined;
    }
    // start 失败时内核已记录原因并自行关闭资源
    return 1;
  }
  return undefined;
}
