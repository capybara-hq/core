import type { SandboxTier } from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import { KernelConfigSchema } from "../../src/config/schema.js";
import { invalidStoredSandboxTier } from "../../src/orgs/settings.service.js";
import {
  baseSandboxEgress,
  type DeploymentSandboxPolicy,
  effectiveSandboxPolicy,
  limitsForTier,
  networkForTier,
  type OrgSandboxSettings,
} from "../../src/sandbox/tiers.js";

const L = ["registry.npmjs.org", "example.com"];
const D = ["registry.npmjs.org", "crates.io"];

const deployment = (
  tiers: Partial<DeploymentSandboxPolicy["tiers"]> = {},
  egress: "none" | "allowlist" = "allowlist",
): DeploymentSandboxPolicy => ({
  limits: { egress, allowHosts: L, devHosts: D },
  tiers: { max: "dev", default: "dev", allowUnsandboxed: true, ...tiers },
});

const NO_ORG: OrgSandboxSettings = {};

describe("config: sandbox.tiers and sandbox.limits", () => {
  const base = {
    db: { url: "postgres://x/y" },
    redis: { url: "redis://x" },
    masterKey: Buffer.alloc(32, 7).toString("base64"),
  };

  it("defaults: max dev, default dev, unsandboxed allowed, devHosts the SDK preset, egress allowlist", () => {
    const c = KernelConfigSchema.parse(base);
    expect(c.sandbox.tiers).toEqual({ max: "dev", default: "dev", allowUnsandboxed: true });
    expect(c.sandbox.limits.egress).toBe("allowlist");
    expect(c.sandbox.limits.devHosts).toContain("registry.npmjs.org");
  });

  it('refuses egress "open" with a pointer to sandbox.tiers.max', () => {
    const r = KernelConfigSchema.safeParse({ ...base, sandbox: { limits: { egress: "open" } } });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toContain('sandbox.tiers.max to "open"');
  });

  it("refuses a default above max and an invalid dev host", () => {
    const high = KernelConfigSchema.safeParse({
      ...base,
      sandbox: { tiers: { max: "strict", default: "dev" } },
    });
    expect(high.success).toBe(false);
    expect(high.error?.issues[0]?.message).toContain("sandbox.tiers.default");
    const host = KernelConfigSchema.safeParse({
      ...base,
      sandbox: { limits: { devHosts: ["10.0.0.1"] } },
    });
    expect(host.success).toBe(false);
    expect(
      KernelConfigSchema.safeParse({ ...base, sandbox: { tiers: { max: "open", default: "dev" } } })
        .success,
    ).toBe(true);
  });
});

describe("networkForTier (spec §4.2 table)", () => {
  const allow = { egress: "allowlist" as const, allowHosts: L };
  const none = { egress: "none" as const, allowHosts: [] };

  it.each<[string, typeof allow | typeof none, SandboxTier, unknown]>([
    ["none strict", none, "strict", { egress: "none", allowHosts: [] }],
    ["none dev", none, "dev", { egress: "none", allowHosts: [] }],
    ["none open", none, "open", { egress: "none", allowHosts: [] }],
    ["allowlist strict", allow, "strict", { egress: "allowlist", allowHosts: L }],
    [
      "allowlist dev (L ∪ D, deduped)",
      allow,
      "dev",
      { egress: "allowlist", allowHosts: ["registry.npmjs.org", "example.com", "crates.io"] },
    ],
    ["allowlist open", allow, "open", { egress: "open", allowHosts: [] }],
  ])("%s", (_name, base, tier, expected) => {
    expect(networkForTier(base, D, tier)).toEqual(expected);
  });

  it("baseSandboxEgress: org or platform none is none; the org's hosts replace the platform's", () => {
    const dep = { egress: "allowlist" as const, allowHosts: L };
    expect(baseSandboxEgress(dep, undefined)).toEqual({ egress: "allowlist", allowHosts: L });
    expect(baseSandboxEgress(dep, { mode: "none" })).toEqual({ egress: "none", allowHosts: [] });
    expect(baseSandboxEgress({ ...dep, egress: "none" }, { mode: "allowlist" })).toEqual({
      egress: "none",
      allowHosts: [],
    });
    expect(baseSandboxEgress(dep, { mode: "allowlist" })).toEqual(dep);
    expect(baseSandboxEgress(dep, { mode: "allowlist", allowHosts: ["a.com"] })).toEqual({
      egress: "allowlist",
      allowHosts: ["a.com"],
    });
  });
});

