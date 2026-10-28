import type { ExtensionContext } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { LockService } from "../infra/lock/lock.service.js";
import { LockedInterval } from "../infra/schedule/locked-interval.js";
import { KERNEL_BUS, KERNEL_LOGGER } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import { ExtensionHost } from "./host.js";
import { ExtensionInstalls } from "./installs.js";
import {
  PLUGIN_DEPLOYMENT_CONFIG_TOPIC,
  PLUGINS_CHANGED_TOPIC,
  PLUGINS_RECONCILE_JOB,
  PLUGINS_RECONCILE_SCHEDULER_ID,
  PLUGINS_RECONCILE_TOPIC,
  STALE_RECONCILE_PERIODS,
} from "./lifecycle-topics.js";
import { PLUGINS_MIGRATED_TOPIC } from "./migrate-lock.js";
import { ReplicaStatusStore } from "./sources.js";

export {
  PLUGINS_CHANGED_TOPIC,
  PLUGINS_MIGRATED_TOPIC,
  PLUGINS_RECONCILE_JOB,
  PLUGINS_RECONCILE_SCHEDULER_ID,
  PLUGINS_RECONCILE_TOPIC,
  STALE_RECONCILE_PERIODS,
};

/** 心跳超过这么多个周期的行直接删除（副本早已退出；读的一方本来就不计入）。 */
const PRUNE_RECONCILE_PERIODS = 10;

/**
 * 每副本一个：把本副本的插件加载状态收敛到 PG 期望状态（C16）。
 * 触发来源：bus `kernel.plugins.changed`（后台 / CLI 改了期望状态或快照）、`kernel.plugins.reconcile`（维护任务周期兜底，
 * 丢了消息也能收敛）、`kernel.plugins.migrated`（别的副本迁移完成），以及启动。
 * `reconcile` 在本副本内排队串行：进行中时再来的请求合并成「当前这次结束后再跑一次」。
 * 每次 reconcile 开始与结束时都刷新本副本状态行的心跳，并清理已卸载插件的行与早已退出的副本的行。
 * 进程内只有排队用的 Promise（不是跨副本状态）。
 */
@Injectable()
export class ExtensionLifecycle {
  private running: Promise<void> | undefined;
  private queued: Promise<void> | undefined;
  private unsubs: (() => Promise<void>)[] = [];
  /** {@link start} was called (the kernel's start sequence; never in the CLI, which loads nothing). */
  private started = false;
  private stopped = false;

  constructor(
    @Inject(ExtensionHost) private readonly host: ExtensionHost,
    @Inject(KERNEL_BUS)
    private readonly bus: Pick<ExtensionContext["bus"], "publish" | "subscribe">,
    @Inject(ReplicaStatusStore) private readonly status: ReplicaStatusStore,
    /** Every install record's name (any desired state): prunes status rows this replica no longer knows. */
    @Inject(ExtensionInstalls) private readonly installs: ExtensionInstalls,
    @Inject(KernelConfigService) readonly config: KernelConfigService,
    @Inject(LockService) readonly lockService: LockService,
    @Inject(KERNEL_LOGGER) readonly log: KernelLogger,
  ) {}

  /**
   * The periodic fallback (job `plugins-reconcile`, once per `extensionHost.reconcileIntervalSeconds`
   * across replicas): publishes `kernel.plugins.reconcile`, so every replica converges even when it
   * lost a message.
   */
  @LockedInterval(PLUGINS_RECONCILE_JOB, (c) => c.extensionHost.reconcileIntervalSeconds * 1000)
  async publishPeriodicReconcile(): Promise<void> {
    await this.bus.publish(PLUGINS_RECONCILE_TOPIC, {});
  }

  /** 订阅三个主题（订阅失败只记 error：周期任务的消息同样收不到时，下次启动再来）。 */
  async start(): Promise<void> {
    this.started = true;
    const on = async (topic: string, handler: (payload: unknown) => void) => {
      try {
        this.unsubs.push(await this.bus.subscribe(topic, handler));
      } catch (err) {
        this.log.error("cannot subscribe to plugin lifecycle topic", { topic, err });
      }
    };
    await on(PLUGINS_CHANGED_TOPIC, (p) => {
      // 安装 / 卸载改变了「部署已知」的插件名：路由闸门不等 TTL
      this.host.invalidateKnownNames();
      this.trigger(`changed:${pluginOf(p)}`);
    });
    await on(PLUGINS_RECONCILE_TOPIC, () => this.trigger("periodic"));
    await on(PLUGINS_MIGRATED_TOPIC, (p) => this.trigger(`migrated:${pluginOf(p)}`));
    await on(PLUGIN_DEPLOYMENT_CONFIG_TOPIC, (p) => {
      this.applyConfig(pluginOf(p)).catch((err: unknown) =>
        this.log.error("applying a plugin deployment config change failed", {
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
    const r = await this.host.applyDeploymentConfig(plugin);
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
    // Before start (the bootstrap step, the CLI) there is nothing loaded to converge: the host
    // loads the desired state as it is when it starts
    if (this.stopped || !this.started) return Promise.resolve();
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
    await this.host.reload(name);
  }

  private trigger(reason: string): void {
    this.reconcile(reason).catch((err: unknown) =>
      this.log.error("plugin reconcile failed", { reason, err }),
    );
  }

  private async run(reason: string): Promise<void> {
    // 开始时也刷新心跳：converge 可能很久（排空在途调用、迁移），不能因此被读状态的一方当成退出的副本
    await this.status.heartbeat().catch((err: unknown) => {
      this.log.warn("cannot refresh plugin replica status heartbeats", { err });
    });
    try {
      await this.host.converge();
    } catch (err) {
      if (this.stopped) return;
      this.log.error("plugin reconcile failed; retrying on the next cycle", { reason, err });
    }
    if (this.stopped) return;
    if (reason === "periodic") {
      // 丢了 plugin-deployment-config 消息时：周期兜底重读生效插件的部署配置（没变时什么都不做）
      for (const name of this.host.configurablePlugins()) {
        if (this.stopped) return;
        try {
          await this.host.applyDeploymentConfig(name);
        } catch (err) {
          if (this.stopped) return;
          this.log.error("applying a plugin deployment config change failed", {
            plugin: name,
            err,
          });
        }
      }
    }
    try {
      await this.status.heartbeat();
      const keep = [...this.host.declared().keys(), ...(await this.installs.installedNames())];
      const period = this.config.get().extensionHost.reconcileIntervalSeconds;
      await this.status.prune(keep, PRUNE_RECONCILE_PERIODS * period);
    } catch (err) {
      this.log.warn("cannot refresh plugin replica status heartbeats", { err });
    }
  }
}

const pluginOf = (p: unknown): string =>
  typeof p === "object" && p !== null && typeof (p as { plugin?: unknown }).plugin === "string"
    ? (p as { plugin: string }).plugin
    : "?";
