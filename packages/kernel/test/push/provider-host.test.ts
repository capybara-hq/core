import {
  fakeExtensionEntry,
  startTestPostgres,
  startTestRedis,
  type TestContainer,
} from "@capybara-hq/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ExtensionHost } from "../../src/extensions/host.js";
import { ExtensionRegistry } from "../../src/extensions/registry.js";
import { KernelConfigService } from "../../src/infra/config/kernel-config.service.js";
import { PushProviderHost } from "../../src/push/provider-host.js";
import { runConfig, startKernel, type TestKernel } from "../helpers/runs.js";

let pgc: TestContainer;
let rd: TestContainer;
let k: TestKernel;

const meta = async () => (await k.http.inject({ method: "GET", url: "/api/v1/meta" })).json();

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        extensions: [fakeExtensionEntry("fake-push")],
        extensionConfig: { "fake-push": { apps: ["com.example.b", "com.example.a"] } },
        http: { port: 0, publicUrl: "https://cap.example" },
      },
    ),
  );
});
afterAll(async () => {
  await k?.close();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

describe("PushProviderHost and features.push", () => {
  it("lists coverage sorted by app id, then provider", () => {
    const host = k.app.get(PushProviderHost);
    expect(host.any()).toBe(true);
    expect(host.coverage()).toEqual([
      { appId: "com.example.a", providers: ["fake-push"] },
      { appId: "com.example.b", providers: ["fake-push"] },
    ]);
  });

  it("answers covers() and provider() per plugin", () => {
    const host = k.app.get(PushProviderHost);
    expect(host.covers("fake-push", "com.example.a")).toBe(true);
    expect(host.covers("fake-push", "com.other")).toBe(false);
    expect(host.covers("nope", "com.example.a")).toBe(false);
    expect(host.provider("fake-push")).not.toBeNull();
    expect(host.provider("nope")).toBeNull();
  });

  it("lists the coverage in meta only with http.publicUrl", async () => {
    expect((await meta()).features.push).toEqual([
      { appId: "com.example.a", providers: ["fake-push"] },
      { appId: "com.example.b", providers: ["fake-push"] },
    ]);
    const config = k.app.get(KernelConfigService);
    const real = config.get();
    const spy = vi
      .spyOn(config, "get")
      .mockReturnValue({ ...real, http: { ...real.http, publicUrl: undefined } });
    const off = await meta();
    spy.mockRestore();
    expect(off.features.push).toEqual([]);
  });

  it("treats a throwing apps() as not covered", () => {
    const host = k.app.get(PushProviderHost);
    const registry = k.app.get(ExtensionRegistry);
    const real = registry.list.bind(registry);
    const spy = vi.spyOn(registry, "list").mockImplementation((name) =>
      real(name).map((e) => ({
        ...e,
        impl: {
          apps: () => {
            throw new Error("bad config");
          },
        },
      })),
    );
    expect(host.covers("fake-push", "com.example.a")).toBe(false);
    expect(host.coverage()).toEqual([]);
    spy.mockRestore();
  });

  it("drops the provider once the extension is unloaded", async () => {
    await k.app.get(ExtensionHost).unload("fake-push");
    expect(k.app.get(PushProviderHost).any()).toBe(false);
    expect((await meta()).features.push).toEqual([]);
  });
});
