import { describe, expect, it } from "vitest";
import {
  appliedOf,
  appliedWider,
  type DeploymentDevicePolicy,
  deviceNetwork,
  type EffectiveDevicePolicy,
  effectiveDevicePolicy,
  instanceLimitsJson,
  type NetworkLimits,
  type OrgDeviceSettings,
  orgAllowedDomains,
  orgCloudMode,
  orgEffectiveHosts,
  orgHostOutsideCeiling,
  readInstanceLimits,
  sameApplied,
} from "../../src/sandbox/modes.js";

const L = ["registry.npmjs.org", "example.com"];

const deployment = (
  fullAccess: DeploymentDevicePolicy["fullAccess"] = "allowed",
  egress: "none" | "allowlist" = "allowlist",
  orgHosts: "extend" | "within" = "extend",
): DeploymentDevicePolicy => ({ fullAccess, limits: { egress, allowHosts: L, orgHosts } });

const NO_ORG: OrgDeviceSettings = {};

describe("effectiveDevicePolicy", () => {
  it("defaults: auto mode, the open public cloud network, and the deployment allowlist locally", () => {
    expect(effectiveDevicePolicy(deployment(), NO_ORG, null)).toEqual({
      mode: "auto",
      allowedMode: "auto",
      network: { kind: "open-public", hosts: [] },
    });
  });

  it.each<
    [
      string,
      DeploymentDevicePolicy,
      OrgDeviceSettings,
      "auto" | "sandbox" | null,
      EffectiveDevicePolicy,
    ]
  >([
    [
      "the platform turned auto mode off",
      deployment("off"),
      NO_ORG,
      null,
      {
        mode: "sandbox",
        allowedMode: "sandbox",
        network: { kind: "open-public", hosts: [] },
      },
    ],
    [
      "the org turned auto mode off",
      deployment(),
      { outsideSandbox: "off" },
      "auto",
      {
        mode: "sandbox",
        allowedMode: "sandbox",
        network: { kind: "open-public", hosts: [] },
      },
    ],
    [
      "the org has auto mode explicitly allowed",
      deployment(),
      { outsideSandbox: "allowed" },
      null,
      {
        mode: "auto",
        allowedMode: "auto",
        network: { kind: "open-public", hosts: [] },
      },
    ],
    [
      "the device chose sandbox mode",
      deployment(),
      NO_ORG,
      "sandbox",
      {
        mode: "sandbox",
        allowedMode: "auto",
        network: { kind: "open-public", hosts: [] },
      },
    ],
    [
      "the device reports auto mode while the org allows only sandbox",
      deployment(),
      { outsideSandbox: "off" },
      "auto",
      {
        mode: "sandbox",
        allowedMode: "sandbox",
        network: { kind: "open-public", hosts: [] },
      },
    ],
    [
      "the org's cloud network is the allowlist",
      deployment(),
      { deviceNetwork: { ceiling: "allowlist" } },
      null,
      {
        mode: "auto",
        allowedMode: "auto",
        network: { kind: "open-public", hosts: [] },
      },
    ],
    [
      "the org's cloud allowlist is its delta over the deployment's",
      deployment(),
      {
        deviceNetwork: {
          ceiling: "allowlist",
          extraHosts: ["a.com"],
          excludedHosts: ["example.com"],
        },
      },
      "sandbox",
      {
        mode: "sandbox",
        allowedMode: "auto",
        network: { kind: "allowlist", hosts: ["registry.npmjs.org", "a.com"] },
      },
    ],
    [
      "the org lists only its own hosts",
      deployment(),
      { deviceNetwork: { ceiling: "allowlist", base: "none", extraHosts: ["a.com"] } },
      "sandbox",
      {
        mode: "sandbox",
        allowedMode: "auto",
        network: { kind: "allowlist", hosts: ["a.com"] },
      },
    ],
  ])("%s", (_name, dep, org, deviceMode, expected) => {
    expect(effectiveDevicePolicy(dep, org, deviceMode)).toEqual(expected);
  });

  it("the platform kill switch forces an empty allowlist, cloud and local (R20)", () => {
    const p = effectiveDevicePolicy(deployment("allowed", "none"), NO_ORG, "auto");
    expect(p.network).toEqual({ kind: "allowlist", hosts: [] });
    expect(orgAllowedDomains(deployment("allowed", "none"), NO_ORG)).toEqual([]);
    // the org may not widen it back
    expect(
      effectiveDevicePolicy(
        deployment("allowed", "none"),
        {
          deviceNetwork: { default: "open", extraHosts: ["a.com"] },
        },
        null,
      ).network,
    ).toEqual({ kind: "allowlist", hosts: [] });
  });

  it("deviceNetwork: open only for auto mode under an open org network", () => {
    expect(deviceNetwork(deployment(), NO_ORG, "auto")).toEqual({
      kind: "open-public",
      hosts: [],
    });
    expect(deviceNetwork(deployment(), NO_ORG, "sandbox")).toEqual({
      kind: "open-public",
      hosts: [],
    });
    expect(
      deviceNetwork(deployment(), { deviceNetwork: { ceiling: "allowlist" } }, "sandbox"),
    ).toEqual({ kind: "allowlist", hosts: L });
    expect(
      deviceNetwork(
        deployment(),
        { deviceNetwork: { default: "open", extraHosts: ["a.com"] } },
        "auto",
      ),
    ).toEqual({ kind: "open-public", hosts: [] });
    // the platform ceiling makes sandbox mode's cloud network the allowlist, whatever the org says;
    // auto mode stays the open public network (devices.fullAccess governs it)
    expect(deviceNetwork(deployment("allowed", "allowlist", "within"), NO_ORG, "sandbox")).toEqual({
      kind: "allowlist",
      hosts: L,
    });
    expect(deviceNetwork(deployment("allowed", "allowlist", "within"), NO_ORG, "auto")).toEqual({
      kind: "open-public",
      hosts: [],
    });
  });
});

