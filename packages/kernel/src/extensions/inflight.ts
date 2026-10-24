/**
 * 模型看到的工具结果：调用进行中提供它的插件实例被撤销（停用 / 卸载 / 升级），排空时限到了仍未结束而被中止。
 * 模型可见文案，一律英文。
 */
export const PLUGIN_UNLOADED_TOOL_ERROR =
  "The plugin that provides this tool was disabled or upgraded while the call was running, so the call was aborted. Retry if the tool is still available.";

/** 调用落在已撤销（或正在撤销）的插件实例上。 */
export class ExtensionUnloadedError extends Error {
  constructor(readonly plugin: string) {
    super(`plugin ${plugin} was unloaded`);
    this.name = "ExtensionUnloadedError";
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

  /** Aborted when the instance is aborted (reason is an {@link ExtensionUnloadedError}). */
  get signal(): AbortSignal {
    return this.ac.signal;
  }

  /** Records the start of a call; throws {@link ExtensionUnloadedError} when closed. The returned signal aborts when the caller's signal or the instance aborts. */
  enter(signal: AbortSignal): InflightEntry {
    if (this.closed) throw new ExtensionUnloadedError(this.plugin);
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
   * Tracks running `fn`, racing the instance abort: when the instance is aborted it ends right away
   * with {@link ExtensionUnloadedError} (an `fn` that ignores the signal stays in the background, its
   * result dropped).
   */
  async run<T>(signal: AbortSignal, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const e = this.enter(signal);
    let onAbort: () => void = () => {};
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(new ExtensionUnloadedError(this.plugin));
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
    if (!this.ac.signal.aborted) this.ac.abort(new ExtensionUnloadedError(this.plugin));
  }

  /** {@link trackCalls} 的包装缓存（同一实现对象 → 同一个代理），随实例回收。 */
  readonly tracked = new WeakMap<object, unknown>();
}

/** {@link trackCalls} 的选项。 */
export interface TrackOptions {
  /**
   * 返回「会话」的方法名（如 connector 的 `open`）：resolve 出的对象在 `close()` 之前一直计入在途，
   * 会话上的其余方法与实例中止竞速。
   */
  sessions?: readonly string[];
}

const isPromiseLike = (v: unknown): v is PromiseLike<unknown> =>
  typeof (v as { then?: unknown } | null)?.then === "function";
const isAsyncIterable = (v: unknown): v is AsyncIterable<unknown> =>
  typeof (v as { [Symbol.asyncIterator]?: unknown } | null)?.[Symbol.asyncIterator] === "function";
const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && Object.getPrototypeOf(v) === Object.prototype;

/**
 * Wraps a provider's extension point implementation (connector / sandbox / model-provider, resolved
 * live by the kernel each time) in a proxy counted in the instance's in-flight tracker:
 * - each method call `enter`s, and leaves when the Promise settles, the AsyncIterable finishes (or
 *   return / throw), or a session `close()`s;
 * - an `AbortSignal` in the arguments (or the `signal` field of a plain object argument) becomes
 *   "caller signal ∪ instance abort", so the provider sees the abort when the instance aborts;
 * - it races the instance abort: a call still running when the drain limit is reached ends with
 *   {@link ExtensionUnloadedError};
 * - when the instance is already being revoked (tracker closed) a new call throws
 *   {@link ExtensionUnloadedError} synchronously.
 * Non-function properties pass through. The same (tracker, impl) returns the same proxy.
 */
export function trackCalls<T extends object>(
  impl: T,
  tracker: InflightTracker,
  opts: TrackOptions = {},
): T {
  const hit = tracker.tracked.get(impl);
  if (hit) return hit as T;
  const sessions = new Set(opts.sessions ?? []);
  const proxy = wrapMethods(impl, tracker, (prop, entry, result) => {
    if (sessions.has(prop) && isPromiseLike(result)) {
      return raceAbort(tracker, result).then(
        (v) => {
          if (typeof v === "object" && v !== null) return wrapSession(v, tracker, entry);
          entry.leave();
          return v;
        },
        (e: unknown) => {
          entry.leave();
          throw e;
        },
      );
    }
    return settle(tracker, entry, result);
  });
  tracker.tracked.set(impl, proxy);
  return proxy;
}

/** 方法代理：每次调用 enter → 替换信号 → 调原方法 → 交给 `after` 决定何时离开。 */
function wrapMethods<T extends object>(
  impl: T,
  tracker: InflightTracker,
  after: (prop: string, entry: InflightEntry, result: unknown) => unknown,
): T {
  const fns = new Map<PropertyKey, unknown>();
  return new Proxy(impl, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver);
      if (typeof v !== "function") return v;
      let w = fns.get(prop);
      if (!w) {
        w = (...args: unknown[]) => {
          const entry = tracker.enter(NEVER);
          const call = args.map((a) => {
            if (a instanceof AbortSignal) return AbortSignal.any([a, tracker.signal]);
            if (isPlainObject(a) && a.signal instanceof AbortSignal) {
              return { ...a, signal: AbortSignal.any([a.signal, tracker.signal]) };
            }
            return a;
          });
          let r: unknown;
          try {
            r = (v as (...a: unknown[]) => unknown).apply(target, call);
          } catch (e) {
            entry.leave();
            throw e;
          }
          return after(String(prop), entry, r);
        };
        fns.set(prop, w);
      }
      return w;
    },
  });
}

