import type { Logger } from "@capybara-hq/plugin-sdk";
import { PLUGIN_DEPLOYMENT_CONFIG_TOPIC } from "./deployment-config.js";
import type { ExtensionInstance } from "./instance.js";
import { PLUGINS_MIGRATED_TOPIC } from "./migrate-lock.js";
import type { ReplicaStatusStore } from "./sources.js";

/**
 * 插件期望状态 / 快照变了（kernel bus 主题，频道 `cap:kernel:plugins.changed`，payload `{ plugin }`）。
 * 后台、CLI 写完 PG 后发布；各副本据此 reconcile，并作废路由闸门的名字缓存。
 */
export const PLUGINS_CHANGED_TOPIC = "plugins.changed";
/** 周期兜底（kernel bus 主题 `plugins.reconcile`，payload `{}`）：维护任务 `plugins-reconcile` 发布。 */
export const PLUGINS_RECONCILE_TOPIC = "plugins.reconcile";
export { PLUGINS_MIGRATED_TOPIC };

/** 维护任务：每 `pluginHost.reconcileIntervalSeconds` 秒发布一次 `plugins.reconcile`（任务名与 scheduler id 不含 `:`）。 */
export const PLUGINS_RECONCILE_JOB = "plugins-reconcile";
export const PLUGINS_RECONCILE_SCHEDULER_ID = "plugins-reconcile-every";

/** 副本行心跳超过这么多个 reconcile 周期的副本不计入（C16；读状态的一方据此筛选）。 */
export const STALE_RECONCILE_PERIODS = 3;
/** 心跳超过这么多个周期的行直接删除（副本早已退出；读的一方本来就不计入）。 */
const PRUNE_RECONCILE_PERIODS = 10;

/** The host operations {@link ExtensionLifecycle} needs. */
export interface LifecycleHost {
  /** Converges this replica to the deployment's desired state (serialized; see `ExtensionHost.converge`). */
  converge(): Promise<void>;
  /** 用同一个包重新 setup（配置的非 hot 改动、依赖方联动）。 */
  reload(name: string): Promise<ExtensionInstance>;
  /**
   * 部署配置保存后本副本重读并校验（hot 就地替换、非 hot 重新加载、不合法保持当前值）；
   * 插件此刻没在本副本生效时返回 `not_loaded`（待配置的由随后的 reconcile 加载）。
   */
  applyDeploymentConfig(name: string): Promise<string>;
  /** 在本副本生效、声明了部署级配置的插件（周期 reconcile 据此补上丢了消息的配置改动）。 */
  configurablePlugins(): string[];
  /** 作废路由闸门的安装记录名字缓存。 */
  invalidateKnownNames(): void;
  /** 内置与配置声明的插件名。 */
  declared(): ReadonlyMap<string, unknown>;
}

export interface ExtensionLifecycleDeps {
  host: LifecycleHost;
  bus: {
    subscribe(topic: string, handler: (payload: unknown) => void): Promise<() => Promise<void>>;
  };
  status: ReplicaStatusStore;
  /** 安装记录里的全部插件名（任何期望状态；清理本副本已不认识的状态行）。 */
  installedNames(): Promise<string[]>;
  reconcileIntervalSeconds(): number;
  log: Pick<Logger, "info" | "warn" | "error">;
}

/**
 * 每副本一个：把本副本的插件加载状态收敛到 PG 期望状态（C16）。
 * 触发来源：bus `kernel.plugins.changed`（后台 / CLI 改了期望状态或快照）、`kernel.plugins.reconcile`（维护任务周期兜底，
 * 丢了消息也能收敛）、`kernel.plugins.migrated`（别的副本迁移完成），以及启动。
 * `reconcile` 在本副本内排队串行：进行中时再来的请求合并成「当前这次结束后再跑一次」。
 * 每次 reconcile 开始与结束时都刷新本副本状态行的心跳，并清理已卸载插件的行与早已退出的副本的行。
 * 进程内只有排队用的 Promise（不是跨副本状态）。
 */
export class ExtensionLifecycle {
  private running: Promise<void> | undefined;
  private queued: Promise<void> | undefined;
  private unsubs: (() => Promise<void>)[] = [];
  private stopped = false;

  constructor(private readonly d: ExtensionLifecycleDeps) {}

