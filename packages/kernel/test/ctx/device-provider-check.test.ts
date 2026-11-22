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

describe("checkDeviceProvider and permissions.dialIn", () => {
  const dialIn = { protocol: "fake-dial-in/1" };
  const handler = { onHello: async () => ({ ok: true }) };

  it("refuses a provider declaring permissions.dialIn without dialIn.onHello", () => {
    expect(() => checkDeviceProvider("p", fullFake(), dialIn)).toThrow(
      "plugin p: device-provider@1 requires dialIn.onHello",
    );
    expect(() => checkDeviceProvider("p", { ...fullFake(), dialIn: {} }, dialIn)).toThrow(
      "requires dialIn.onHello",
    );
  });

  it("refuses a dialIn handler whose onFrame or onClose is no function", () => {
    expect(() =>
      checkDeviceProvider("p", { ...fullFake(), dialIn: { ...handler, onClose: 1 } }, dialIn),
    ).toThrow("requires dialIn.onClose to be a function");
  });

  it("refuses a provider implementing dialIn without declaring permissions.dialIn", () => {
    expect(() => checkDeviceProvider("p", { ...fullFake(), dialIn: handler })).toThrow(
      "implements dialIn without declaring permissions.dialIn",
    );
  });

  it("passes a provider that declares and implements dialIn", () => {
    const impl = { ...fullFake(), dialIn: handler };
    expect(checkDeviceProvider("p", impl, dialIn)).toBe(impl);
  });
});
