import { describe, expect, it } from "vitest";
import {
  ExtensionUnloadedError,
  InflightTracker,
  trackCalls,
} from "../../src/extensions/inflight.js";

/**
 * Calls to provider extension points (connector / sandbox / model-provider) enter the provider
 * instance's in-flight tracker (C17, T12 -> T14 handover): on revocation / upgrade they drain first
 * and are aborted at the limit (ending with ExtensionUnloadedError, signal aborted).
 */

const later = <T>(ms: number, v: T) => new Promise<T>((r) => setTimeout(() => r(v), ms));

describe("trackCalls", () => {
  it("Promise 方法：调用期间计入在途，排空等它结束", async () => {
    const t = new InflightTracker("p");
    const impl = {
      kind: "x",
      async slow(n: number) {
        return later(150, n * 2);
      },
    };
    const w = trackCalls(impl, t);
    expect(w.kind).toBe("x");
    const p = w.slow(21);
    expect(t.size).toBe(1);
    const started = Date.now();
    expect(await t.drain(5_000)).toBe("drained");
    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
    expect(await p).toBe(42);
    expect(t.size).toBe(0);
  });

  it("abort: in-progress calls end with ExtensionUnloadedError; the passed AbortSignal is aborted too", async () => {
    const t = new InflightTracker("p");
    let seen: AbortSignal | undefined;
    const impl = {
      exec(_h: string, signal: AbortSignal) {
        seen = signal;
        return new Promise<never>(() => {});
      },
      stream(_req: unknown, opts: { signal: AbortSignal }) {
        seen = opts.signal;
        return new Promise<never>(() => {});
      },
    };
    const w = trackCalls(impl, t);
    const caller = new AbortController();
    const p = w.exec("h", caller.signal);
    const q = w.stream({}, { signal: caller.signal });
    expect(await t.drain(50)).toBe("timeout");
    t.abort();
    await expect(p).rejects.toBeInstanceOf(ExtensionUnloadedError);
    await expect(q).rejects.toBeInstanceOf(ExtensionUnloadedError);
    expect(seen?.aborted).toBe(true);
    expect(caller.signal.aborted).toBe(false);
    expect(t.size).toBe(0);
    // 已撤销：新调用直接拒绝
    expect(() => w.exec("h", caller.signal)).toThrow(ExtensionUnloadedError);
  });

  it("AsyncIterable（模型流）：迭代完才离开在途；中途 return 也离开", async () => {
    const t = new InflightTracker("p");
    const impl = {
      stream(): AsyncIterable<number> {
        return (async function* () {
          yield 1;
          await later(100, 0);
          yield 2;
        })();
      },
    };
    const w = trackCalls(impl, t);
    const out: number[] = [];
    const drained = (async () => {
      for await (const x of w.stream()) out.push(x);
    })();
    await later(10, 0);
    expect(t.size).toBe(1);
    expect(await t.drain(5_000)).toBe("drained");
    await drained;
    expect(out).toEqual([1, 2]);

    const t2 = new InflightTracker("q");
    const w2 = trackCalls(impl, t2);
    for await (const _ of w2.stream()) break;
    expect(t2.size).toBe(0);
  });

  it("会话（connector open）：会话打开期间一直计入，close 后才离开", async () => {
    const t = new InflightTracker("c");
    const impl = {
      async open() {
        return {
          async callTool(name: string) {
            return later(50, `called ${name}`);
          },
          async close() {},
        };
      },
    };
    const w = trackCalls(impl, t, { sessions: ["open"] });
    const s = await w.open();
    expect(t.size).toBe(1);
    expect(await s.callTool("a")).toBe("called a");
    expect(t.size).toBe(1);
    await s.close();
    expect(t.size).toBe(0);
    await s.close();
    expect(t.size).toBe(0);
  });

  it("同一实现、同一在途计数取到同一个包装（身份稳定）", () => {
    const t = new InflightTracker("p");
    const impl = { async f() {} };
    expect(trackCalls(impl, t)).toBe(trackCalls(impl, t));
    expect(trackCalls(impl, new InflightTracker("p"))).not.toBe(trackCalls(impl, t));
  });
});
