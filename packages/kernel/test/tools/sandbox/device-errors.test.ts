import {
  DeviceOfflineError,
  DialInAnswerTimeoutError,
  FileSystemGoneError,
  SandboxOperationOutcomeUnknownError,
  SandboxPermissionUnsupportedError,
  SandboxScopeDeniedError,
  SandboxScopeValidationError,
  SandboxWorkUnsettledError,
  ToolError,
} from "@capybara-hq/plugin-sdk";
import { DeviceProtocolError } from "@capybara-hq/plugin-sdk/device-protocol";
import { describe, expect, it, vi } from "vitest";
import { DeviceRequestNotSentError } from "../../../src/dial-in/relay.js";
import { ApiError } from "../../../src/errors.js";
import type { PermissionAvailabilityCause } from "../../../src/sandbox/permission-availability.js";
import { DeviceProgramRestartedError } from "../../../src/sandbox/request-not-sent.js";
import {
  providerRefusal,
  recreateRequired,
  retirementPending,
} from "../../../src/sandbox/sandbox.service.js";
import {
  admissionUnavailableText,
  DEVICE_OFFLINE_TEXT,
  DEVICE_PROGRAM_RESTARTED_TOOL_TEXT,
  DEVICE_REQUEST_NOT_SENT_TOOL_TEXT,
  ENV_UNAVAILABLE_TEXT,
  ESCALATION_GRANT_MISSING_LAUNCH_WHY,
  ESCALATION_GRANT_MISSING_TEXT,
  mapSandboxError,
  ORG_OUTSIDE_SANDBOX_OFF_TOOL_TEXT,
  OUTCOME_UNKNOWN_TOOL_TEXT,
  OUTSIDE_SANDBOX_CEILING_TOOL_TEXT,
  PERMISSION_UNSUPPORTED_TOOL_TEXT,
  PermissionAdmissionUnavailable,
  PLATFORM_OUTSIDE_SANDBOX_OFF_TOOL_TEXT,
  RETIREMENT_PENDING_TOOL_TEXT,
  RETIREMENT_RECREATE_TOOL_TEXT,
  SCOPE_DENIED_TOOL_TEXT,
  SCOPE_INVALID_TOOL_TEXT,
  WORK_UNSETTLED_TOOL_TEXT,
} from "../../../src/tools/builtins/sandbox/common.js";

/** The model-visible tool errors of a device (spec 2026-11-07-environments-design §15). */

const message = (e: unknown): string => (e as Error).message;

