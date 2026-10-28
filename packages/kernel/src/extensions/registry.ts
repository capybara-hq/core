import {
  type ExtensionManifest,
  type ExtensionPointRef,
  parseExtensionPoint,
} from "@capybara-hq/plugin-sdk";
import { Injectable, Module } from "@nestjs/common";
import { type InflightTracker, type TrackOptions, trackCalls } from "./inflight.js";
import type { ExtensionInstance } from "./instance.js";
import type { ExtensionSource } from "./sources.js";

/** One item of {@link ExtensionRegistry.list}. */
export interface ExtensionPointEntry {
  plugin: string;
  capability: ExtensionPointRef;
  impl: unknown;
  /** 插件清单的 version。 */
  version: string;
  /** 部署配置摘要，见 `deploymentConfigHash`。 */
  configHash: string;
  /** 提供方实例的在途计数（connector / sandbox / model-provider 的 `impl` 已经包成计入它的代理）。 */
  inflight: InflightTracker;
}

/** 内核消费的提供方能力：调用计入提供方实例的在途计数（撤销 / 升级时排空，C17）。 */
const TRACKED_EXTENSION_POINTS: Record<string, TrackOptions> = {
  connector: { sessions: ["open"] },
  sandbox: {},
  "model-provider": {},
};

/**
 * 本进程生效的插件实例（按插件名，一名一个）。One provider per process (ruling R6): the extension host
 * writes it, other domains read extension points and manifests from it, never from the host.
 * 顺序 = 首次激活的顺序（宿主按依赖拓扑序加载；
 * 替换同名实例保持原位置）。只是本进程的视图：跨副本的期望状态在 PG（安装记录），由各副本自己 reconcile。
 */
@Injectable()
export class ExtensionRegistry {
  private readonly instances = new Map<string, ExtensionInstance>();
  private readonly listeners = new Set<(name: string) => void>();
  private rev = 0;
  /** The config-declared extension names of this process (the startup config `extensions` list). */
  private declaredNames = new Map<string, ExtensionSource>();

  /**
   * Records the config-declared extensions (the host at load; before it, the start sequence for
   * the bootstrap step; the CLI from its inspection). Install records cannot take these names and
   * the admin operations refuse them (C15).
   */
  declare(names: Iterable<string>): void {
    this.declaredNames = new Map([...names].map((n) => [n, "config" as const]));
  }

  /** The config-declared extension names → source (see {@link declare}). */
  declared(): Map<string, ExtensionSource> {
    return new Map(this.declaredNames);
  }

  /** 原子替换：登记新实例，返回被替换的旧实例（由调用方 dispose）。 */
  activate(inst: ExtensionInstance): ExtensionInstance | undefined {
    const old = this.instances.get(inst.name);
    this.instances.set(inst.name, inst);
    this.changed(inst.name);
    return old;
  }

  /** 摘下：返回被摘下的实例（由调用方 dispose）；不在时返回 undefined。 */
  deactivate(name: string): ExtensionInstance | undefined {
    const old = this.instances.get(name);
    if (!old) return undefined;
    this.instances.delete(name);
    this.changed(name);
    return old;
  }

  current(name: string): ExtensionInstance | undefined {
    return this.instances.get(name);
  }

  /**
   * An active extension's deployment config (validated against its manifest's schema, secrets
   * included), passed back as `config` when the kernel calls its extension points (such as the
   * login config of `identity-source@1`); undefined when it is not active. Never echo it in a
   * response or a log.
   */
  deploymentConfig(name: string): unknown {
    return this.instances.get(name)?.config;
  }

  all(): ExtensionInstance[] {
    return [...this.instances.values()];
  }

  /**
   * 列出提供某能力（任意主版本）的所有插件及实现；`extensionPointName` 为能力名（不含主版本），
   * 同一插件提供多个主版本时各占一项，由调用方按主版本选择。
   * 每项带插件版本与部署配置摘要，供调用方做「插件升级 / 改配置即失效」的缓存键。
   * 实时取自注册表：调用方不要缓存实现对象（插件撤销 / 升级后旧实现不再有效）。
   */
  list(extensionPointName: string): ExtensionPointEntry[] {
    const out: ExtensionPointEntry[] = [];
    const tracked = TRACKED_EXTENSION_POINTS[extensionPointName];
    for (const i of this.instances.values()) {
      for (const [cap, impl] of i.provided) {
        if (parseExtensionPoint(cap).name === extensionPointName) {
          out.push({
            plugin: i.name,
            capability: cap,
            // 内核消费的提供方调用计入实例在途计数：停用 / 升级时先排空、到时限中止（C17）
            impl:
              tracked && typeof impl === "object" && impl !== null
                ? trackCalls(impl, i.inflight, tracked)
                : impl,
            version: i.version,
            configHash: i.configHash,
            inflight: i.inflight,
          });
        }
      }
    }
    return out;
  }

  /** 已加载插件的清单（按加载顺序，即依赖拓扑序）。 */
  manifests(): ExtensionManifest[] {
    return this.all().map((i) => i.manifest);
  }

  /** 每次激活 / 摘下加一（给按版本缓存的派生视图用，如插件路由表）。 */
  revision(): number {
    return this.rev;
  }

  /**
   * 订阅变化（激活 / 替换 / 摘下，参数为插件名）。只通知本进程的消费方（渠道 supervisor、界面等），不跨副本。
   * 监听函数同步调用，抛错被吞掉（不影响注册表与其他监听方）。返回取消订阅函数。
   */
  onChange(listener: (name: string) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private changed(name: string): void {
    this.rev += 1;
    for (const l of [...this.listeners]) {
      try {
        l(name);
      } catch {
        // 监听方自己记日志；这里不让它影响注册表
      }
    }
  }
}

/** The one {@link ExtensionRegistry} (R6): every domain that reads extension points imports this. */
@Module({ providers: [ExtensionRegistry], exports: [ExtensionRegistry] })
export class ExtensionRegistryModule {}
