import type { PermissionProfile } from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import {
  type DeviceSandboxDeviceLayer,
  type DeviceSandboxOrgLayer,
  type DeviceSandboxPlatformLayer,
  type DeviceSandboxProviderLayer,
  effectiveDeviceSandbox,
  providerLayerOf,
} from "../../src/sandbox/device-sandbox.js";
import {
  intersectPermissionScope,
  type PermissionScopeFacts,
  sandboxNetworkOf,
} from "../../src/sandbox/operation-authority.js";

const HOSTS = ["example.com", "registry.npmjs.org"];

const platform = (
  over: Partial<DeviceSandboxPlatformLayer> & {
    outsideSandbox?: "allowed" | "off";
    ceiling?: "open" | "allowlist";
    default?: "open" | "allowlist";
  } = {},
): DeviceSandboxPlatformLayer => ({
  settings: {
    outsideSandbox: over.outsideSandbox ?? "allowed",
    network: { default: over.default ?? "open", ceiling: over.ceiling ?? "open" },
  },
  allowHosts: over.allowHosts ?? HOSTS,
  orgHosts: over.orgHosts ?? "extend",
  egress: over.egress ?? "allowlist",
});

const local = (over: Partial<Extract<DeviceSandboxDeviceLayer, { location: "local" }>> = {}) =>
  ({
    location: "local",
    outsideSandbox: true,
    network: "open",
    allowedDomains: [],
    restrictedProjectReach: "workspace",
    ...over,
  }) as const;
const cloud = (over: Partial<Extract<DeviceSandboxDeviceLayer, { location: "cloud" }>> = {}) =>
  ({ location: "cloud", networkMode: null, networkHosts: [], ...over }) as const;

const operation: DeviceSandboxProviderLayer = {
  boundary: "operation",
  network: { openPublic: true, allowlist: true, perOperationHosts: true },
  outsideSandbox: true,
};
const instance: DeviceSandboxProviderLayer = {
  boundary: "instance",
  network: { openPublic: true, allowlist: true, perOperationHosts: false },
  outsideSandbox: false,
};
const NO_ORG: DeviceSandboxOrgLayer = {};

