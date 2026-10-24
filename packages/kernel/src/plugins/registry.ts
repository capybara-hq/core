import type { PluginInstance } from "./instance.js";

/**
 * 本进程生效的插件实例（按插件名，一名一个）。顺序 = 首次激活的顺序（宿主按依赖拓扑序加载；
 * 替换同名实例保持原位置）。只是本进程的视图：跨副本的期望状态在 PG（安装记录），由各副本自己 reconcile。
 */
export class PluginRegistry {
  private readonly instances = new Map<string, PluginInstance>();
  private readonly listeners = new Set<(name: string) => void>();
  private rev = 0;

  /** 原子替换：登记新实例，返回被替换的旧实例（由调用方 dispose）。 */
  activate(inst: PluginInstance): PluginInstance | undefined {
    const old = this.instances.get(inst.name);
    this.instances.set(inst.name, inst);
    this.changed(inst.name);
    return old;
  }

  /** 摘下：返回被摘下的实例（由调用方 dispose）；不在时返回 undefined。 */
  deactivate(name: string): PluginInstance | undefined {
    const old = this.instances.get(name);
    if (!old) return undefined;
    this.instances.delete(name);
    this.changed(name);
    return old;
  }

  current(name: string): PluginInstance | undefined {
    return this.instances.get(name);
  }

  all(): PluginInstance[] {
    return [...this.instances.values()];
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
