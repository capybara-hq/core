import { describe, expect, it } from "vitest";
import {
  appliedOf,
  type DeploymentDevicePolicy,
  deviceNetwork,
  type EffectiveDevicePolicy,
  effectiveDevicePolicy,
  instanceLimitsJson,
  type OrgDeviceSettings,
  orgSandboxNetwork,
  readInstanceLimits,
  sameApplied,
} from "../../src/sandbox/modes.js";

const L = ["registry.npmjs.org", "example.com"];

const deployment = (
  autoMode: DeploymentDevicePolicy["autoMode"] = "allowed",
  egress: "none" | "allowlist" = "allowlist",
): DeploymentDevicePolicy => ({ autoMode, limits: { egress, allowHosts: L } });

const NO_ORG: OrgDeviceSettings = {};

describe("effectiveDevicePolicy", () => {
  it("defaults: auto mode, the open public cloud network, and the deployment allowlist locally", () => {
    expect(effectiveDevicePolicy(deployment(), NO_ORG, null)).toEqual({
      mode: "auto",
      allowedMode: "auto",
      modeSource: "platform",
      network: { kind: "open-public", hosts: [] },
      localAllowedDomains: L,
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
        modeSource: "platform",
        network: { kind: "open-public", hosts: [] },
        localAllowedDomains: L,
      },
    ],
    [
      "the org turned auto mode off",
      deployment(),
      { autoMode: "off" },
      "auto",
      {
        mode: "sandbox",
        allowedMode: "sandbox",
        modeSource: "org",
        network: { kind: "open-public", hosts: [] },
        localAllowedDomains: L,
      },
    ],
    [
      "the org has auto mode explicitly allowed",
      deployment(),
      { autoMode: "allowed" },
      null,
      {
        mode: "auto",
        allowedMode: "auto",
        modeSource: "org",
        network: { kind: "open-public", hosts: [] },
        localAllowedDomains: L,
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
        modeSource: "device",
        network: { kind: "open-public", hosts: [] },
        localAllowedDomains: L,
      },
    ],
    [
      "the device reports auto mode while the org allows only sandbox",
      deployment(),
      { autoMode: "off" },
      "auto",
      {
        mode: "sandbox",
        allowedMode: "sandbox",
        modeSource: "org",
        network: { kind: "open-public", hosts: [] },
        localAllowedDomains: L,
      },
    ],
    [
      "the org's cloud network is the allowlist",
      deployment(),
      { cloudNetwork: { mode: "allowlist" } },
      null,
      {
        mode: "auto",
        allowedMode: "auto",
        modeSource: "platform",
        network: { kind: "open-public", hosts: [] },
        localAllowedDomains: L,
      },
    ],
    [
      "the org's cloud allowlist replaces the deployment's",
      deployment(),
      { cloudNetwork: { mode: "allowlist", allowHosts: ["a.com"] } },
      "sandbox",
      {
        mode: "sandbox",
        allowedMode: "auto",
        modeSource: "device",
        network: { kind: "allowlist", hosts: ["a.com"] },
        localAllowedDomains: ["a.com"],
      },
    ],
  ])("%s", (_name, dep, org, deviceMode, expected) => {
    expect(effectiveDevicePolicy(dep, org, deviceMode)).toEqual(expected);
  });

  it("the platform kill switch forces an empty allowlist, cloud and local (R20)", () => {
    const p = effectiveDevicePolicy(deployment("allowed", "none"), NO_ORG, "auto");
    expect(p.network).toEqual({ kind: "allowlist", hosts: [] });
    expect(p.localAllowedDomains).toEqual([]);
    // the org may not widen it back
    expect(
      effectiveDevicePolicy(
        deployment("allowed", "none"),
        {
          cloudNetwork: { mode: "open", allowHosts: ["a.com"] },
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
    expect(deviceNetwork(deployment(), { cloudNetwork: { mode: "allowlist" } }, "sandbox")).toEqual(
      { kind: "allowlist", hosts: L },
    );
    expect(
      deviceNetwork(
        deployment(),
        { cloudNetwork: { mode: "open", allowHosts: ["a.com"] } },
        "auto",
      ),
    ).toEqual({ kind: "open-public", hosts: [] });
  });

  it("orgSandboxNetwork: the org's choice over the deployment default", () => {
    const dep = { mode: "open" as const, allowHosts: L };
    expect(orgSandboxNetwork(dep, undefined)).toEqual({ kind: "open-public", hosts: [] });
    expect(orgSandboxNetwork(dep, { mode: "allowlist" })).toEqual({
      kind: "allowlist",
      hosts: L,
    });
    expect(orgSandboxNetwork(dep, { mode: "allowlist", allowHosts: ["a.com"] })).toEqual({
      kind: "allowlist",
      hosts: ["a.com"],
    });
    expect(orgSandboxNetwork({ mode: "allowlist", allowHosts: L }, undefined)).toEqual({
      kind: "allowlist",
      hosts: L,
    });
  });
});

describe("instance limits", () => {
  it("compares the mode and the network kind only; hosts reach the next create", () => {
    const a = appliedOf({
      mode: "auto",
      network: { kind: "open-public", hosts: [] },
    });
    const b = appliedOf({
      mode: "auto",
      network: { kind: "open-public", hosts: ["a.com"] },
    });
    expect(sameApplied(a, b)).toBe(true);
    expect(
      sameApplied(a, appliedOf({ mode: "sandbox", network: { kind: "open-public", hosts: [] } })),
    ).toBe(false);
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
