import { SDK_VERSION } from "@capybara-hq/plugin-sdk";
import { Redis } from "ioredis";
import type { KernelConfig } from "../config/schema.js";
import { createBus } from "../ctx/bus.js";
import { type KernelDb, kernelDb } from "../db/kernel-schema.js";
import { createDb } from "../db/pool.js";
import type { KernelLogger } from "../log.js";
import { PluginAdminOps } from "./admin-ops.js";
import { PluginAdmin } from "./admin-view.js";
import { PluginApprovals } from "./approvals.js";
import { PluginBlobs } from "./blobs.js";
import { type DeclaredPluginInfo, type InspectedPlugin, PluginHost } from "./host.js";
import { PluginInstalls } from "./installs.js";
import { PLUGINS_CHANGED_TOPIC } from "./lifecycle.js";
import { permissionSetOfPackage, readPluginPackage } from "./package.js";
import type { PermissionSet } from "./permission-set.js";

/** CLI 发布 bus 消息时连 Redis 的时限（连不上只告警）。 */
const CLI_REDIS_CONNECT_TIMEOUT_MS = 3_000;

/** {@link openPluginCli} 的结果：CLI 的 `capybara plugins *` 共用。 */
export interface PluginCli {
  config: KernelConfig;
  db: KernelDb;
  /** 内置与配置声明的插件（导入、按依赖排序，不 setup）。 */
  inspected: InspectedPlugin[];
  installs: PluginInstalls;
  admin: PluginAdmin;
  ops: PluginAdminOps;
  approvals: PluginApprovals;
  /** CLI 本次刚导入的包字节（降级判断等读包时优先用它：包可能存在 CLI 读不到的对象存储里）。 */
  remember(sha256: string, bytes: Uint8Array): void;
  /** 安装记录包的权限集合（与后台审阅相同）；包在对象存储里时 CLI 读不到，抛错。 */
  packageSet(sha256: string): Promise<PermissionSet>;
  /** 写完 PG 后经 Redis 发布 `kernel.plugins.changed`（C18）；失败只告警，返回是否发布成功。 */
  publishChanged(plugin: string): Promise<boolean>;
  close(): Promise<void>;
}

/**
 * CLI 的插件管理上下文（C18，F-Q）：只连 PG（与发布消息时的 Redis），不拉起插件宿主、不加载 object-store 插件。
 * CLI 导入的包一律存 PG（`blob_store = 'pg'`），各副本按 `blob_store` 读取。安装 / 启用 / 停用 / 卸载与后台
 * 共用 {@link PluginAdminOps}（actor 为 null，审计无发起人），写完 PG 后发布 `kernel.plugins.changed`，
 * 运行中的副本据此 reconcile；发布失败只告警（周期 reconcile 兜底）。
 */
export async function openPluginCli(
  config: KernelConfig,
  log: KernelLogger,
  opts: { builtin: string[]; resolveFrom?: string },
): Promise<PluginCli> {
  const inspected = await PluginHost.inspect(config.plugins, {
    builtin: opts.builtin,
    ...(opts.resolveFrom !== undefined && { resolveFrom: opts.resolveFrom }),
  });
  const raw = createDb(config.db.url, 2, (err) => log.error("pg idle client error", { err }), {
    connectTimeoutMs: config.db.connectTimeoutMs,
  });
  const db = kernelDb(raw);
  const local = new Map<string, Uint8Array>();
  const stored = new PluginBlobs({ db, maxBytes: () => config.packages.maxBytes });
  const blobs = {
    get: async (sha256: string) => local.get(sha256) ?? stored.get(sha256),
  };
  const declared = new Map(
    inspected.map((p) => [p.manifest.name, p.source] as [string, "builtin" | "config"]),
  );
  const declaredInfo: DeclaredPluginInfo[] = inspected.map((p) => {
    const schema = p.manifest.config?.deployment;
    return {
      name: p.manifest.name,
      source: p.source,
      version: p.manifest.version,
      permissions: p.permissions,
      configurable: schema !== undefined,
      configValid: schema
        ? schema.safeParse(config.pluginConfig[p.manifest.name] ?? {}).success
        : true,
    };
  });
  let redis: Redis | undefined;
  const publisher = {
    async publish(topic: string, payload: unknown): Promise<void> {
      if (!redis) {
        redis = new Redis(config.redis.url, {
          lazyConnect: true,
          enableOfflineQueue: false,
          maxRetriesPerRequest: 0,
          connectTimeout: CLI_REDIS_CONNECT_TIMEOUT_MS,
          retryStrategy: () => null,
        });
        redis.on("error", () => {});
      }
      if (redis.status !== "ready") await redis.connect();
      // 与内核 bus 同一个频道命名（cap:kernel:<topic>）；CLI 只发布，不订阅
      const bus = createBus(
        redis,
        {
          subscribe: () => Promise.reject(new Error("the CLI does not subscribe")),
        },
        "kernel",
        log,
      );
      await bus.publish(topic, payload);
    },
  };
  const installs = new PluginInstalls({
    db,
    blobs: stored,
    config: () => config,
    declared: () => declared,
  });
  const admin = new PluginAdmin({
    db,
    blobs,
    installs,
    config: () => config,
    host: { declaredPlugins: () => declaredInfo },
    bus: publisher,
    log,
  });
  const ops = new PluginAdminOps({
    db,
    view: (name) => admin.get(name),
    declared: () => declared,
    blobs,
    config: () => config,
    bus: publisher,
    log,
  });
  return {
    config,
    db,
    inspected,
    installs,
    admin,
    ops,
    approvals: new PluginApprovals(db),
    remember: (sha256, bytes) => {
      local.set(sha256, bytes);
    },
    async packageSet(sha256) {
      const pkg = await readPluginPackage(await blobs.get(sha256), {
        maxBytes: config.packages.maxBytes,
        hostSdkVersion: SDK_VERSION,
      });
      return permissionSetOfPackage(pkg);
    },
    async publishChanged(plugin) {
      try {
        await publisher.publish(PLUGINS_CHANGED_TOPIC, { plugin });
        return true;
      } catch (err) {
        log.warn(
          "cannot publish plugins.changed; running replicas pick the change up on their next periodic reconcile",
          { plugin, err },
        );
        return false;
      }
    },
    async close() {
      redis?.disconnect();
      await raw.destroy().catch(() => {});
    },
  };
}
