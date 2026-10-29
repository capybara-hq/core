import { EventEmitter } from "node:events";
import { createLogger } from "@capybara-hq/kernel";
import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ stopDone: false, stopRequested: false }));

// Only startKernelApp and the config loading are replaced: a SIGTERM during the start. The fake
// installs the signal handlers the way startKernelApp does; the start fails at its next
// checkpoint once the stop began, and the stop takes a while to finish.
vi.mock("@capybara-hq/kernel", async (importOriginal) => {
  const real = await importOriginal<typeof import("@capybara-hq/kernel")>();
  return {
    ...real,
    selectConfigSource: () => ({ load: async () => ({}) }),
    resolveConfig: () => ({ bootstrap: { dir: "bootstrap" } }),
    createConfiguredLogger: () => real.createLogger("error", { write: () => {} }),
    startKernelApp: async (
      _config: unknown,
      _options: unknown,
      signalOptions: import("@capybara-hq/kernel").ShutdownSignalOptions,
    ) => {
      let release: () => void = () => {};
      const stopped = new Promise<void>((r) => {
        release = r;
      });
      const signals = real.handleShutdownSignals(
        async () => {
          state.stopRequested = true;
          release();
          await new Promise((r) => setTimeout(r, 200));
          state.stopDone = true;
        },
        real.createLogger("error", { write: () => {} }),
        signalOptions,
      );
      await stopped;
      await signals.exiting();
      throw new Error("kernel stopped during start");
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
