import type { DeviceProvider, DeviceServiceStatus, SandboxHandle } from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import { runDeviceServiceConformance } from "../src/device-service-conformance.js";

/**
 * The device service conformance helper itself, on an in-memory provider: it passes a provider
 * that honours `ifRunning` and fails one that starts a service there (the launch review's
 * guarantee) or moves its state directory.
 */

type Services = Required<Pick<DeviceProvider, "ensureService" | "stopService" | "serviceRequest">>;

function memoryProvider(flaw?: "starts-if-running" | "moving-state-dir"): Services {
  const running = new Map<string, string>();
  let calls = 0;
  const status = (name: string): DeviceServiceStatus => {
    calls += 1;
    const stateDir = flaw === "moving-state-dir" ? `/state/${name}/${calls}` : `/state/${name}`;
    const startedAt = running.get(name) ?? null;
    return { name, state: startedAt === null ? "stopped" : "running", startedAt, stateDir };
  };
  return {
    async ensureService(_h, spec, _signal, opts) {
      if (!running.has(spec.name) && (opts?.ifRunning !== true || flaw === "starts-if-running"))
        running.set(spec.name, new Date().toISOString());
      return status(spec.name);
    },
    async stopService(_h, name) {
      running.delete(name);
    },
    async serviceRequest(_h, name, body) {
      if (!running.has(name)) throw new Error(`${name} is not running`);
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

  it("fails a provider whose state directory moves", async () => {
    await expect(run(memoryProvider("moving-state-dir")).result).rejects.toThrow(
      /stateDir must be stable/,
    );
  });
});
