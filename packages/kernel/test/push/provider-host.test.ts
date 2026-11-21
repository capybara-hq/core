import { PUSH_PROVIDER_EXTENSION_POINT } from "@capybara-hq/plugin-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionPointEntry, ExtensionRegistry } from "../../src/extensions/registry.js";
import type { KernelLogger } from "../../src/log.js";
import { PushProviderHost } from "../../src/push/provider-host.js";

const entry = (plugin: string, apps: () => string[], capability = PUSH_PROVIDER_EXTENSION_POINT) =>
  ({ plugin, capability, impl: { apps } }) as unknown as ExtensionPointEntry;

function setup(initial: ExtensionPointEntry[]) {
  const state = { entries: initial };
  const list = vi.fn((_name: string) => state.entries);
  const log = { warn: vi.fn(), debug: vi.fn() };
  const host = new PushProviderHost(
    { list } as unknown as ExtensionRegistry,
    log as unknown as KernelLogger,
  );
  return { state, list, log, host };
}

afterEach(() => vi.restoreAllMocks());

describe("PushProviderHost", () => {
  it("lists coverage sorted by app id, then provider name", () => {
    const { host } = setup([
      entry("push-b", () => ["com.z", "com.a"]),
      entry("push-a", () => ["com.z"]),
    ]);
    expect(host.coverage()).toEqual([
      { appId: "com.a", providers: ["push-b"] },
      { appId: "com.z", providers: ["push-a", "push-b"] },
    ]);
  });

  it("answers covers() and provider() negatives and any()", () => {
    const { host, list } = setup([entry("push-a", () => ["com.a"])]);
    expect(host.covers("push-a", "com.a")).toBe(true);
    expect(host.covers("push-a", "com.other")).toBe(false);
    expect(host.covers("nope", "com.a")).toBe(false);
    expect(host.provider("push-a")).not.toBeNull();
    expect(host.provider("nope")).toBeNull();
    expect(host.any()).toBe(true);
    expect(list).toHaveBeenCalledWith("push-provider");
  });

  it("ignores an entry of another major version", () => {
    const { host } = setup([entry("push-a", () => ["com.a"], "push-provider@2" as never)]);
    expect(host.any()).toBe(false);
    expect(host.provider("push-a")).toBeNull();
    expect(host.coverage()).toEqual([]);
  });

  it("counts a throwing apps() as not covered, logging the plugin only", () => {
    const boom = () => {
      throw new Error("secret-config-value");
    };
    const { host, log } = setup([entry("push-a", boom)]);
    expect(host.covers("push-a", "com.a")).toBe(false);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(expect.any(String), { plugin: "push-a" });
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain("secret-config-value");
    // the public meta lists coverage on every request: debug, never warn
    expect(host.coverage()).toEqual([]);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.debug).toHaveBeenCalledWith(expect.any(String), { plugin: "push-a" });
  });

  it("reads the registry live, with no cache", () => {
    const { host, state } = setup([entry("push-a", () => ["com.a"])]);
    expect(host.coverage()).toHaveLength(1);
    state.entries = [];
    expect(host.any()).toBe(false);
    expect(host.coverage()).toEqual([]);
    state.entries = [entry("push-b", () => ["com.b"])];
    expect(host.coverage()).toEqual([{ appId: "com.b", providers: ["push-b"] }]);
  });
});
