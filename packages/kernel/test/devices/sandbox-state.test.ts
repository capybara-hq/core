import { describe, expect, it } from "vitest";
import {
  networkNarrowingRevokes,
  sandboxViewOf,
  storedNetworkWidens,
} from "../../src/devices/devices.service.js";
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

/** An instance-boundary provider's support (a cloud provider). */
const INSTANCE = providerLayerOf({
  version: 2,
  boundary: "instance",
  restricted: null,
  network: { openPublic: true, allowlist: true, perOperationHosts: false },
  outsideSandbox: false,
  background: true,
});

const boxOf = (device: DeviceSandboxDeviceLayer, org: DeviceSandboxOrgLayer = {}, p = platform()) =>
  effectiveDeviceSandbox(p, org, device, INSTANCE);

describe("sandboxViewOf", () => {
  it("a cloud device following its org: the open network, no outside, nothing of its own", () => {
    const own = { networkMode: null, networkHosts: [] };
    expect(sandboxViewOf(boxOf({ ...own }), own, extra)).toEqual({
      network: "open",
      networkCeiling: "open",
      hosts: [],
      ownNetwork: null,
      allowedDomains: [],
      outsideSandbox: false,
      layer: { network: null, outsideSandbox: "provider" },
      ...extra,
    });
  });

  it("a cloud device's own list narrows the org's hosts; the org's ceiling names the org", () => {
    const own = { networkMode: "allowlist" as const, networkHosts: ["pypi.org", "evil.test"] };
    const view = sandboxViewOf(
      boxOf({ ...own }, { deviceNetwork: { ceiling: "allowlist" } }),
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