describe("sandbox tool errors", () => {
  const cases: [string, ApiError][] = [
    ["offline", new ApiError("device.offline", "x")],
    ["files lost", new ApiError("device.files_lost", "x")],
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
    // every provider's devices read the same: no program of one provider is named
    expect(text).not.toMatch(/capybara-device/);
  });

  it("a connected machine that never answered is the outcome-unknown text, never offline", () => {
    const mapped = mapSandboxError(new DialInAnswerTimeoutError(30_000), undefined);
    expect(mapped).toBeInstanceOf(ToolError);
    expect(message(mapped)).toBe(OUTCOME_UNKNOWN_TOOL_TEXT);
  });

  it("a slow machine is never a refused network or a failed create (providerRefusal keeps it)", () => {
    const warn = vi.fn();
    const open = {
      cpu: 1,
      memoryMb: 512,
      diskMb: 1024,
      network: { kind: "open-public" as const, hosts: [] },
    };
    const facts = { deviceId: "d", provider: "device-local", op: "create" as const };
    for (const err of [
      new DialInAnswerTimeoutError(30_000),
      new SandboxOperationOutcomeUnknownError("deadline elapsed"),
      new DeviceRequestNotSentError("not taken"),
    ]) {
      expect(providerRefusal({ warn }, err, facts, open, new AbortController().signal)).toBe(err);
      expect(
        providerRefusal(
          { warn },
          err,
          facts,
          { ...open, network: { kind: "allowlist", hosts: [] } },
          new AbortController().signal,
        ),
      ).toBe(err);
    }
    expect(warn).not.toHaveBeenCalled();
  });

  it("a dial-in provider's offline error is the tools' offline text, like device.offline", () => {
    const sdk = mapSandboxError(new DeviceOfflineError("dev-1"), undefined);
    expect(sdk).toBeInstanceOf(ToolError);
    expect(message(sdk)).toBe(DEVICE_OFFLINE_TEXT);
    expect(message(mapSandboxError(new ApiError("device.offline", "x"), undefined))).toBe(
      DEVICE_OFFLINE_TEXT,
    );
  });

  it.each(others)("outside the sandbox service: %s", (_name, err) => {
    const text = message(mapSandboxError(err, undefined));
    expect(text).toMatch(/device/);
    expect(text).not.toMatch(/environment/i);
  });

  it("device.unavailable becomes the actionable provider-off tool text", () => {
    const mapped = mapSandboxError(
      new ApiError(
        "device.unavailable",
        "This device's provider device-fake is off in this organization or not installed; its files are kept, and the device works again once an org admin switches the provider back on",
      ),
      undefined,
    );
    expect(mapped).toBeInstanceOf(ToolError);
    expect(message(mapped)).toBe(ENV_UNAVAILABLE_TEXT);
    expect(ENV_UNAVAILABLE_TEXT).toBe(
      "This conversation's device runs on a device provider that is off in this organization or not installed; its files are kept. Ask an org admin to switch the provider back on, or start a new conversation on another device.",
    );
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

  // B-13: running outside the sandbox off by policy: one actionable text per layer that blocks it,
  // never the kernel's message and never "Full access" (the profile no longer runs outside)
  it.each([
    ["org.outside_sandbox_not_allowed", ORG_OUTSIDE_SANDBOX_OFF_TOOL_TEXT, /an organization admin/],
    [
      "deployment.outside_sandbox_not_allowed",
      PLATFORM_OUTSIDE_SANDBOX_OFF_TOOL_TEXT,
      /a super admin/,
    ],
  ] as const)(
    "running outside the sandbox off by policy (%s) names who can allow it",
    (code, text, who) => {
      const mapped = mapSandboxError(new ApiError(code, "internal detail"), undefined);
      expect(mapped).toBeInstanceOf(ToolError);
      expect(message(mapped)).toBe(text);
      expect(message(mapped)).toMatch(who);
      expect(message(mapped)).toMatch(/outside the sandbox/);
      expect(message(mapped)).not.toMatch(/Full access/);
      expect(message(mapped)).not.toContain("internal detail");
    },
  );

  it("an approval that no longer matches names the outside-sandbox setting, not Full access", () => {
    for (const text of [ESCALATION_GRANT_MISSING_TEXT, ESCALATION_GRANT_MISSING_LAUNCH_WHY]) {
      expect(text).toMatch(/outside-sandbox setting/);
      expect(text).not.toMatch(/Full access/);
    }
  });

  it("a device that does not allow running outside the sandbox names its owner, no program command", () => {
    const mapped = mapSandboxError(
      new ApiError("device.outside_sandbox_not_allowed", "internal detail"),
      undefined,
    );
    expect(mapped).toBeInstanceOf(ToolError);
    expect(message(mapped)).toBe(OUTSIDE_SANDBOX_CEILING_TOOL_TEXT);
    expect(message(mapped)).toMatch(/outside the sandbox/);
    expect(message(mapped)).toMatch(/device's owner/);
    expect(message(mapped)).not.toMatch(/capybara-device/);
    expect(message(mapped)).not.toContain("internal detail");
  });

  // the legacy retirement gate (8.5): its own actionable text, never the inactive-provider one
  it.each([
    [retirementPending(), /confirmed destroyed/, RETIREMENT_PENDING_TOOL_TEXT],
    [recreateRequired(), /delete the device and create it again/, RETIREMENT_RECREATE_TOOL_TEXT],
  ])("a retirement refusal (%#) says what clears it", (error, what, text) => {
    const mapped = mapSandboxError(error, undefined);
    expect(mapped).toBeInstanceOf(ToolError);
    expect(message(mapped)).toMatch(/earlier version/);
    expect(message(mapped)).toMatch(what);
    expect(message(mapped)).not.toBe(ENV_UNAVAILABLE_TEXT);
    expect(message(mapped)).toBe(text);
  });

  it("a scope the device refuses as invalid is a kernel invariant break: fixed text, logged", () => {
    const warned: unknown[][] = [];
    const mapped = mapSandboxError(
      new SandboxScopeValidationError("provider secret network.kind: environment"),
      { warn: (...args: unknown[]) => void warned.push(args) } as never,
    );
    expect(mapped).toBeInstanceOf(ToolError);
    expect(message(mapped)).toBe(SCOPE_INVALID_TOOL_TEXT);
    expect(message(mapped)).not.toContain("provider secret");
    expect(String(warned[0]?.[0])).toMatch(/kernel invariant/);
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
      "earlier work unsettled",
      new SandboxWorkUnsettledError("provider secret busy"),
      WORK_UNSETTLED_TOOL_TEXT,
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
    [
      // the operation path records it unknown and keeps the relay's error as the cause
      "outcome unknown after the program restarted",
      new SandboxOperationOutcomeUnknownError("provider secret state", {
        cause: new DeviceProgramRestartedError("exec"),
      }),
      DEVICE_PROGRAM_RESTARTED_TOOL_TEXT,
    ],
    [
      "program restarted (a call outside an operation)",
      new DeviceProgramRestartedError("backgroundStatus"),
      DEVICE_PROGRAM_RESTARTED_TOOL_TEXT,
    ],
  ])("%s is an actionable tool error", (_name, err, text) => {
    const mapped = mapSandboxError(err, undefined);
    expect(mapped).toBeInstanceOf(ToolError);
    expect(message(mapped)).toBe(text);
    expect(message(mapped)).not.toContain("provider secret");
  });

  // admission's own refusal on a device without scoped operations: the kernel renders the text
  // from the cause, never from a provider-written reason (ruling R9)
  it("an admission refusal names its cause: an outdated sandbox plugin", () => {
    const cause = {
      kind: "provider-outdated",
      plugin: "sandbox-docker",
      version: "0.1.0-rc.16",
    } as const satisfies PermissionAvailabilityCause;
    const mapped = mapSandboxError(
      new PermissionAdmissionUnavailable(cause, "provider secret reason"),
      undefined,
    );
    expect(mapped).toBeInstanceOf(ToolError);
    expect(message(mapped)).toBe(
      "This device's sandbox plugin (sandbox-docker 0.1.0-rc.16) cannot run device tools under a permission profile, so nothing ran. A super admin updates the plugin on the Plugins page; until then, continue without the device, or ask the user to start a new conversation on another device.",
    );
    expect(message(mapped)).toBe(admissionUnavailableText(cause));
  });

  it("an admission refusal names its cause: a runtime that cannot enforce its sandbox", () => {
    const mapped = mapSandboxError(
      new PermissionAdmissionUnavailable({ kind: "runtime" }, "provider secret reason"),
      undefined,
    );
    expect(mapped).toBeInstanceOf(ToolError);
    expect(message(mapped)).toBe(
      "This device's runtime cannot enforce its sandbox, so nothing ran. Ask the device's owner to update its device program (or a super admin to update its device plugin), or continue without the device.",
    );
  });

  it("a device's own unsupported refusal no longer blames the permission profile", () => {
    const mapped = mapSandboxError(new SandboxPermissionUnsupportedError("x"), undefined);
    expect(message(mapped)).toBe(
      "This device refused to run the operation because it cannot enforce its sandbox limits, so nothing ran. Ask the device's owner to update its device program (or a super admin to update its device plugin), or continue without the device.",
    );
    expect(message(mapped)).not.toContain("permission profile");
    expect(message(mapped)).toBe(PERMISSION_UNSUPPORTED_TOOL_TEXT);
  });
});
