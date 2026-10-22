import type { Logger } from "@capybara-hq/plugin-sdk";
import type { PluginInstance } from "./instance.js";
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

/** {@link PluginLifecycle} 需要的宿主操作。 */
export interface LifecycleHost {
  /** 本副本收敛到部署期望状态（串行；见 `PluginHost.converge`）。 */
  converge(): Promise<void>;
  /** 用同一个包重新 setup（配置的非 hot 改动、依赖方联动）。 */
  reload(name: string): Promise<PluginInstance>;
  /** 作废路由闸门的安装记录名字缓存。 */
  invalidateKnownNames(): void;
  /** 内置与配置声明的插件名。 */
  declared(): ReadonlyMap<string, unknown>;
}

export interface PluginLifecycleDeps {
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
export class PluginLifecycle {
  private running: Promise<void> | undefined;
  private queued: Promise<void> | undefined;
  private unsubs: (() => Promise<void>)[] = [];
  private stopped = false;

  constructor(private readonly d: PluginLifecycleDeps) {}

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
