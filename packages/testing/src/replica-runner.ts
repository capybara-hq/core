import { createKernel, type Kernel, KernelConfigSchema } from "@capybara-hq/kernel";
import type { BootstrapManifest } from "@capybara-hq/plugin-sdk";

/** 由 dual-replica 通过 IPC 发来的启动配置（含密钥，所以不走 argv / env）。 */
interface RunnerConfig {
  dbUrl: string;
  redisUrl: string;
  masterKey: string;
  extensions: string[];
  /** The bootstrap step (see `DualReplicaOptions.bootstrap`). */
  bootstrapDir?: string;
  bootstrapManifest?: BootstrapManifest;
  resolveFrom: string;
  extensionConfig: Record<string, unknown>;
  roles: string[];
  /** 副本序号（"0" / "1"），设为 `http.replicaId`，响应头 `x-capybara-replica` 据此标明落点。 */
  replicaId: string;
  /** 调用方传入的额外配置，深合并在基础配置之上。 */
  overrides: Record<string, unknown>;
}

type Incoming = { type: "start"; config: RunnerConfig } | { type: "stop" };

let kernel: Kernel | undefined;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** 深合并：普通对象逐键递归，其余（含数组）由 `over` 整体替换。 */
function deepMerge(
  base: Record<string, unknown>,
  over: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) {
    const b = out[k];
    out[k] = isPlainObject(b) && isPlainObject(v) ? deepMerge(b, v) : v;
  }
  return out;
}

/** 启动内核并回报实际监听端口。 */
async function startKernel(c: RunnerConfig): Promise<void> {
  const base = {
    db: { url: c.dbUrl, poolMax: 3 },
    redis: { url: c.redisUrl },
    masterKey: c.masterKey,
    http: { port: 0, replicaId: c.replicaId },
    roles: c.roles,
    extensions: c.extensions,
    extensionConfig: c.extensionConfig,
    // 测试默认自动批准插件权限（生产默认关闭）；调用方可经 config 覆盖为 false 验证待批准行为
    extensionPermissions: { autoApprove: true },
    log: { level: "error" },
  };
  const config = KernelConfigSchema.parse(deepMerge(base, c.overrides));
  kernel = await createKernel(config, {
    resolveFrom: c.resolveFrom,
    ...(c.bootstrapDir !== undefined && { bootstrapDir: c.bootstrapDir }),
    ...(c.bootstrapManifest !== undefined && { bootstrapManifest: c.bootstrapManifest }),
  });
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