describe("effectiveDeviceSandbox", () => {
  it("defaults: open network, outside allowed for a local owner who allows it", () => {
    expect(effectiveDeviceSandbox(platform(), NO_ORG, local(), operation)).toEqual({
      boundary: "operation",
      networkMode: "open",
      networkCeiling: "open",
      hosts: [],
      outsideSandbox: true,
      restrictedProjectReach: "workspace",
      layer: { network: null, outsideSandbox: null },
    });
  });

  it.each<[string, DeviceSandboxPlatformLayer, DeviceSandboxOrgLayer, string | null]>([
    ["platform off", platform({ outsideSandbox: "off" }), NO_ORG, "platform"],
    ["org off", platform(), { outsideSandbox: "off" }, "org"],
  ])("outside the sandbox: %s names its layer", (_, p, o, layer) => {
    const box = effectiveDeviceSandbox(p, o, local(), operation);
    expect(box.outsideSandbox).toBe(false);
    expect(box.layer.outsideSandbox).toBe(layer);
  });

  it("outside the sandbox needs the owner and the provider too; a cloud device never has it", () => {
    expect(
      effectiveDeviceSandbox(platform(), NO_ORG, local({ outsideSandbox: false }), operation).layer
        .outsideSandbox,
    ).toBe("device");
    expect(
      effectiveDeviceSandbox(platform(), NO_ORG, local(), { ...operation, outsideSandbox: false })
        .layer.outsideSandbox,
    ).toBe("provider");
    expect(effectiveDeviceSandbox(platform(), NO_ORG, cloud(), operation).outsideSandbox).toBe(
      false,
    );
    expect(effectiveDeviceSandbox(platform(), NO_ORG, cloud(), instance).layer.outsideSandbox).toBe(
      "provider",
    );
  });

  it("the network ceiling is the narrower of the platform's and the org's, and clamps the mode", () => {
    const p = effectiveDeviceSandbox(
      platform({ ceiling: "allowlist" }),
      NO_ORG,
      local(),
      operation,
    );
    expect([p.networkCeiling, p.networkMode, p.layer.network]).toEqual([
      "allowlist",
      "allowlist",
      "platform",
    ]);
    expect(p.hosts).toEqual(HOSTS);
    const o = effectiveDeviceSandbox(
      platform(),
      { deviceNetwork: { ceiling: "allowlist" } },
      cloud({ networkMode: "open" }),
      instance,
    );
    expect([o.networkCeiling, o.networkMode, o.layer.network]).toEqual([
      "allowlist",
      "allowlist",
      "org",
    ]);
  });

  it("the kill switch closes the network everywhere", () => {
    const box = effectiveDeviceSandbox(platform({ egress: "none" }), NO_ORG, local(), operation);
    expect([box.networkCeiling, box.networkMode, box.hosts]).toEqual(["none", "none", []]);
  });

  it("mode: the device's choice, else the org default, else the platform default", () => {
    expect(
      effectiveDeviceSandbox(platform({ default: "allowlist" }), NO_ORG, cloud(), instance)
        .networkMode,
    ).toBe("allowlist");
    expect(
      effectiveDeviceSandbox(
        platform({ default: "allowlist" }),
        { deviceNetwork: { default: "open" } },
        cloud(),
        instance,
      ).networkMode,
    ).toBe("open");
    expect(
      effectiveDeviceSandbox(
        platform(),
        { deviceNetwork: { default: "open" } },
        cloud({ networkMode: "allowlist" }),
        instance,
      ).networkMode,
    ).toBe("allowlist");
    expect(
      effectiveDeviceSandbox(platform(), NO_ORG, local({ network: "allowlist" }), operation).layer
        .network,
    ).toBe("device");
  });

  it("a device host list only narrows the org's hosts; an empty one adds no narrowing", () => {
    const own = effectiveDeviceSandbox(
      platform(),
      NO_ORG,
      local({ network: "allowlist", allowedDomains: ["example.com", "evil.test"] }),
      operation,
    );
    expect(own.hosts).toEqual(["example.com"]);
    const none = effectiveDeviceSandbox(
      platform(),
      NO_ORG,
      cloud({ networkMode: "allowlist", networkHosts: [] }),
      instance,
    );
    expect(none.hosts).toEqual(HOSTS);
    const org = effectiveDeviceSandbox(
      platform(),
      { deviceNetwork: { base: "none", extraHosts: ["api.test"] } },
      cloud({ networkMode: "allowlist", networkHosts: ["api.test", "example.com"] }),
      instance,
    );
    expect(org.hosts).toEqual(["api.test"]);
  });

  it("a provider that cannot enforce the open network clamps it to the allowlist", () => {
    const box = effectiveDeviceSandbox(platform(), NO_ORG, cloud(), {
      ...instance,
      network: { openPublic: false, allowlist: true, perOperationHosts: false },
    });
    expect([box.networkMode, box.layer.network]).toEqual(["allowlist", "provider"]);
  });

  it("project reach follows the owner within a platform and org that allow running outside", () => {
    const reach = local({ restrictedProjectReach: "os-user" });
    expect(
      effectiveDeviceSandbox(platform(), NO_ORG, reach, operation).restrictedProjectReach,
    ).toBe("os-user");
    expect(
      effectiveDeviceSandbox(platform(), { outsideSandbox: "off" }, reach, operation)
        .restrictedProjectReach,
    ).toBe("workspace");
  });

  it("before a report, a local device runs per operation and a cloud device's instance is the sandbox", () => {
    expect(providerLayerOf(null, "local").boundary).toBe("operation");
    expect(providerLayerOf(null, "cloud")).toMatchObject({
      boundary: "instance",
      outsideSandbox: false,
    });
  });
});

const facts = (over: Partial<PermissionScopeFacts>): PermissionScopeFacts => ({
  operationId: "00000000-0000-4000-8000-000000000001",
  admitBeforeMs: Date.now() + 30000,
  deviceId: "00000000-0000-4000-8000-000000000002",
  rootConversationId: "00000000-0000-4000-8000-000000000003",
  profileRevision: 1,
  ceilingRevision: "rev",
  profile: "request-approval",
  actor: {
    accountId: "00000000-0000-4000-8000-000000000004",
    conversationId: "00000000-0000-4000-8000-000000000003",
  },
  tag: "t",
  workingRoot: "/work",
  readRoots: ["/work"],
  writeRoots: ["/work"],
  allowedHosts: [],
  network: "none",
  boundary: "operation",
  outsideSandboxCeiling: true,
  ...over,
});

