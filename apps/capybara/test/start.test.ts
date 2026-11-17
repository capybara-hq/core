import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { createLogger } from "@capybara-hq/kernel";
import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  stopDone: false,
  stopRequested: false,
  /** "fail": the fake start rejects at once, without any signal and without calling `exit`. */
  mode: "signal" as "signal" | "fail" | "capture",
  captured: [] as unknown[][],
  ready: () => {},
}));

// Only startKernelApp and the config loading are replaced: a SIGTERM during the start. The fake
// installs the signal handlers the way startKernelApp does; the start fails at its next
// checkpoint once the stop began, and the stop takes a while to finish.
vi.mock("@capybara-hq/kernel", async (importOriginal) => {
  const real = await importOriginal<typeof import("@capybara-hq/kernel")>();
  return {
    ...real,
    selectConfigSource: () => ({ load: async () => ({}) }),
    resolveConfig: real.resolveConfig,
    createConfiguredLogger: () => real.createLogger("error", { write: () => {} }),
    startKernelApp: async (
      _config: unknown,
      _options: unknown,
      signalOptions: import("@capybara-hq/kernel").ShutdownSignalOptions,
    ) => {
      if (state.mode === "capture") {
        state.captured.push([_config, _options]);
        return;
      }
      if (state.mode === "fail") throw new Error("kernel start failed");
      let release: () => void = () => {};
      const stopped = new Promise<void>((r) => {
        release = r;
      });
      const signals = real.handleShutdownSignals(
        async () => {
          state.stopRequested = true;
          release();
          await Promise.resolve();
          state.stopDone = true;
        },
        real.createLogger("error", { write: () => {} }),
        signalOptions,
      );
      state.ready();
      await stopped;
      await signals.exiting();
      throw new Error("kernel stopped during start");
    },
  };
});

const { runStart } = await import("../src/commands/start.js");

describe("runStart", () => {
  it("waits for shutdown before exiting after SIGTERM during startup", async () => {
    const log = createLogger("error", { write: () => {} });
    const signals = new EventEmitter();
    const exits: Array<{ code: number; stopDone: boolean }> = [];
    const exit = (code: number) => {
      exits.push({ code, stopDone: state.stopDone });
    };
    const ready = new Promise<void>((resolve) => {
      state.ready = resolve;
    });
    const running = runStart(
      {},
      log,
      {
        CAPYBARA_DB__URL: "postgres://test:test@localhost/test",
        CAPYBARA_REDIS__URL: "redis://localhost:6379",
        CAPYBARA_MASTER_KEY: Buffer.alloc(32).toString("base64"),
      },
      exit,
      signals,
    );
    await ready;
    signals.emit("SIGTERM", "SIGTERM");
    const code = await running;
    expect(state.stopRequested).toBe(true);
    expect(code).toBeUndefined();
    expect(state.stopDone).toBe(true);
    expect(exits).toEqual([{ code: 0, stopDone: true }]);
  });

  it("a start that fails without a signal returns 1 and never calls exit", async () => {
    state.mode = "fail";
    try {
      const log = createLogger("error", { write: () => {} });
      const exits: number[] = [];
      const code = await runStart({}, log, {}, (c) => void exits.push(c), new EventEmitter());
      expect(code).toBe(1);
      expect(exits).toEqual([]);
    } finally {
      state.mode = "signal";
    }
  });
});

describe("activation forwarding", () => {
  it("forwards main through resolved env-file and role overrides without config activation fields", async () => {
    const { main } = await import("../src/cli.js");
    const dir = mkdtempSync(join(tmpdir(), "activation-cli-"));
    const hash = "b".repeat(64);
    writeFileSync(
      join(dir, "startup.env"),
      'CAPYBARA_DEVICES__AUTO_MODE=off\nCAPYBARA_ROLES=["worker"]\n',
    );
    const env = {
      CAPYBARA_DB__URL: "postgres://test:test@localhost/test",
      CAPYBARA_REDIS__URL: "redis://localhost:6379",
      CAPYBARA_MASTER_KEY: Buffer.alloc(32).toString("base64"),
      CAPYBARA_DEVICES__AUTO_MODE: "allowed",
    };
    state.mode = "capture";
    state.captured = [];
    try {
      const io = {
        env,
        cwd: dir,
        stdout: new Writable({
          write(_chunk, _encoding, callback) {
            callback();
          },
        }),
        stderr: new Writable({
          write(_chunk, _encoding, callback) {
            callback();
          },
        }),
        stdin: process.stdin,
      };
      expect(
        await main(
          [
            "start",
            "--env-file",
            "startup.env",
            "--role",
            "api",
            "--activate-permission-config",
            hash,
          ],
          io,
        ),
      ).toBeUndefined();
      expect(state.captured).toHaveLength(1);
      const captured = state.captured[0];
      if (!captured) throw new Error("Kernel start did not receive options");
      const [config, options] = captured as [
        import("@capybara-hq/kernel").KernelConfig,
        import("@capybara-hq/kernel").KernelAppOptions,
      ];
      expect(options.permissionConfigActivation).toEqual({ expectedActiveHash: hash });
      expect(config.roles).toEqual(["api"]);
      expect(config.devices.fullAccess).toBe("allowed");
      expect(options.env?.CAPYBARA_ROLES).toBe('["api"]');
      expect(JSON.stringify(config)).not.toContain(hash);
      expect(JSON.stringify(options.env)).not.toContain(hash);
      expect(await options.source?.load()).toEqual({});
    } finally {
      state.mode = "signal";
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
