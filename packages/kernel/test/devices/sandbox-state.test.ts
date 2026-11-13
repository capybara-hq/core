import type { DeviceLocalPolicySummary } from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import { deviceModeViewOf } from "../../src/devices/devices.service.js";
import { type DeploymentDevicePolicy, effectiveDevicePolicy } from "../../src/sandbox/modes.js";

/** A device's mode view on its page (auto mode spec §4.3). */

const deployment = (
  autoMode: DeploymentDevicePolicy["autoMode"] = "allowed",
  egress: "none" | "allowlist" = "allowlist",
): DeploymentDevicePolicy => ({
  autoMode,
  limits: { egress, allowHosts: ["pypi.org"] },
});

const summary = (s: Partial<DeviceLocalPolicySummary> = {}): DeviceLocalPolicySummary => ({
  mode: "auto",
  allowedDomains: [],
  ...s,
});

const extra = { pendingNextUse: false, recent: [] };

describe("deviceModeViewOf", () => {
  it("a cloud device: the allowed mode, the open network, no local settings", () => {
    const org = {};
    const policy = effectiveDevicePolicy(deployment(), org, null);
    expect(deviceModeViewOf(policy, org, false, null, extra)).toEqual({
      mode: "auto",
      allowedMode: "auto",
      allowedBy: "platform",
      network: { kind: "open-public", hosts: [], source: "platform" },
      local: null,
      ...extra,
    });
  });

  it("cloud auto mode ignores the org's allowlist; the source is the platform", () => {
    const org = { cloudNetwork: { mode: "allowlist" as const, allowHosts: ["a.com"] } };
    const policy = effectiveDevicePolicy(deployment(), org, null);
    expect(deviceModeViewOf(policy, org, false, null, extra)).toMatchObject({
      mode: "auto",
      network: { kind: "open-public", hosts: [], source: "platform" },
    });
  });

  it("a cloud device narrowed to sandbox applies the org's allowlist", () => {
    const org = { cloudNetwork: { mode: "allowlist" as const, allowHosts: ["a.com"] } };
    const policy = effectiveDevicePolicy(deployment(), org, "sandbox");
    expect(deviceModeViewOf(policy, org, false, null, extra)).toMatchObject({
      mode: "sandbox",
      allowedMode: "auto",
      network: { kind: "allowlist", hosts: ["a.com"], source: "org" },
      local: null,
    });
  });

  it("the org turning auto mode off: allowedBy is null and no device may report auto", () => {
    const org = { autoMode: "off" as const };
    const policy = effectiveDevicePolicy(deployment(), org, "auto");
    expect(deviceModeViewOf(policy, org, true, summary(), extra)).toMatchObject({
      mode: "sandbox",
      allowedMode: "sandbox",
      allowedBy: null,
      local: { reported: "auto", allowedDomains: [] },
    });
  });

  it("a cloud device in sandbox mode with the org's open network names the org", () => {
    const org = { cloudNetwork: { mode: "open" as const } };
    const policy = effectiveDevicePolicy(deployment(), org, "sandbox");
    expect(deviceModeViewOf(policy, org, false, null, extra)).toMatchObject({
      mode: "sandbox",
      network: { kind: "open-public", hosts: [], source: "org" },
    });
  });

  it("the platform kill switch names the platform even when the org supplied hosts", () => {
    const org = { cloudNetwork: { mode: "allowlist" as const, allowHosts: ["a.com"] } };
    // the deployment is at egress none: every read is an empty allowlist
    const policy = effectiveDevicePolicy(deployment("allowed", "none"), org, "sandbox");
    expect(deviceModeViewOf(policy, org, false, null, extra, true)).toMatchObject({
      mode: "sandbox",
      network: { kind: "allowlist", hosts: [], source: "platform" },
    });
  });

  it("a local device reports its own mode and allowlist; the org explicitly allowing auto names the org", () => {
    const org = { autoMode: "allowed" as const };
    const s = summary({ mode: "sandbox", allowedDomains: ["a.com"] });
    const policy = effectiveDevicePolicy(deployment(), org, s.mode);
    expect(deviceModeViewOf(policy, org, true, s, extra)).toMatchObject({
      mode: "sandbox",
      allowedMode: "auto",
      allowedBy: "org",
      network: { kind: "allowlist", hosts: ["pypi.org"], source: "platform" },
      local: { reported: "sandbox", allowedDomains: ["a.com"] },
    });
  });
});