const PROFILES: PermissionProfile[] = ["request-approval", "approve-for-me", "full-access"];

describe("admission: the sandbox is the same under every profile", () => {
  // profile × local/cloud × network mode → scope; the Full access rows are scoped too
  const rows = PROFILES.flatMap((profile) =>
    (["local", "cloud"] as const).flatMap((location) =>
      (["open", "allowlist", "none"] as const).map(
        (mode) => [profile, location, mode] as [PermissionProfile, "local" | "cloud", typeof mode],
      ),
    ),
  );
  it.each(rows)("%s on a %s device with a %s network is scoped", (profile, location, mode) => {
    const box = effectiveDeviceSandbox(
      platform({ egress: mode === "none" ? "none" : "allowlist" }),
      NO_ORG,
      location === "local"
        ? local({ network: mode === "allowlist" ? "allowlist" : "open", allowedDomains: HOSTS })
        : cloud({ networkMode: mode === "allowlist" ? "allowlist" : "open" }),
      location === "local" ? operation : instance,
    );
    const network = sandboxNetworkOf(box, null);
    const scope = intersectPermissionScope(
      facts({
        profile,
        boundary: box.boundary,
        network,
        allowedHosts: network === "allowlist" ? box.hosts : [],
        outsideSandboxCeiling: box.outsideSandbox,
      }),
    );
    expect(scope.filesystem.kind).toBe("scoped");
    expect(scope.network.kind).toBe(
      mode === "open" ? "open-public" : mode === "allowlist" ? "allowlist" : "none",
    );
    if (location === "cloud") {
      // the instance is the sandbox: its whole filesystem, never outside
      expect(scope.filesystem).toEqual({
        kind: "scoped",
        readRoots: ["/", "/work"],
        writeRoots: ["/", "/work"],
      });
      expect(box.outsideSandbox).toBe(false);
    } else
      expect(scope.filesystem).toEqual({
        kind: "scoped",
        readRoots: ["/work"],
        writeRoots: ["/work"],
      });
  });

  it("only an escalated call within the outside-sandbox ceiling gets the device pair", () => {
    for (const profile of PROFILES) {
      const scope = intersectPermissionScope(facts({ profile, escalated: true }));
      expect([scope.filesystem.kind, scope.network.kind]).toEqual(["device", "environment"]);
      expect(() =>
        intersectPermissionScope(facts({ profile, escalated: true, outsideSandboxCeiling: false })),
      ).toThrow(/outside the sandbox/);
      expect(() =>
        intersectPermissionScope(facts({ profile, escalated: true, boundary: "instance" })),
      ).toThrow(/outside the sandbox/);
    }
  });

  it("an instance-boundary device keeps its base allowlist", () => {
    const scope = intersectPermissionScope(
      facts({ boundary: "instance", network: "allowlist", allowedHosts: ["example.com"] }),
    );
    expect(scope.network).toEqual({ kind: "allowlist", hosts: ["example.com"] });
  });
});

describe("sandboxNetworkOf", () => {
  it("an open network stays within a cloud instance's applied outer boundary", () => {
    const box = effectiveDeviceSandbox(platform(), NO_ORG, cloud(), instance);
    expect(sandboxNetworkOf(box, { kind: "open-public" })).toBe("open-public");
    expect(sandboxNetworkOf(box, { kind: "allowlist", hosts: ["example.com"] })).toBe("allowlist");
    expect(sandboxNetworkOf(box, { kind: "none" })).toBe("none");
    expect(sandboxNetworkOf(box, { kind: "host-environment" })).toBe("open-public");
  });
});

describe("a local owner's allowlist", () => {
  it("is the machine's ceiling: an empty one allows no host, as the device enforces it", () => {
    const box = effectiveDeviceSandbox(
      platform(),
      NO_ORG,
      local({ network: "allowlist", allowedDomains: [] }),
      operation,
    );
    expect([box.networkMode, box.hosts]).toEqual(["allowlist", []]);
  });
});
