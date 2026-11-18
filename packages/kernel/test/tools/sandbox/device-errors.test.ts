import {
  DeviceProtocolError,
  FileSystemGoneError,
  SandboxOperationOutcomeUnknownError,
  SandboxPermissionUnsupportedError,
  SandboxScopeDeniedError,
  ToolError,
} from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import { ApiError } from "../../../src/errors.js";
import { InstanceBindingError } from "../../../src/local-devices/instance-bindings.js";
import { DeviceRequestNotSentError } from "../../../src/local-devices/relay.js";
import {
  recreateRequired,
  replaceRequired,
  restartRequired,
  retirementPending,
} from "../../../src/sandbox/sandbox.service.js";
import {
  DEVICE_REQUEST_NOT_SENT_TOOL_TEXT,
  FULL_ACCESS_CEILING_TOOL_TEXT,
  FULL_ACCESS_OFF_BY_POLICY_TOOL_TEXT,
  mapSandboxError,
  OUTCOME_UNKNOWN_TOOL_TEXT,
  PERMISSION_UNSUPPORTED_TOOL_TEXT,
  RETIREMENT_TOOL_TEXT,
  SCOPE_DENIED_TOOL_TEXT,
} from "../../../src/tools/builtins/sandbox/common.js";

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

  // B-13: the full-access refusals are actionable English tool errors, never the kernel's message
  it.each(["org.full_access_not_allowed", "deployment.full_access_not_allowed"] as const)(
    "Full access off by policy (%s) names the profiles and who can allow it",
    (code) => {
      const mapped = mapSandboxError(new ApiError(code, "internal detail"), undefined);
      expect(mapped).toBeInstanceOf(ToolError);
      expect(message(mapped)).toBe(FULL_ACCESS_OFF_BY_POLICY_TOOL_TEXT);
      expect(message(mapped)).toMatch(/Request approval or Approve for me/);
      expect(message(mapped)).toMatch(/admin/);
      expect(message(mapped)).not.toMatch(/capybara-device mode/);
    },
  );

  it("a device ceiling without Full access points to the owner's ceiling command", () => {
    const mapped = mapSandboxError(
      new ApiError("device.full_access_not_allowed", "internal detail"),
      undefined,
    );
    expect(mapped).toBeInstanceOf(ToolError);
    expect(message(mapped)).toBe(FULL_ACCESS_CEILING_TOOL_TEXT);
    expect(message(mapped)).toMatch(/owner ceiling/);
    expect(message(mapped)).toMatch(/capybara-device ceiling set/);
    expect(message(mapped)).not.toContain("internal detail");
  });

  // the legacy retirement gate (8.5): its own actionable text, never the inactive-provider one
  it.each([
    [retirementPending(), /confirmed destroyed/],
    [restartRequired(), /restart that computer/],
    [recreateRequired(), /delete the device and create it again/],
    [replaceRequired(), /connect the computer again as a new device/],
  ])("a retirement refusal (%#) says what clears it", (error, what) => {
    const mapped = mapSandboxError(error, undefined);
    expect(mapped).toBeInstanceOf(ToolError);
    expect(message(mapped)).toMatch(/earlier version/);
    expect(message(mapped)).toMatch(what);
    expect(message(mapped)).not.toMatch(/not active in this deployment/);
    expect(message(mapped)).toBe(RETIREMENT_TOOL_TEXT[(error as ApiError).code]);
  });

  // the managed route's typed refusals: fixed kernel text, never the refusal's own message
  it.each([
    ["scope denied", new SandboxScopeDeniedError("provider secret /etc/x"), SCOPE_DENIED_TOOL_TEXT],
    [
      "profile unsupported",
      new SandboxPermissionUnsupportedError("provider secret runtime"),
      PERMISSION_UNSUPPORTED_TOOL_TEXT,
    ],
    [
      "outcome unknown",
      new SandboxOperationOutcomeUnknownError("provider secret state"),
      OUTCOME_UNKNOWN_TOOL_TEXT,
    ],
    [
      "request not sent",
      new DeviceRequestNotSentError("provider secret relay"),
      DEVICE_REQUEST_NOT_SENT_TOOL_TEXT,
    ],
  ])("%s is an actionable tool error", (_name, err, text) => {
    const mapped = mapSandboxError(err, undefined);
    expect(mapped).toBeInstanceOf(ToolError);
    expect(message(mapped)).toBe(text);
    expect(message(mapped)).not.toContain("provider secret");
  });

  it("an instance binding that cannot complete is an actionable device error", () => {
    const mapped = mapSandboxError(new InstanceBindingError("No committed binding"), undefined);
    expect(mapped).toBeInstanceOf(ToolError);
    expect(message(mapped)).toMatch(/device/);
    expect(message(mapped)).toMatch(/capybara-device/);
    expect(message(mapped)).not.toContain("No committed binding");
  });
});
