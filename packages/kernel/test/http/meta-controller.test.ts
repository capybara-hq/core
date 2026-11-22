import { DEVICE_PROTOCOL_VERSION } from "@capybara-hq/plugin-sdk/device-protocol";
import { describe, expect, it, vi } from "vitest";
import type { DialInHandlers } from "../../src/dial-in/handlers.js";
import { deviceProtocolRange, MetaController } from "../../src/http/meta.controller.js";
import type { KernelConfigService } from "../../src/infra/config/kernel-config.service.js";
import type { PushProviderHost } from "../../src/push/provider-host.js";
import type { PlatformIconService } from "../../src/themes/platform-icon.service.js";

function controller(publicUrl: string | undefined, dialInProtocols: string[] = []) {
  const coverage = vi.fn(() => [{ appId: "com.a", providers: ["push-a"] }]);
  const config = {
    get: () => ({
      platform: {},
      http: { publicUrl },
      auth: { appRedirectUris: ["capybara://auth"] },
    }),
  };
  const icons = { current: async () => null };
  const c = new MetaController(
    config as unknown as KernelConfigService,
    icons as unknown as PlatformIconService,
    { coverage } as unknown as PushProviderHost,
    {
      loaded: () => dialInProtocols.map((protocol, i) => ({ plugin: `p${i}`, protocol })),
    } as unknown as DialInHandlers,
  );
  return { c, coverage };
}

describe("MetaController features.push", () => {
  it("lists the provider coverage when http.publicUrl is set", async () => {
    const { c } = controller("https://cap.example");
    expect((await c.meta()).features.push).toEqual([{ appId: "com.a", providers: ["push-a"] }]);
  });

  it("is empty without http.publicUrl, without asking the providers", async () => {
    const { c, coverage } = controller(undefined);
    expect((await c.meta()).features.push).toEqual([]);
    expect(coverage).not.toHaveBeenCalled();
  });
});

describe("MetaController local devices", () => {
  it("no dial-in provider loaded: localDevices false, the SDK's major as the range", async () => {
    const m = await controller(undefined).c.meta();
    expect(m.features.localDevices).toBe(false);
    expect(m.protocols.device).toEqual({
      min: DEVICE_PROTOCOL_VERSION,
      max: DEVICE_PROTOCOL_VERSION,
    });
  });

  it("only a provider speaking another protocol: localDevices false", async () => {
    const m = await controller(undefined, ["fake-dial-in/1"]).c.meta();
    expect(m.features.localDevices).toBe(false);
  });

  it("a provider speaking capybara-device: localDevices true, its declared major as the range", async () => {
    const m = await controller(undefined, ["fake-dial-in/1", "capybara-device/7"]).c.meta();
    expect(m.features.localDevices).toBe(true);
    expect(m.protocols.device).toEqual({ min: 7, max: 7 });
  });
});

describe("deviceProtocolRange", () => {
  it("spans the capybara-device majors and ignores other protocols", () => {
    expect(deviceProtocolRange([])).toBeNull();
    expect(deviceProtocolRange(["other/3", "capybara-device-x/4"])).toBeNull();
    expect(deviceProtocolRange(["capybara-device/6", "other/9", "capybara-device/5"])).toEqual({
      min: 5,
      max: 6,
    });
  });
});