const limits = (
  orgHosts: "extend" | "within" = "extend",
  egress: "none" | "allowlist" = "allowlist",
  allowHosts: string[] = ["registry.npmjs.org", "*.example.com", "github.com"],
): NetworkLimits => ({ egress, allowHosts, orgHosts });

describe("orgEffectiveHosts", () => {
  it("follows the platform list when the org stores nothing", () => {
    expect(orgEffectiveHosts(limits(), undefined)).toEqual([
      "registry.npmjs.org",
      "*.example.com",
      "github.com",
    ]);
  });

  it("applies the org's delta: platform entries minus exclusions, then extras, deduped", () => {
    expect(
      orgEffectiveHosts(limits(), {
        excludedHosts: ["github.com", "not-on-the-platform.org"],
        extraHosts: ["pypi.org", "registry.npmjs.org"],
      }),
    ).toEqual(["registry.npmjs.org", "*.example.com", "pypi.org"]);
  });

  it("base none: only the org's own hosts", () => {
    expect(orgEffectiveHosts(limits(), { base: "none" })).toEqual([]);
    expect(
      orgEffectiveHosts(limits(), { base: "none", extraHosts: ["pypi.org"], excludedHosts: [] }),
    ).toEqual(["pypi.org"]);
  });

  it("a platform change reaches an org with a delta", () => {
    const org = { extraHosts: ["pypi.org"] };
    expect(orgEffectiveHosts(limits("extend", "allowlist", ["a.org"]), org)).toEqual([
      "a.org",
      "pypi.org",
    ]);
    expect(orgEffectiveHosts(limits("extend", "allowlist", ["b.org"]), org)).toEqual([
      "b.org",
      "pypi.org",
    ]);
  });

  it("the kill switch empties it", () => {
    expect(orgEffectiveHosts(limits("extend", "none"), { extraHosts: ["pypi.org"] })).toEqual([]);
  });

  it("within: extras outside the platform list are ignored, covered ones kept", () => {
    expect(
      orgEffectiveHosts(limits("within"), {
        base: "none",
        extraHosts: ["pypi.org", "api.example.com", "*.a.example.com", "github.com"],
      }),
    ).toEqual(["api.example.com", "*.a.example.com", "github.com"]);
    // `*.d` is not covered by `d`
    expect(
      orgEffectiveHosts(limits("within", "allowlist", ["example.com"]), {
        base: "none",
        extraHosts: ["*.example.com", "example.com"],
      }),
    ).toEqual(["example.com"]);
  });
});

describe("orgCloudMode", () => {
  it("the org's mode, open by default", () => {
    expect(orgCloudMode(limits(), undefined)).toBe("open");
    expect(orgCloudMode(limits(), { ceiling: "allowlist" })).toBe("allowlist");
  });

  it("the allowlist under the kill switch or the platform ceiling", () => {
    expect(orgCloudMode(limits("extend", "none"), { default: "open" })).toBe("allowlist");
    expect(orgCloudMode(limits("within"), { default: "open" })).toBe("allowlist");
    expect(orgCloudMode(limits("within"), undefined)).toBe("allowlist");
  });
});

describe("orgHostOutsideCeiling", () => {
  it("only under within, for hosts no platform entry covers", () => {
    expect(orgHostOutsideCeiling(limits(), "pypi.org")).toBe(false);
    expect(orgHostOutsideCeiling(limits("within"), "pypi.org")).toBe(true);
    expect(orgHostOutsideCeiling(limits("within"), "API.example.com")).toBe(false);
    expect(orgHostOutsideCeiling(limits("within"), "example.com")).toBe(true);
    expect(orgHostOutsideCeiling(limits("within"), "github.com")).toBe(false);
  });
});

describe("instance limits", () => {
  it("compares the network kind only, never the mode; hosts reach the next create", () => {
    const a = appliedOf({
      mode: "auto",
      network: { kind: "open-public", hosts: [] },
    });
    const b = appliedOf({
      mode: "auto",
      network: { kind: "open-public", hosts: ["a.com"] },
    });
    expect(sameApplied(a, b)).toBe(true);
    // the mode follows the outside-sandbox setting, which a cloud instance has no use for
    const sandboxMode = appliedOf({ mode: "sandbox", network: { kind: "open-public", hosts: [] } });
    expect(sameApplied(a, sandboxMode)).toBe(true);
    expect(appliedWider(a, sandboxMode)).toBe(false);
    expect(
      sameApplied(a, appliedOf({ mode: "auto", network: { kind: "allowlist", hosts: ["a.com"] } })),
    ).toBe(false);
    expect(sameApplied(null, a)).toBe(false);
  });

  it("round-trips its shape and reads an old tier record as unknown", () => {
    const applied = appliedOf({
      mode: "sandbox",
      network: { kind: "allowlist", hosts: ["a.com"] },
    });
    expect(readInstanceLimits(JSON.parse(instanceLimitsJson(applied) as string))).toEqual({
      applied,
      unapplied: null,
    });
    expect(readInstanceLimits(JSON.parse(instanceLimitsJson(null, applied) as string))).toEqual({
      applied: null,
      unapplied: applied,
    });
    expect(instanceLimitsJson(null)).toBeNull();
    // an instance made before auto mode recorded { tier, egress }: it differs from every value
    expect(readInstanceLimits({ tier: "open", egress: "open" })).toEqual({
      applied: null,
      unapplied: null,
    });
    expect(readInstanceLimits("nonsense")).toEqual({ applied: null, unapplied: null });
  });
});
