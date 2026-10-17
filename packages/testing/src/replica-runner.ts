import { createKernel, type Kernel, KernelConfigSchema } from "@capybara-hq/kernel";

/** 由 dual-replica 通过 IPC 发来的启动配置（含密钥，所以不走 argv / env）。 */
interface RunnerConfig {
  dbUrl: string;
  redisUrl: string;
  masterKey: string;
  plugins: string[];
  resolveFrom: string;
  pluginConfig: Record<string, unknown>;
  roles: string[];
}

type Incoming = { type: "start"; config: RunnerConfig } | { type: "stop" };

let kernel: Kernel | undefined;

/** 启动内核并回报实际监听端口。 */
async function startKernel(c: RunnerConfig): Promise<void> {
  const config = KernelConfigSchema.parse({
    db: { url: c.dbUrl, poolMax: 3 },
    redis: { url: c.redisUrl },
    masterKey: c.masterKey,
    http: { port: 0 },
    roles: c.roles,
    plugins: c.plugins,
    pluginConfig: c.pluginConfig,
    log: { level: "error" },
  });
  kernel = await createKernel(config, { resolveFrom: c.resolveFrom });
  await kernel.start();
  process.send?.({ type: "ready", port: kernel.port });
}

let exiting = false;

/** 停内核后退出；内核停机卡住时 10 秒后强制退出。 */
function shutdown(): void {
  if (exiting) return;
  exiting = true;
  setTimeout(() => process.exit(1), 10_000).unref();
  (kernel?.stop() ?? Promise.resolve()).finally(() => process.exit(0));
}

// 父进程（含被 SIGKILL）消失后 IPC 通道断开，副本自行退出，不留孤儿
process.on("disconnect", shutdown);

process.on("message", (msg: Incoming) => {
  if (msg.type === "start") {
    startKernel(msg.config).catch((e: unknown) => {
      // 只回报错误信息，绝不回显配置
      process.send?.({ type: "failed", error: e instanceof Error ? e.message : String(e) }, () =>
        process.exit(1),
      );
    });
  } else if (msg.type === "stop") {
    shutdown();
  }
});
