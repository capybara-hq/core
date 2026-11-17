import { DeviceProtocolError, FileSystemGoneError, ToolError } from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import { ApiError } from "../../../src/errors.js";
import { InstanceBindingError } from "../../../src/local-devices/instance-bindings.js";
import { mapSandboxError } from "../../../src/tools/builtins/sandbox/common.js";

/** The model-visible tool errors of a device (spec 2026-11-07-environments-design §15). */

const message = (e: unknown): string => (e as Error).message;

describe("sandbox tool errors", () => {
  const cases: [string, ApiError][] = [
    ["offline", new ApiError("device.offline", "x")],
    ["files lost (cloud)", new ApiError("device.files_lost", "x", [{ source: "cloud" }])],
    ["files lost (local)", new ApiError("device.files_lost", "x", [{ source: "local" }])],
    ["outdated program", new ApiError("device.program_outdated", "x")],
    ["revoked", new ApiError("device.forbidden", "x", [{ reason: "machine_revoked" }])],
    ["forbidden", new ApiError("device.forbidden", "x")],
    ["unavailable", new ApiError("device.unavailable", "x")],
    ["not found", new ApiError("device.not_found", "x")],
  ];
  const others: [string, unknown][] = [
    ["files gone", new FileSystemGoneError("gone")],
    ["unreadable answer", new DeviceProtocolError("bad")],
  ];

  it.each(cases)("tool errors name the device, never an environment: %s", (_name, err) => {
    const text = message(mapSandboxError(err, undefined));
    expect(text).toMatch(/device/);
    expect(text).not.toMatch(/environment/i);
  });

  it.each(others)("outside withSandbox: %s", (_name, err) => {
    const text = message(mapSandboxError(err, undefined));
    expect(text).toMatch(/device/);
    expect(text).not.toMatch(/environment/i);
  });

  it("a device whose sandbox limits must be established again says how to recover", () => {
    const mapped = mapSandboxError(
      new ApiError("device.permission_reconcile_required", "internal detail"),
      undefined,
    );
    expect(mapped).toBeInstanceOf(ToolError);
    expect(message(mapped)).toMatch(/device/);
    expect(message(mapped)).toMatch(/reset/);
    expect(message(mapped)).not.toContain("internal detail");
  });

  // B-13: the old auto-mode codes and their full-access renames (W5-P3b) are actionable English
  // tool errors, never the kernel's own message; the old device code keeps the machine's text
  it.each([
    "device.auto_mode_not_allowed",
    "device.full_access_not_allowed",
    "org.auto_mode_not_allowed",
    "org.full_access_not_allowed",
    "deployment.auto_mode_not_allowed",
    "deployment.full_access_not_allowed",
  ])("a refused Full access (%s) is an actionable tool error", (code) => {
    // biome-ignore lint/suspicious/noExplicitAny: the renamed codes are registered by W5-P3b
    const mapped = mapSandboxError(new ApiError(code as any, "internal detail"), undefined);
    expect(mapped).toBeInstanceOf(ToolError);
    if (code !== "device.auto_mode_not_allowed") expect(message(mapped)).toMatch(/Full access/);
    expect(message(mapped)).toMatch(/capybara-device mode sandbox/);
    expect(message(mapped)).toMatch(/another device/);
    expect(message(mapped)).not.toContain("internal detail");
    expect(message(mapped)).not.toMatch(/environment/i);
  });

  it("an instance binding that cannot complete is an actionable device error", () => {
    const mapped = mapSandboxError(new InstanceBindingError("No committed binding"), undefined);
    expect(mapped).toBeInstanceOf(ToolError);
    expect(message(mapped)).toMatch(/device/);
    expect(message(mapped)).toMatch(/capybara-device/);
    expect(message(mapped)).not.toContain("No committed binding");
  });
});
