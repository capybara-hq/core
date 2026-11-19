import { describe, expect, it } from "vitest";
import { sandboxViewOf } from "../../src/devices/devices.service.js";
import { ownerFactsOf } from "../../src/local-devices/owner-report.js";
import {
  type DeviceSandboxDeviceLayer,
  type DeviceSandboxOrgLayer,
  type DeviceSandboxPlatformLayer,
  effectiveDeviceSandbox,
  providerLayerOf,
} from "../../src/sandbox/device-sandbox.js";

/** A device's sandbox view on its page (approval-only profiles design, "UI"). */

const platform = (
  over: Partial<DeviceSandboxPlatformLayer["settings"]["network"]> = {},
): DeviceSandboxPlatformLayer => ({
  settings: { outsideSandbox: "allowed", network: { default: "open", ceiling: "open", ...over } },
  allowHosts: ["pypi.org", "registry.npmjs.org"],
  orgHosts: "extend",
  egress: "allowlist",
});

const extra = { pendingNextUse: false, pendingFilesReset: false, recent: [] };

const boxOf = (device: DeviceSandboxDeviceLayer, org: DeviceSandboxOrgLayer = {}, p = platform()) =>
  effectiveDeviceSandbox(p, org, device, providerLayerOf(null, device.location));

describe("sandboxViewOf", () => {
  it("a cloud device following its org: the open network, no outside, nothing of its own", () => {
    const own = { networkMode: null, networkHosts: [] };
    expect(sandboxViewOf(boxOf({ location: "cloud", ...own }), own, extra)).toEqual({
      network: "open",
      networkCeiling: "open",
      hosts: [],
      ownNetwork: null,
      allowedDomains: [],
      outsideSandbox: false,
      restrictedProjectReach: "workspace",
      layer: { network: null, outsideSandbox: "provider" },
      ...extra,
    });
  });

  it("a cloud device's own list narrows the org's hosts; the org's ceiling names the org", () => {
    const own = { networkMode: "allowlist" as const, networkHosts: ["pypi.org", "evil.test"] };
    const view = sandboxViewOf(
      boxOf({ location: "cloud", ...own }, { deviceNetwork: { ceiling: "allowlist" } }),
      own,
      extra,
    );
    expect(view).toMatchObject({
      network: "allowlist",
      networkCeiling: "allowlist",
      hosts: ["pypi.org"],
      ownNetwork: "allowlist",
      allowedDomains: ["pypi.org", "evil.test"],
      layer: { network: "org" },
    });
  });

  it("a local machine: its owner's network and list, running outside when everyone allows it", () => {
    const facts = {
      ...ownerFactsOf({}),
      state: "report" as const,
      outsideSandbox: true,
      network: "allowlist" as const,
      allowedDomains: ["pypi.org"],
    };
    const box = boxOf({
      location: "local",
      outsideSandbox: true,
      network: "allowlist",
      allowedDomains: ["pypi.org"],
      restrictedProjectReach: "workspace",
    });
    expect(sandboxViewOf(box, facts, extra)).toMatchObject({
      network: "allowlist",
      hosts: ["pypi.org"],
      ownNetwork: "allowlist",
      allowedDomains: ["pypi.org"],
      outsideSandbox: true,
      layer: { network: "device", outsideSandbox: null },
    });
  });

  it("a machine without a readable owner report has no network of its own", () => {
    const facts = ownerFactsOf({});
    const box = boxOf({
      location: "local",
      outsideSandbox: facts.outsideSandbox,
      network: facts.network,
      allowedDomains: facts.allowedDomains,
      restrictedProjectReach: facts.restrictedProjectReach,
    });
    expect(sandboxViewOf(box, facts, extra)).toMatchObject({
      ownNetwork: null,
      outsideSandbox: false,
      layer: { outsideSandbox: "device" },
    });
  });
});
