/**
 * 模型看到的工具结果：调用进行中提供它的插件实例被撤销（停用 / 卸载 / 升级），排空时限到了仍未结束而被中止。
 * 模型可见文案，一律英文。
 */
export const PLUGIN_UNLOADED_TOOL_ERROR =
  "The plugin that provides this tool was disabled or upgraded while the call was running, so the call was aborted. Retry if the tool is still available.";

/** 调用落在已撤销（或正在撤销）的插件实例上。 */
export class PluginUnloadedError extends Error {
  constructor(readonly plugin: string) {
    super(`plugin ${plugin} was unloaded`);
    this.name = "PluginUnloadedError";
  }
}

/** {@link InflightTracker.enter} 的返回：合并后的信号与离开函数（幂等）。 */
export interface InflightEntry {
  signal: AbortSignal;
  leave(): void;
}

/**
 * 一个插件实例的在途调用计数（本进程内、只跟踪本进程发起的调用）。撤销时：
 * `close()` 停止接新的 → `drain(ms)` 等在途的结束（或到时限）→ `abort()` 中止余下的。
 */
export class InflightTracker {
  private n = 0;
  private closed = false;
  private readonly ac = new AbortController();
  private idle: (() => void)[] = [];

  constructor(private readonly plugin: string) {}

  /** 进行中的调用数。 */
  get size(): number {
    return this.n;
  }

  /** 实例被中止时 abort（reason 为 {@link PluginUnloadedError}）。 */
  get signal(): AbortSignal {
    return this.ac.signal;
  }

  /** 记一次调用开始；已关闭时抛 {@link PluginUnloadedError}。返回的 signal 在调用方信号或实例中止时 abort。 */
  enter(signal: AbortSignal): InflightEntry {
    if (this.closed) throw new PluginUnloadedError(this.plugin);
    this.n += 1;
    let left = false;
    return {
      signal: AbortSignal.any([signal, this.ac.signal]),
      leave: () => {
        if (left) return;
        left = true;
        this.n -= 1;
        if (this.n === 0) {
          const waiters = this.idle;
          this.idle = [];
          for (const w of waiters) w();
        }
      },
    };
  }

  /**
   * 跟踪执行 `fn`：与实例中止竞速——实例被中止时立即以 {@link PluginUnloadedError} 结束
   * （不理会 signal 的 fn 留在后台，结果丢弃）。
   */
  async run<T>(signal: AbortSignal, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const e = this.enter(signal);
    let onAbort: () => void = () => {};
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(new PluginUnloadedError(this.plugin));
      if (this.ac.signal.aborted) onAbort();
      else this.ac.signal.addEventListener("abort", onAbort, { once: true });
    });
    aborted.catch(() => {});
    try {
      const p = (async () => fn(e.signal))();
      p.catch(() => {});
      return await Promise.race([p, aborted]);
    } finally {
      this.ac.signal.removeEventListener("abort", onAbort);
      e.leave();
    }
  }

  /** 停止接新的调用（幂等）。 */
  close(): void {
    this.closed = true;
  }

  /** 停止接新的，等在途调用全部结束，最多 `ms` 毫秒。 */
  async drain(ms: number): Promise<"drained" | "timeout"> {
    this.close();
    if (this.n === 0) return "drained";
    let timer: NodeJS.Timeout | undefined;
    let resolveIdle: () => void = () => {};
    const idle = new Promise<"drained">((resolve) => {
      resolveIdle = () => resolve("drained");
      this.idle.push(resolveIdle);
    });
    try {
      return await Promise.race([
        idle,
        new Promise<"timeout">((resolve) => {
          timer = setTimeout(() => resolve("timeout"), Math.max(0, ms));
        }),
      ]);
    } finally {
      clearTimeout(timer);
      this.idle = this.idle.filter((w) => w !== resolveIdle);
    }
  }

  /** 中止余下的在途调用（幂等）；此后 `enter` 抛错。 */
  abort(): void {
    this.close();
    if (!this.ac.signal.aborted) this.ac.abort(new PluginUnloadedError(this.plugin));
  }
}
