import { describe, expect, it } from "vitest";
import { deviceLabel } from "../../src/devices/label.js";

/** The device names the IM `/device` list and the `Platform` tool show. */
describe("deviceLabel", () => {
  it("the default is Personal / 个人设备; a given name wins", () => {
    expect(deviceLabel({ name: null }, "zh")).toBe("个人设备");
    expect(deviceLabel({ name: null }, "en")).toBe("Personal");
    expect(deviceLabel({ name: "Build box" }, "zh")).toBe("Build box");
    expect(deviceLabel({ name: "Build box" }, "en")).toBe("Build box");
  });
});
