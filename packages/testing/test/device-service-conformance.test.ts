import type { DeviceProvider, DeviceServiceStatus, SandboxHandle } from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import {
  DEVICE_SERVICE_ARGV_PROBE,
  runDeviceServiceConformance,
} from "../src/device-service-conformance.js";

/**
 * The device service conformance helper itself, on an in-memory provider: it passes a provider
 * that honours `ifRunning` and fails one that starts a service there (the launch review's
 * guarantee) or moves its state directory.
 */

type Services = Required<Pick<DeviceProvider, "ensureService" | "stopService" | "serviceRequest">>;

type Flaw =
  | "starts-if-running"
  | "moving-state-dir"
  | "refuses-name-only"
  | "entry-elsewhere"
  | "relative-code-dir";

function memoryProvider(flaw?: Flaw): Services {
  const running = new Map<string, string>();
  /** The entry each running service was started with (what its `process.argv[1]` names). */
  const entries = new Map<string, string>();
  let calls = 0;
  const status = (name: string): DeviceServiceStatus => {
    calls += 1;
    const stateDir = flaw === "moving-state-dir" ? `/state/${name}/${calls}` : `/state/${name}`;
    const startedAt = running.get(name) ?? null;
    const codeDir = flaw === "relative-code-dir" ? `code/${name}` : `/code/${name}`;
    return {
      name,
      state: startedAt === null ? "stopped" : "running",
      startedAt,
      stateDir,
      codeDir,
    };
  };
  return {
    async ensureService(_h, spec, _signal, opts) {
      if (opts?.ifRunning !== true || flaw === "starts-if-running") {
        if (flaw === "refuses-name-only" && spec.entry === "") throw new Error("invalid entry");
        if (!running.has(spec.name)) {
          running.set(spec.name, new Date().toISOString());
          const dir = flaw === "entry-elsewhere" ? `/state/${spec.name}` : `/code/${spec.name}`;
          entries.set(spec.name, `${dir}/${spec.entry}`);
        }
      } else if (flaw === "refuses-name-only" && spec.entry === "") {
        throw new Error("invalid entry");
      }
      return status(spec.name);
    },
    async stopService(_h, name) {
      running.delete(name);
    },
    async serviceRequest(_h, name, body) {
      if (!running.has(name)) throw new Error(`${name} is not running`);
      // the echo service answers its own entry path to the argv probe
      if (new TextDecoder().decode(body) === DEVICE_SERVICE_ARGV_PROBE)
        return new TextEncoder().encode(entries.get(name) ?? "");
      return body;
    },
  };
}

const run = (provider: Services) => {
  let disposed = false;
  const result = runDeviceServiceConformance({
    provider,
    handle: { id: "h1" } as SandboxHandle,
    dispose: async () => {
      disposed = true;
    },
  });
  return { result, disposed: () => disposed };
};

describe("runDeviceServiceConformance", () => {
  it("passes a provider that honours ifRunning", async () => {
    const r = run(memoryProvider());
    await r.result;
    expect(r.disposed()).toBe(true);
  });

  it("fails a provider that starts a service on an ifRunning ensure", async () => {
    const r = run(memoryProvider("starts-if-running"));
    await expect(r.result).rejects.toThrow(/ifRunning ensure must not start the service/);
    expect(r.disposed()).toBe(true);
  });

  it("fails a provider that refuses the kernel's name-only ifRunning spec", async () => {
    await expect(run(memoryProvider("refuses-name-only")).result).rejects.toThrow(/invalid entry/);
  });

  it("fails a provider whose service does not run its entry from codeDir ?? stateDir", async () => {
    await expect(run(memoryProvider("entry-elsewhere")).result).rejects.toThrow(
      /process\.argv\[1\]/,
    );
  });

  it("fails a provider whose codeDir is not absolute", async () => {
    await expect(run(memoryProvider("relative-code-dir")).result).rejects.toThrow(
      /codeDir must be absolute/,
    );
  });

  it("fails a provider whose state directory moves", async () => {
    await expect(run(memoryProvider("moving-state-dir")).result).rejects.toThrow(
      /stateDir must be stable/,
    );
  });
});
