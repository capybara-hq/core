import { describe, expect, it } from "vitest";
import { deviceModeViewOf, type LocalReport } from "../../src/devices/devices.service.js";
import { type DeploymentDevicePolicy, effectiveDevicePolicy } from "../../src/sandbox/modes.js";

/** A device's mode view on its page (auto mode spec §4.3). */

const deployment = (
  fullAccess: DeploymentDevicePolicy["fullAccess"] = "allowed",
  egress: "none" | "allowlist" = "allowlist",
): DeploymentDevicePolicy => ({
  fullAccess,
  limits: { egress, allowHosts: ["pypi.org"], orgHosts: "extend" },
});

/** What a local machine reported: the mode its owner report encodes and its allowlist. */
const summary = (s: Partial<LocalReport> = {}): LocalReport => ({
  reported: "auto",
  allowedDomains: [],
  ...s,
});

const OPEN = { kind: "open-public" as const, hosts: [] };
const extra = {
  pendingNextUse: false,
  pendingFilesReset: false,
  recent: [],
  sandboxNetwork: OPEN,
  fullNetwork: OPEN,
  outerNetwork: null,
};

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
    const org = {
      deviceNetwork: {
        ceiling: "allowlist" as const,
        base: "none" as const,
        extraHosts: ["a.com"],
      },
    };
    const policy = effectiveDevicePolicy(deployment(), org, null);
    expect(deviceModeViewOf(policy, org, false, null, extra)).toMatchObject({
      mode: "auto",
      network: { kind: "open-public", hosts: [], source: "platform" },
    });
  });

  it("a cloud device narrowed to sandbox applies the org's allowlist", () => {
    const org = {
      deviceNetwork: {
        ceiling: "allowlist" as const,
        base: "none" as const,
        extraHosts: ["a.com"],
      },
    };
    const policy = effectiveDevicePolicy(deployment(), org, "sandbox");
    expect(deviceModeViewOf(policy, org, false, null, extra)).toMatchObject({
      mode: "sandbox",
      allowedMode: "auto",
      network: { kind: "allowlist", hosts: ["a.com"], source: "org" },
      local: null,
    });
  });

  it("the org turning auto mode off: allowedBy is null and no device may report auto", () => {
    const org = { outsideSandbox: "off" as const };
    const policy = effectiveDevicePolicy(deployment(), org, "auto");
    expect(deviceModeViewOf(policy, org, true, summary(), extra)).toMatchObject({
      mode: "sandbox",
      allowedMode: "sandbox",
      allowedBy: null,
      local: { reported: "auto", allowedDomains: [] },
      // a local device's sandbox network is its machine's allowlist, not the cloud network
      sandboxNetwork: null,
      fullNetwork: null,
      outerNetwork: null,
    });
  });

  it("a cloud device in sandbox mode with the org's open network names the org", () => {
    const org = { deviceNetwork: { default: "open" as const } };
    const policy = effectiveDevicePolicy(deployment(), org, "sandbox");
    expect(deviceModeViewOf(policy, org, false, null, extra)).toMatchObject({
      mode: "sandbox",
      network: { kind: "open-public", hosts: [], source: "org" },
    });
  });

  it("the platform kill switch names the platform even when the org supplied hosts", () => {
    const org = {
      deviceNetwork: {
        ceiling: "allowlist" as const,
        base: "none" as const,
        extraHosts: ["a.com"],
      },
    };
    // the deployment is at egress none: every read is an empty allowlist
    const policy = effectiveDevicePolicy(deployment("allowed", "none"), org, "sandbox");
    expect(deviceModeViewOf(policy, org, false, null, extra, true)).toMatchObject({
      mode: "sandbox",
      network: { kind: "allowlist", hosts: [], source: "platform" },
    });
  });

  it("a pending change is pending at the next use or at a file reset, never both", () => {
    const org = {
      deviceNetwork: {
        ceiling: "allowlist" as const,
        base: "none" as const,
        extraHosts: ["a.com"],
      },
    };
    const policy = effectiveDevicePolicy(deployment(), org, "sandbox");
    const nextUse = { ...extra, pendingNextUse: true };
    expect(deviceModeViewOf(policy, org, false, null, nextUse)).toMatchObject({
      pendingNextUse: true,
      pendingFilesReset: false,
    });
    const fileReset = { ...extra, pendingFilesReset: true };
    expect(deviceModeViewOf(policy, org, false, null, fileReset)).toMatchObject({
      pendingNextUse: false,
      pendingFilesReset: true,
    });
  });

  it("a local device reports its own mode and allowlist; the org explicitly allowing auto names the org", () => {
    const org = { outsideSandbox: "allowed" as const };
    const s = summary({ reported: "sandbox", allowedDomains: ["a.com"] });
    const policy = effectiveDevicePolicy(deployment(), org, s.reported);
    expect(deviceModeViewOf(policy, org, true, s, extra)).toMatchObject({
      mode: "sandbox",
      allowedMode: "auto",
      allowedBy: "org",
      network: { kind: "allowlist", hosts: ["pypi.org"], source: "platform" },
      local: { reported: "sandbox", allowedDomains: ["a.com"] },
    });
  });
});
