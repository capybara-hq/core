import { describe, expect, it } from "vitest";
import { checkDeviceProvider } from "../../src/ctx/device-provider-check.js";

const fullFake = (): Record<string, unknown> => ({
  networkAllowlist: true,
  concurrentExec: true,
  report: async () => ({}),
  killTagged: async () => {},
  exec: async () => ({}),
  create: async () => ({}),
  createFileSystem: async () => ({}),
});

describe("checkDeviceProvider", () => {
  it.each([
    "networkAllowlist",
    "concurrentExec",
    "report",
    "killTagged",
    "exec",
    "create",
    "createFileSystem",
  ])("refuses a provider without %s", (m) => {
    expect(() => checkDeviceProvider("p", { ...fullFake(), [m]: undefined })).toThrow(
      `plugin p: device-provider@1 requires ${m}`,
    );
  });

  it("refuses networkAllowlist that is not exactly true", () => {
    expect(() => checkDeviceProvider("p", { ...fullFake(), networkAllowlist: "yes" })).toThrow(
      "requires networkAllowlist",
    );
  });

  it("passes a complete provider through unchanged", () => {
    const impl = fullFake();
    expect(checkDeviceProvider("p", impl)).toBe(impl);
  });
});