  /** 订阅三个主题（订阅失败只记 error：周期任务的消息同样收不到时，下次启动再来）。 */
  async start(): Promise<void> {
    const on = async (topic: string, handler: (payload: unknown) => void) => {
      try {
        this.unsubs.push(await this.d.bus.subscribe(topic, handler));
      } catch (err) {
        this.d.log.error("cannot subscribe to plugin lifecycle topic", { topic, err });
      }
    };
    await on(PLUGINS_CHANGED_TOPIC, (p) => {
      // 安装 / 卸载改变了「部署已知」的插件名：路由闸门不等 TTL
      this.d.host.invalidateKnownNames();
      this.trigger(`changed:${pluginOf(p)}`);
    });
    await on(PLUGINS_RECONCILE_TOPIC, () => this.trigger("periodic"));
    await on(PLUGINS_MIGRATED_TOPIC, (p) => this.trigger(`migrated:${pluginOf(p)}`));
    await on(PLUGIN_DEPLOYMENT_CONFIG_TOPIC, (p) => {
      this.applyConfig(pluginOf(p)).catch((err: unknown) =>
        this.d.log.error("applying a plugin deployment config change failed", {
          plugin: pluginOf(p),
          err,
        }),
      );
    });
  }

  /**
   * 部署配置保存后（C10，本副本的 HTTP 请求与 bus 消息都走这里）：生效的插件重读并校验（hot 就地替换、
   * 非 hot 重新加载）；没在本副本生效的（如待配置）跑一次 reconcile，配置合法了就加载。
   */
  async applyConfig(plugin: string): Promise<void> {
    if (this.stopped) return;
    const r = await this.d.host.applyDeploymentConfig(plugin);
    if (r === "not_loaded") await this.reconcile(`config:${plugin}`);
  }

  /** 取消订阅；之后的 reconcile 直接返回。进行中的那次由宿主关闭收尾。 */
  async stop(): Promise<void> {
    this.stopped = true;
    const unsubs = this.unsubs;
    this.unsubs = [];
    await Promise.allSettled(unsubs.map((u) => u()));
  }

  /**
   * 收敛一次（本副本内串行；进行中时合并为「结束后再跑一次」，返回那一次的 Promise）。
   * 宿主那一步失败只记 error（下一个周期再来）；之后照常刷新心跳。
   */
  reconcile(reason: string): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.queued) return this.queued;
    if (!this.running) {
      this.running = this.run(reason).finally(() => {
        this.running = undefined;
      });
      return this.running;
    }
    const after = this.running;
    this.queued = after.then(() => {
      this.queued = undefined;
      return this.reconcile(reason);
    });
    return this.queued;
  }

  /** 用同一个包重新 setup（配置的非 hot 改动、依赖方联动；与 reconcile 一样在宿主的串行队列里）。 */
  async reload(name: string): Promise<void> {
    await this.d.host.reload(name);
  }

  private trigger(reason: string): void {
    this.reconcile(reason).catch((err: unknown) =>
      this.d.log.error("plugin reconcile failed", { reason, err }),
    );
  }

  private async run(reason: string): Promise<void> {
    // 开始时也刷新心跳：converge 可能很久（排空在途调用、迁移），不能因此被读状态的一方当成退出的副本
    await this.d.status.heartbeat().catch((err: unknown) => {
      this.d.log.warn("cannot refresh plugin replica status heartbeats", { err });
    });
    try {
      await this.d.host.converge();
    } catch (err) {
      if (this.stopped) return;
      this.d.log.error("plugin reconcile failed; retrying on the next cycle", { reason, err });
    }
    if (this.stopped) return;
    if (reason === "periodic") {
      // 丢了 plugin-deployment-config 消息时：周期兜底重读生效插件的部署配置（没变时什么都不做）
      for (const name of this.d.host.configurablePlugins()) {
        if (this.stopped) return;
        try {
          await this.d.host.applyDeploymentConfig(name);
        } catch (err) {
          if (this.stopped) return;
          this.d.log.error("applying a plugin deployment config change failed", {
            plugin: name,
            err,
          });
        }
      }
    }
    try {
      await this.d.status.heartbeat();
      const keep = [...this.d.host.declared().keys(), ...(await this.d.installedNames())];
      const period = this.d.reconcileIntervalSeconds();
      await this.d.status.prune(keep, PRUNE_RECONCILE_PERIODS * period);
    } catch (err) {
      this.d.log.warn("cannot refresh plugin replica status heartbeats", { err });
    }
  }
}

const pluginOf = (p: unknown): string =>
  typeof p === "object" && p !== null && typeof (p as { plugin?: unknown }).plugin === "string"
    ? (p as { plugin: string }).plugin
    : "?";
