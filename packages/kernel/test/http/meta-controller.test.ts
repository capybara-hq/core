import { describe, expect, it, vi } from "vitest";
import { MetaController } from "../../src/http/meta.controller.js";
import type { KernelConfigService } from "../../src/infra/config/kernel-config.service.js";
import type { PushProviderHost } from "../../src/push/provider-host.js";
import type { PlatformIconService } from "../../src/themes/platform-icon.service.js";

function controller(publicUrl: string | undefined) {
  const coverage = vi.fn(() => [{ appId: "com.a", providers: ["push-a"] }]);
  const config = { get: () => ({ platform: {}, http: { publicUrl } }) };
  const icons = { current: async () => null };
  const c = new MetaController(
    config as unknown as KernelConfigService,
    icons as unknown as PlatformIconService,
    { coverage } as unknown as PushProviderHost,
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