describe("effectiveSandboxPolicy", () => {
  it("defaults: a device with no tier gets the platform default dev with L ∪ D", () => {
    expect(effectiveSandboxPolicy(deployment(), NO_ORG, null)).toEqual({
      tier: "dev",
      ceiling: "dev",
      defaultTier: "dev",
      cappedBy: null,
      egress: "allowlist",
      allowHosts: ["registry.npmjs.org", "example.com", "crates.io"],
      base: { egress: "allowlist", allowHosts: L },
      devHosts: D,
      allowUnsandboxed: false,
    });
  });

  type Row = [
    name: string,
    platform: Partial<DeploymentSandboxPolicy["tiers"]>,
    org: OrgSandboxSettings["sandboxTier"],
    device: SandboxTier | null,
    expected: {
      tier: SandboxTier;
      ceiling: SandboxTier;
      defaultTier: SandboxTier;
      cappedBy: unknown;
    },
  ];
  it.each<Row>([
    [
      "device strict under dev",
      {},
      undefined,
      "strict",
      { tier: "strict", ceiling: "dev", defaultTier: "dev", cappedBy: null },
    ],
    [
      "device open capped by the platform",
      {},
      undefined,
      "open",
      { tier: "dev", ceiling: "dev", defaultTier: "dev", cappedBy: "platform" },
    ],
    [
      "device open capped by the org",
      { max: "open" },
      { max: "dev" },
      "open",
      { tier: "dev", ceiling: "dev", defaultTier: "dev", cappedBy: "org" },
    ],
    [
      "device open under open ceilings",
      { max: "open" },
      undefined,
      "open",
      { tier: "open", ceiling: "open", defaultTier: "dev", cappedBy: null },
    ],
    [
      "org max above the platform is cut to the platform (platform caps)",
      { max: "dev" },
      { max: "open" },
      "open",
      { tier: "dev", ceiling: "dev", defaultTier: "dev", cappedBy: "platform" },
    ],
    [
      "equal org and platform max: the platform caps",
      { max: "dev" },
      { max: "dev" },
      "open",
      { tier: "dev", ceiling: "dev", defaultTier: "dev", cappedBy: "platform" },
    ],
    [
      "org default strict",
      { max: "open" },
      { default: "strict" },
      null,
      { tier: "strict", ceiling: "open", defaultTier: "strict", cappedBy: null },
    ],
    [
      "org default open under an org max dev: default cut, capped by the org",
      { max: "open" },
      { max: "dev", default: "open" },
      null,
      { tier: "dev", ceiling: "dev", defaultTier: "dev", cappedBy: "org" },
    ],
    [
      "platform default above a stored org max: capped by the org",
      { max: "open", default: "open" },
      { max: "strict" },
      null,
      { tier: "strict", ceiling: "strict", defaultTier: "strict", cappedBy: "org" },
    ],
    [
      "platform lowered its max below a stored org default",
      { max: "strict", default: "strict" },
      { default: "dev" },
      null,
      { tier: "strict", ceiling: "strict", defaultTier: "strict", cappedBy: "platform" },
    ],
    [
      "device dev under org open",
      { max: "open" },
      { max: "open", default: "open" },
      "dev",
      { tier: "dev", ceiling: "open", defaultTier: "open", cappedBy: null },
    ],
  ])("%s", (_name, platform, sandboxTier, device, expected) => {
    const p = effectiveSandboxPolicy(
      deployment(platform),
      sandboxTier === undefined ? NO_ORG : { sandboxTier },
      device,
    );
    expect({
      tier: p.tier,
      ceiling: p.ceiling,
      defaultTier: p.defaultTier,
      cappedBy: p.cappedBy,
    }).toEqual(expected);
  });

  it("the network follows the effective tier; egress none (org or platform) is none in every tier", () => {
    const open = deployment({ max: "open" });
    expect(effectiveSandboxPolicy(open, NO_ORG, "open")).toMatchObject({
      egress: "open",
      allowHosts: [],
    });
    expect(effectiveSandboxPolicy(open, NO_ORG, "strict")).toMatchObject({
      egress: "allowlist",
      allowHosts: L,
    });
    for (const tier of ["strict", "dev", "open"] as const) {
      expect(effectiveSandboxPolicy(open, { sandboxEgress: { mode: "none" } }, tier)).toMatchObject(
        { tier, egress: "none", allowHosts: [] },
      );
      expect(
        effectiveSandboxPolicy(deployment({ max: "open" }, "none"), NO_ORG, tier),
      ).toMatchObject({ tier, egress: "none", allowHosts: [] });
    }
    // the org's allowlist replaces L; dev adds D to it
    expect(
      effectiveSandboxPolicy(
        open,
        { sandboxEgress: { mode: "allowlist", allowHosts: ["a.com"] } },
        "dev",
      ),
    ).toMatchObject({ egress: "allowlist", allowHosts: ["a.com", ...D] });
  });

  it("limitsForTier gives another tier's network under the same policy (the ceiling's for local exec)", () => {
    const p = effectiveSandboxPolicy(deployment({ max: "open" }), NO_ORG, "strict");
    expect(limitsForTier(p, p.ceiling)).toEqual({ egress: "open", allowHosts: [] });
    expect(limitsForTier(p, "dev")).toEqual({
      egress: "allowlist",
      allowHosts: ["registry.npmjs.org", "example.com", "crates.io"],
    });
    expect(limitsForTier(p, "strict")).toEqual({ egress: "allowlist", allowHosts: L });
  });

  it("allowUnsandboxed needs the platform, the org (absent follows the platform) and an open ceiling", () => {
    const open = deployment({ max: "open" });
    expect(effectiveSandboxPolicy(open, NO_ORG, null).allowUnsandboxed).toBe(true);
    expect(
      effectiveSandboxPolicy(open, { sandboxTier: { allowUnsandboxed: false } }, null)
        .allowUnsandboxed,
    ).toBe(false);
    expect(
      effectiveSandboxPolicy(deployment({ max: "open", allowUnsandboxed: false }), NO_ORG, null)
        .allowUnsandboxed,
    ).toBe(false);
    expect(
      effectiveSandboxPolicy(
        deployment({ max: "open", allowUnsandboxed: false }),
        { sandboxTier: { allowUnsandboxed: true } },
        null,
      ).allowUnsandboxed,
    ).toBe(false);
    expect(
      effectiveSandboxPolicy(open, { sandboxTier: { max: "dev" } }, null).allowUnsandboxed,
    ).toBe(false);
    expect(effectiveSandboxPolicy(deployment(), NO_ORG, null).allowUnsandboxed).toBe(false);
    // the device's own tier does not matter: the ceiling does
    expect(effectiveSandboxPolicy(open, NO_ORG, "strict").allowUnsandboxed).toBe(true);
  });
});

describe("invalidStoredSandboxTier (the lenient read warns)", () => {
  it("is true only for a stored sandboxTier this version cannot read", () => {
    expect(invalidStoredSandboxTier({})).toBe(false);
    expect(invalidStoredSandboxTier({ sandboxTier: { max: "dev" } })).toBe(false);
    expect(invalidStoredSandboxTier({ sandboxTier: { max: "everything" } })).toBe(true);
    expect(invalidStoredSandboxTier({ sandboxTier: "open" })).toBe(true);
  });
});
