import { describe, expect, it } from "vitest";
import { deviceLabel } from "../../src/devices/label.js";

/** The device names the IM `/device` list and the `Platform` tool show. */
describe("deviceLabel", () => {
  const docker = { zh: "Docker 沙箱", en: "Docker sandbox" };
  const demoted = (displayName: typeof docker | null, ordinal = 1) => ({
    name: null,
    demotedFrom: { provider: "sandbox-docker", displayName, ordinal },
  });

  it("a demoted default is the default's name plus the provider's display name", () => {
    expect(deviceLabel(demoted(docker), "zh")).toBe("个人设备（Docker 沙箱）");
    expect(deviceLabel(demoted(docker), "en")).toBe("Personal (Docker sandbox)");
    expect(deviceLabel(demoted(docker, 2), "en")).toBe("Personal (Docker sandbox) 2");
    // no display name (the plugin is gone): the plugin id
    expect(deviceLabel(demoted(null), "zh")).toBe("个人设备（sandbox-docker）");
  });

  it("a given name wins; the default is Personal", () => {
    expect(deviceLabel({ name: "Build box", demotedFrom: null }, "zh")).toBe("Build box");
    expect(deviceLabel({ name: null, demotedFrom: null }, "zh")).toBe("个人设备");
    expect(deviceLabel({ name: null, demotedFrom: null }, "en")).toBe("Personal");
  });
});