/** 永不中止的信号（{@link InflightTracker.enter} 需要一个调用方信号；这里的中止由参数里的信号负责）。 */
const NEVER = new AbortController().signal;

/** 普通结果：Promise settle 时离开（与中止竞速）；AsyncIterable 迭代结束时离开；其余立即离开。 */
function settle(tracker: InflightTracker, entry: InflightEntry, r: unknown): unknown {
  if (isPromiseLike(r)) {
    return raceAbort(tracker, r).finally(() => entry.leave());
  }
  if (isAsyncIterable(r)) return wrapIterable(r, tracker, entry);
  entry.leave();
  return r;
}

/** Races the instance abort: rejects with ExtensionUnloadedError on abort (the original Promise stays in the background, its result is dropped). */
function raceAbort<V>(tracker: InflightTracker, p: PromiseLike<V>): Promise<V> {
  const own = Promise.resolve(p);
  own.catch(() => {});
  const signal = tracker.signal;
  if (signal.aborted) return Promise.reject(signal.reason as Error);
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason as Error);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  aborted.catch(() => {});
  return Promise.race([own, aborted]).finally(() => signal.removeEventListener("abort", onAbort));
}

/** 流：每次 next 与中止竞速；done / return / throw / 出错时离开。 */
function wrapIterable(
  src: AsyncIterable<unknown>,
  tracker: InflightTracker,
  entry: InflightEntry,
): AsyncIterable<unknown> {
  return {
    [Symbol.asyncIterator]() {
      const it = src[Symbol.asyncIterator]();
      return {
        async next() {
          try {
            const r = await raceAbort(tracker, it.next());
            if (r.done) entry.leave();
            return r;
          } catch (e) {
            entry.leave();
            throw e;
          }
        },
        async return(value?: unknown) {
          entry.leave();
          return it.return ? it.return(value) : { done: true as const, value };
        },
        async throw(err?: unknown) {
          entry.leave();
          if (it.throw) return it.throw(err);
          throw err;
        },
      };
    },
  };
}

/** 会话：`close()` 时离开（幂等）；其余方法与实例中止竞速（整个会话已计一次在途）。 */
function wrapSession<S extends object>(
  session: S,
  tracker: InflightTracker,
  entry: InflightEntry,
): S {
  return new Proxy(session, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver);
      if (typeof v !== "function") return v;
      if (prop === "close") {
        return async (...args: unknown[]) => {
          try {
            return await (v as (...a: unknown[]) => unknown).apply(target, args);
          } finally {
            entry.leave();
          }
        };
      }
      return (...args: unknown[]) => {
        const r = (v as (...a: unknown[]) => unknown).apply(target, args);
        return isPromiseLike(r) ? raceAbort(tracker, r) : r;
      };
    },
  });
}
