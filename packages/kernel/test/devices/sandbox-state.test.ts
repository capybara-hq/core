import { describe, expect, it } from "vitest";
import {
  networkNarrowingRevokes,
  sandboxViewOf,
  storedNetworkWidens,
} from "../../src/devices/devices.service.js";
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

describe("storedNetworkWidens (narrow only checks the stored setting too)", () => {
  const set = (mode: "open" | "allowlist" | "none" | null, hosts: string[] = []) => ({
    mode,
    hosts,
  });
  it("following the org is wider than any explicit mode; none < allowlist < open", () => {
    expect(storedNetworkWidens(set("allowlist"), set(null))).toBe(true);
    expect(storedNetworkWidens(set("open"), set(null))).toBe(true);
    expect(storedNetworkWidens(set("none"), set("allowlist"))).toBe(true);
    expect(storedNetworkWidens(set(null), set("open"))).toBe(false);
    expect(storedNetworkWidens(set("open"), set("none"))).toBe(false);
  });
  it("an explicit host list dropped or gaining a host widens; a shorter one narrows", () => {
    expect(storedNetworkWidens(set("allowlist", ["a.com"]), set("allowlist"))).toBe(true);
    expect(
      storedNetworkWidens(set("allowlist", ["a.com"]), set("allowlist", ["a.com", "b.com"])),
    ).toBe(true);
    expect(
      storedNetworkWidens(set("allowlist", ["a.com", "b.com"]), set("allowlist", ["a.com"])),
    ).toBe(false);
    expect(storedNetworkWidens(set("allowlist"), set("allowlist", ["a.com"]))).toBe(false);
  });
});

describe("networkNarrowingRevokes", () => {
  const scope = (network: Record<string, unknown>) =>
    ({ profile: "full-access", filesystem: { kind: "scoped" }, network }) as never;
  const row = (granted: string[]) => ({ method: "exec" as const, granted_hosts: granted });
  it("allowlist to a smaller allowlist revokes work naming a removed host; a still-grantable granted host survives", () => {
    const next = {
      box: { networkMode: "allowlist" as const, hosts: ["a.com"] },
      hostCeiling: { kind: "any" as const, excluded: [] },
    };
    const removed = scope({ kind: "allowlist", hosts: ["a.com", "b.com"] });
    expect(networkNarrowingRevokes(next, removed, row([]))).toBe(true);
    expect(networkNarrowingRevokes(next, removed, row(["b.com"]))).toBe(false);
    // a granted host the new per-call ceiling no longer allows goes too
    const hard = { ...next, hostCeiling: { kind: "hosts" as const, hosts: ["a.com"] } };
    expect(networkNarrowingRevokes(hard, removed, row(["b.com"]))).toBe(true);
    expect(
      networkNarrowingRevokes(next, scope({ kind: "allowlist", hosts: ["a.com"] }), row([])),
    ).toBe(false);
    expect(networkNarrowingRevokes(next, scope({ kind: "open-public" }), row([]))).toBe(true);
  });
  it("an open network revokes nothing", () => {
    const open = {
      box: { networkMode: "open" as const, hosts: [] },
      hostCeiling: { kind: "any" as const, excluded: [] },
    };
    expect(networkNarrowingRevokes(open, scope({ kind: "open-public" }), row([]))).toBe(false);
  });
});
