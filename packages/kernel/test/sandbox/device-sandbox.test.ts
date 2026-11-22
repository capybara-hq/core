import type { PermissionProfile } from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import {
  type ConsentReach,
  type DeviceSandboxDeviceLayer,
  type DeviceSandboxOrgLayer,
  type DeviceSandboxPlatformLayer,
  type DeviceSandboxProviderLayer,
  deviceListAddRefusal,
  effectiveDeviceSandbox,
  hostGrantable,
  hostGrantCeiling,
  hostGrantRefusal,
  orgHostsOf,
  providerLayerOf,
  reachWithin,
} from "../../src/sandbox/device-sandbox.js";
import {
  intersectPermissionScope,
  type PermissionScopeFacts,
  sandboxNetworkOf,
} from "../../src/sandbox/operation-authority.js";
import { ownNetwork } from "../../src/sandbox/permission-facts.js";

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

/** The device layer: the device's stored network choice, the same for every provider. */
const device = (over: Partial<DeviceSandboxDeviceLayer> = {}): DeviceSandboxDeviceLayer => ({
  networkMode: null,
  networkHosts: [],
  ...over,
});

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
  it("defaults: open network, outside allowed where the provider's support allows it", () => {
    expect(effectiveDeviceSandbox(platform(), NO_ORG, device(), operation)).toEqual({
      boundary: "operation",
      networkMode: "open",
      networkCeiling: "open",
      hosts: [],
      outsideSandbox: true,
      perCallHosts: true,
      layer: { network: null, outsideSandbox: null },
    });
  });

  it.each<[string, DeviceSandboxPlatformLayer, DeviceSandboxOrgLayer, string | null]>([
    ["platform off", platform({ outsideSandbox: "off" }), NO_ORG, "platform"],
    ["org off", platform(), { outsideSandbox: "off" }, "org"],
  ])("outside the sandbox: %s names its layer", (_, p, o, layer) => {
    const box = effectiveDeviceSandbox(p, o, device(), operation);
    expect(box.outsideSandbox).toBe(false);
    expect(box.layer.outsideSandbox).toBe(layer);
  });

  it("outside the sandbox follows the provider's support, whatever the provider; an instance boundary never has it", () => {
    expect(
      effectiveDeviceSandbox(platform(), NO_ORG, device(), { ...operation, outsideSandbox: false })
        .layer.outsideSandbox,
    ).toBe("provider");
    expect(effectiveDeviceSandbox(platform(), NO_ORG, device(), operation).outsideSandbox).toBe(
      true,
    );
    expect(
      effectiveDeviceSandbox(platform(), NO_ORG, device(), instance).layer.outsideSandbox,
    ).toBe("provider");
    expect(
      effectiveDeviceSandbox(platform(), NO_ORG, device(), { ...instance, outsideSandbox: true })
        .outsideSandbox,
    ).toBe(false);
  });

  it("the network ceiling is the narrower of the platform's and the org's, and clamps the mode", () => {
    const p = effectiveDeviceSandbox(
      platform({ ceiling: "allowlist" }),
      NO_ORG,
      device(),
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
      device({ networkMode: "open" }),
      instance,
    );
    expect([o.networkCeiling, o.networkMode, o.layer.network]).toEqual([
      "allowlist",
      "allowlist",
      "org",
    ]);
  });

  it("the kill switch closes the network everywhere", () => {
    const box = effectiveDeviceSandbox(platform({ egress: "none" }), NO_ORG, device(), operation);
    expect([box.networkCeiling, box.networkMode, box.hosts]).toEqual(["none", "none", []]);
  });

  it("mode: the device's choice, else the org default, else the platform default", () => {
    expect(
      effectiveDeviceSandbox(platform({ default: "allowlist" }), NO_ORG, device(), instance)
        .networkMode,
    ).toBe("allowlist");
    expect(
      effectiveDeviceSandbox(
        platform({ default: "allowlist" }),
        { deviceNetwork: { default: "open" } },
        device(),
        instance,
      ).networkMode,
    ).toBe("open");
    expect(
      effectiveDeviceSandbox(
        platform(),
        { deviceNetwork: { default: "open" } },
        device({ networkMode: "allowlist" }),
        instance,
      ).networkMode,
    ).toBe("allowlist");
    expect(
      effectiveDeviceSandbox(platform(), NO_ORG, device({ networkMode: "allowlist" }), operation)
        .layer.network,
    ).toBeNull();
  });

  it("a device host list only narrows the org's hosts; an empty one adds no narrowing", () => {
    const own = effectiveDeviceSandbox(
      platform(),
      NO_ORG,
      device({ networkMode: "allowlist", networkHosts: ["example.com", "evil.test"] }),
      operation,
    );
    expect(own.hosts).toEqual(["example.com"]);
    const none = effectiveDeviceSandbox(
      platform(),
      NO_ORG,
      device({ networkMode: "allowlist", networkHosts: [] }),
      instance,
    );
    expect(none.hosts).toEqual(HOSTS);
    const org = effectiveDeviceSandbox(
      platform(),
      { deviceNetwork: { base: "none", extraHosts: ["api.test"] } },
      device({ networkMode: "allowlist", networkHosts: ["api.test", "example.com"] }),
      instance,
    );
    expect(org.hosts).toEqual(["api.test"]);
  });

  it("a provider that cannot enforce the open network clamps it to the allowlist", () => {
    const box = effectiveDeviceSandbox(platform(), NO_ORG, device(), {
      ...instance,
      network: { openPublic: false, allowlist: true, perOperationHosts: false },
    });
    expect([box.networkMode, box.layer.network]).toEqual(["allowlist", "provider"]);
  });

  it("the provider layer is its support; with none known, the same layer for every provider", () => {
    // no crossing: the networks open to the device's choice, no per-call host, nothing outside
    expect(providerLayerOf(null)).toEqual({
      boundary: "instance",
      network: { openPublic: true, allowlist: true, perOperationHosts: false },
      outsideSandbox: false,
    });
    expect(
      providerLayerOf({
        version: 2,
        boundary: "instance",
        restricted: null,
        network: { openPublic: false, allowlist: true, perOperationHosts: false },
        outsideSandbox: false,
        background: true,
      }),
    ).toEqual({
      boundary: "instance",
      network: { openPublic: false, allowlist: true, perOperationHosts: false },
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
  projectRoot: "/work",
  writeRoots: ["/work"],
  allowedHosts: [],
  network: "none",
  boundary: "operation",
  outsideSandboxCeiling: true,
  ...over,
});

const PROFILES: PermissionProfile[] = ["request-approval", "approve-for-me", "full-access"];

describe("admission: the sandbox is the same under every profile", () => {
  // profile × boundary × network mode → scope; the Full access rows are scoped too
  const rows = PROFILES.flatMap((profile) =>
    (["operation", "instance"] as const).flatMap((boundary) =>
      (["open", "allowlist", "none"] as const).map(
        (mode) =>
          [profile, boundary, mode] as [PermissionProfile, "operation" | "instance", typeof mode],
      ),
    ),
  );
  it.each(rows)(
    "%s on an %s-boundary device with a %s network is scoped",
    (profile, boundary, mode) => {
      const box = effectiveDeviceSandbox(
        platform({ egress: mode === "none" ? "none" : "allowlist" }),
        NO_ORG,
        device({ networkMode: mode === "allowlist" ? "allowlist" : "open" }),
        boundary === "operation" ? operation : instance,
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
      if (boundary === "instance") {
        // the instance is the sandbox: its whole filesystem, never outside
        expect(scope.filesystem).toEqual({
          kind: "scoped",
          projectRoot: "/work",
          writeRoots: ["/", "/work"],
        });
        expect(box.outsideSandbox).toBe(false);
      } else
        expect(scope.filesystem).toEqual({
          kind: "scoped",
          projectRoot: "/work",
          writeRoots: ["/work"],
        });
    },
  );

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
    const box = effectiveDeviceSandbox(platform(), NO_ORG, device(), instance);
    expect(sandboxNetworkOf(box, { kind: "open-public" })).toBe("open-public");
    expect(sandboxNetworkOf(box, { kind: "allowlist", hosts: ["example.com"] })).toBe("allowlist");
    expect(sandboxNetworkOf(box, { kind: "none" })).toBe("none");
    expect(sandboxNetworkOf(box, { kind: "host-environment" })).toBe("open-public");
  });
});

describe("a device's own allowlist", () => {
  it("is the same for every provider: an empty one follows the org's hosts", () => {
    for (const provider of [operation, instance]) {
      const box = effectiveDeviceSandbox(
        platform(),
        NO_ORG,
        device({ networkMode: "allowlist", networkHosts: [] }),
        provider,
      );
      expect([box.networkMode, box.hosts]).toEqual(["allowlist", HOSTS]);
    }
  });

  it("every device follows the org default when its mode is null", () => {
    const org: DeviceSandboxOrgLayer = {
      deviceNetwork: { default: "allowlist", extraHosts: ["api.test"] },
    };
    for (const provider of [operation, instance]) {
      const box = effectiveDeviceSandbox(platform(), org, device(), provider);
      expect(box.networkMode).toBe("allowlist");
      expect(box.hosts).toEqual(orgHostsOf(platform(), org));
    }
  });
});

describe("deviceListAddRefusal", () => {
  const LIST = (allowHosts: string[], orgHosts: "extend" | "within" = "extend") =>
    ({ egress: "allowlist", allowHosts, orgHosts }) as const;
  const ALLOWLIST_BOX = {
    networkMode: "allowlist",
    networkCeiling: "open",
    layer: { network: null, outsideSandbox: null },
  } as const;

  it("null for a host within the org's hosts", () => {
    expect(deviceListAddRefusal("a.dev", ALLOWLIST_BOX, LIST(["a.dev"]), {})).toBeNull();
    expect(deviceListAddRefusal("A.Dev", ALLOWLIST_BOX, LIST(["a.dev"]), {})).toBeNull();
    expect(deviceListAddRefusal("x.a.dev", ALLOWLIST_BOX, LIST(["*.a.dev"]), {})).toBeNull();
    // an org extra is within the org's hosts too
    expect(
      deviceListAddRefusal("api.test", ALLOWLIST_BOX, LIST(["a.dev"]), {
        deviceNetwork: { extraHosts: ["api.test"] },
      }),
    ).toBeNull();
    // the device's own list narrows any mode, so an open device may keep one ready
    expect(
      deviceListAddRefusal("a.dev", { ...ALLOWLIST_BOX, networkMode: "open" }, LIST(["a.dev"]), {}),
    ).toBeNull();
  });

  it("names the org admin for a host outside the org's hosts", () => {
    expect(deviceListAddRefusal("x.dev", ALLOWLIST_BOX, LIST(["a.dev"]), {})).toBe(
      "an organization admin adds x.dev to the organization's device network list",
    );
    // under an org allowlist ceiling the list still only narrows the org's hosts
    expect(
      deviceListAddRefusal(
        "x.dev",
        {
          ...ALLOWLIST_BOX,
          networkCeiling: "allowlist",
          layer: { network: "org", outsideSandbox: null },
        },
        LIST(["a.dev"]),
        { deviceNetwork: { ceiling: "allowlist" } },
      ),
    ).toMatch(/organization admin adds x\.dev/);
  });

  it("names the super admin when only the platform's list could cover the host", () => {
    expect(deviceListAddRefusal("x.dev", ALLOWLIST_BOX, LIST(["a.dev"], "within"), {})).toBe(
      "x.dev is outside the platform's host list; a super admin adds the host",
    );
    // within the platform's list, the org admin can bring it back (exclusion or base none)
    expect(
      deviceListAddRefusal("a.dev", ALLOWLIST_BOX, LIST(["a.dev"], "within"), {
        deviceNetwork: { base: "none" },
      }),
    ).toMatch(/organization admin adds a\.dev/);
  });

  // exclusions drop platform entries only (orgEffectiveHosts): never an extra, nothing under base none
  it("an org extra kept in the org's hosts is addable whatever the exclusions say", () => {
    expect(
      deviceListAddRefusal("api.corp.com", ALLOWLIST_BOX, LIST(["*.corp.com"]), {
        deviceNetwork: { excludedHosts: ["*.corp.com"], extraHosts: ["api.corp.com"] },
      }),
    ).toBeNull();
    // the excluded platform wildcard still refuses its other subdomains
    expect(
      deviceListAddRefusal("db.corp.com", ALLOWLIST_BOX, LIST(["*.corp.com"]), {
        deviceNetwork: { excludedHosts: ["*.corp.com"], extraHosts: ["api.corp.com"] },
      }),
    ).toBe("the organization excludes db.corp.com; an organization admin removes the exclusion");
    expect(
      deviceListAddRefusal("a.dev", ALLOWLIST_BOX, LIST(["b.dev"]), {
        deviceNetwork: { base: "none", extraHosts: ["a.dev"], excludedHosts: ["a.dev"] },
      }),
    ).toBeNull();
    // under within, an extra the platform list does not cover is dropped, so not addable
    expect(
      deviceListAddRefusal("x.dev", ALLOWLIST_BOX, LIST(["a.dev"], "within"), {
        deviceNetwork: { extraHosts: ["x.dev"] },
      }),
    ).toMatch(/super admin adds the host/);
  });

  it("an excluded host or a closed network is refused", () => {
    expect(
      deviceListAddRefusal("a.dev", ALLOWLIST_BOX, LIST(["a.dev"]), {
        deviceNetwork: { excludedHosts: ["a.dev"] },
      }),
    ).toBe("the organization excludes a.dev; an organization admin removes the exclusion");
    // an exclusion is a pattern: it refuses a host a wider platform entry still covers
    expect(
      deviceListAddRefusal("x.a.dev", ALLOWLIST_BOX, LIST(["*.a.dev"]), {
        deviceNetwork: { excludedHosts: ["x.a.dev"] },
      }),
    ).not.toBeNull();
    expect(
      deviceListAddRefusal("a.dev", { ...ALLOWLIST_BOX, networkMode: "none" }, LIST(["a.dev"]), {}),
    ).toBe("network access is turned off for this device's sandbox");
    expect(
      deviceListAddRefusal(
        "a.dev",
        ALLOWLIST_BOX,
        { egress: "none", allowHosts: ["a.dev"], orgHosts: "extend" },
        {},
      ),
    ).toMatch(/turned off/);
  });
});

describe("the per-call host grant ceiling", () => {
  const box = (networkCeiling: "open" | "allowlist" = "open") => ({
    boundary: "operation" as const,
    networkMode: "allowlist" as const,
    networkCeiling,
  });
  const lim = (orgHosts: "extend" | "within" = "extend") => ({
    egress: "allowlist" as const,
    allowHosts: HOSTS,
    orgHosts,
  });

  it("an allowlist network ceiling is hard: only the org's effective hosts, under every profile", () => {
    const org = {
      deviceNetwork: { ceiling: "allowlist" as const, excludedHosts: ["example.com"] },
    };
    const ceiling = hostGrantCeiling(box("allowlist"), lim(), org);
    expect(ceiling).toEqual({ kind: "hosts", hosts: ["registry.npmjs.org"] });
    expect(hostGrantRefusal("api.test", box("allowlist"), lim(), org)).toBe(
      "an organization admin adds api.test to the organization's device network list",
    );
    expect(hostGrantRefusal("registry.npmjs.org", box("allowlist"), lim(), org)).toBeNull();
  });

  it("an open ceiling bounds grants by the kernel only, minus the org's exclusions", () => {
    const org = { deviceNetwork: { excludedHosts: ["example.com"] } };
    expect(hostGrantable(hostGrantCeiling(box(), lim(), org), "api.test")).toBe(true);
    expect(hostGrantable(hostGrantCeiling(box(), lim(), org), "example.com")).toBe(false);
    expect(hostGrantRefusal("example.com", box(), lim(), org)).toMatch(
      /organization admin adds example.com/,
    );
  });

  // R3 final review m1: an exclusion is a pattern, like an allowlist entry
  it("an excluded wildcard refuses every subdomain, never the apex", () => {
    const org = { deviceNetwork: { excludedHosts: ["*.Example.com"] } };
    const open = hostGrantCeiling(box(), lim(), org);
    expect(hostGrantable(open, "api.example.com")).toBe(false);
    expect(hostGrantable(open, "a.b.example.com")).toBe(false);
    expect(hostGrantable(open, "example.com")).toBe(true);
    expect(hostGrantRefusal("api.example.com", box(), lim(), org)).toMatch(
      /organization admin adds api.example.com/,
    );
  });

  it("within keeps grants inside the org's effective hosts; base none removes the platform list", () => {
    expect(hostGrantRefusal("api.test", box(), lim("within"), {})).toBe(
      "api.test is outside the platform's host list; a super admin adds the host",
    );
    const none = { deviceNetwork: { base: "none" as const, extraHosts: ["example.com"] } };
    expect(hostGrantCeiling(box(), lim("within"), none)).toEqual({
      kind: "hosts",
      hosts: ["example.com"],
    });
  });

  it("an instance boundary or a closed network grants nothing", () => {
    expect(hostGrantCeiling({ ...box(), boundary: "instance" }, lim(), {})).toEqual({
      kind: "hosts",
      hosts: [],
    });
    expect(hostGrantCeiling({ ...box(), networkMode: "none" }, lim(), {})).toEqual({
      kind: "hosts",
      hosts: [],
    });
  });

  // spec §6.3: `perOperationHosts` gates per-call host grants, not the boundary alone
  it("an operation boundary whose provider lacks perOperationHosts grants no host per call", () => {
    const layer = { ...operation, network: { ...operation.network, perOperationHosts: false } };
    const sandbox = effectiveDeviceSandbox(platform(), NO_ORG, device(), layer);
    expect(sandbox.boundary).toBe("operation");
    expect(sandbox.perCallHosts).toBe(false);
    // running outside the sandbox is a separate dimension: the provider still allows it
    expect(sandbox.outsideSandbox).toBe(true);
    expect(hostGrantCeiling(sandbox, lim(), {})).toEqual({ kind: "hosts", hosts: [] });
    expect(hostGrantRefusal("api.test", sandbox, lim(), {})).toBe(
      "a host cannot be granted per call on this device; add api.test to the device's network list",
    );
    const withHosts = effectiveDeviceSandbox(platform(), NO_ORG, device(), operation);
    expect(withHosts.perCallHosts).toBe(true);
    expect(hostGrantCeiling(withHosts, lim(), {}).kind).toBe("any");
    expect(effectiveDeviceSandbox(platform(), NO_ORG, device(), instance).perCallHosts).toBe(false);
  });
});

describe("a closed device network", () => {
  it("network_mode none is no network; a device without a choice follows its org", () => {
    expect(
      effectiveDeviceSandbox(platform(), NO_ORG, device({ networkMode: "none" }), instance)
        .networkMode,
    ).toBe("none");
    expect(ownNetwork({ network_mode: "none", network_hosts: [] })).toEqual({
      networkMode: "none",
      networkHosts: [],
    });
    expect(ownNetwork({ network_mode: null, network_hosts: [] })).toEqual({
      networkMode: null,
      networkHosts: [],
    });
  });
});

describe("the Full access consent reach", () => {
  const reach = (over: Partial<ConsentReach> = {}): ConsentReach => ({
    outsideSandbox: true,
    networkCeiling: "open",
    networkMode: "open",
    hostCeiling: { kind: "any", excluded: [] },
    ...over,
  });
  it("a narrowing stays within the consent; a widening of any dimension does not", () => {
    const wide = reach();
    for (const narrow of [
      reach({ outsideSandbox: false }),
      reach({ networkMode: "allowlist" }),
      reach({ networkCeiling: "allowlist", networkMode: "allowlist" }),
      reach({ hostCeiling: { kind: "any", excluded: ["a.test"] } }),
      reach({ hostCeiling: { kind: "hosts", hosts: ["a.test"] } }),
    ])
      expect(reachWithin(narrow, wide)).toBe(true);
    const narrowest = reach({
      outsideSandbox: false,
      networkMode: "allowlist",
      hostCeiling: { kind: "hosts", hosts: ["a.test"] },
    });
    for (const widened of [
      reach({ networkMode: "allowlist", hostCeiling: { kind: "hosts", hosts: ["a.test"] } }),
      reach({ outsideSandbox: false, hostCeiling: { kind: "hosts", hosts: ["a.test"] } }),
      reach({
        outsideSandbox: false,
        networkMode: "allowlist",
        hostCeiling: { kind: "hosts", hosts: ["a.test", "b.test"] },
      }),
      reach({ outsideSandbox: false, networkMode: "allowlist" }),
    ])
      expect(reachWithin(widened, narrowest)).toBe(false);
    // an exclusion removed widens; a wildcard covering an excluded host is wider
    expect(
      reachWithin(
        reach({ hostCeiling: { kind: "any", excluded: [] } }),
        reach({ hostCeiling: { kind: "any", excluded: ["a.test"] } }),
      ),
    ).toBe(false);
    expect(
      reachWithin(
        reach({ hostCeiling: { kind: "hosts", hosts: ["*.test"] } }),
        reach({ hostCeiling: { kind: "any", excluded: ["a.test"] } }),
      ),
    ).toBe(false);
    // an excluded wildcard narrowed to one of its hosts widens; widened to cover it narrows
    expect(
      reachWithin(
        reach({ hostCeiling: { kind: "any", excluded: ["api.test"] } }),
        reach({ hostCeiling: { kind: "any", excluded: ["*.test"] } }),
      ),
    ).toBe(false);
    expect(
      reachWithin(
        reach({ hostCeiling: { kind: "any", excluded: ["*.test"] } }),
        reach({ hostCeiling: { kind: "any", excluded: ["api.test"] } }),
      ),
    ).toBe(true);
    // an owner list that keeps its exclusion stays within; dropping the exclusion widens
    const kept = { kind: "hosts" as const, hosts: ["*.other.test"], excluded: ["bad.other.test"] };
    expect(reachWithin(reach({ hostCeiling: kept }), reach({ hostCeiling: kept }))).toBe(true);
    expect(
      reachWithin(
        reach({ hostCeiling: { kind: "hosts", hosts: ["*.other.test"] } }),
        reach({ hostCeiling: kept }),
      ),
    ).toBe(false);
  });
});
