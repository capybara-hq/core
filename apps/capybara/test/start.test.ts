import { EventEmitter } from "node:events";
import { createLogger } from "@capybara-hq/kernel";
import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ stopDone: false, stopRequested: false }));

// 只替换 createKernel / 配置加载：模拟「启动进行中收到 SIGTERM」——start 在下一个检查点抛错，stop 需要一段时间才完成。
vi.mock("@capybara-hq/kernel", async (importOriginal) => {
  const real = await importOriginal<typeof import("@capybara-hq/kernel")>();
  return {
    ...real,
    selectConfigSource: () => ({ load: async () => ({}) }),
    resolveConfig: () => ({ bootstrap: { dir: "bootstrap" } }),
    createConfiguredLogger: () => real.createLogger("error", { write: () => {} }),
    createKernel: async () => {
      let release: () => void = () => {};
      const stopped = new Promise<void>((r) => {
        release = r;
      });
      return {
        async start() {
          await stopped;
          throw new Error("kernel stopped during start");
        },
        async stop() {
          state.stopRequested = true;
          release();
          await new Promise((r) => setTimeout(r, 200));
          state.stopDone = true;
        },
      };
    },
  };
});

const { runStart } = await import("../src/commands/start.js");

describe("runStart", () => {
  it("启动进行中收到 SIGTERM：等 stop 完成后以 0 退出，而不是以失败码立即退出", async () => {
    const log = createLogger("error", { write: () => {} });
    const signals = new EventEmitter();
    const exits: Array<{ code: number; stopDone: boolean }> = [];
    const exit = (code: number) => {
      exits.push({ code, stopDone: state.stopDone });
    };
    const running = runStart({}, log, {}, exit, signals);
    await new Promise((r) => setTimeout(r, 20));
    signals.emit("SIGTERM", "SIGTERM");
    const code = await running;
    expect(state.stopRequested).toBe(true);
    expect(code).toBeUndefined();
    expect(state.stopDone).toBe(true);
    expect(exits).toEqual([{ code: 0, stopDone: true }]);
  });
});
