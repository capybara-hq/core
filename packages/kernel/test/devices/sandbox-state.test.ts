import type { DeviceLocalPolicySummary, SandboxTier } from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import { sandboxStateOf, tierWidens } from "../../src/devices/devices.service.js";
import { effectiveSandboxPolicy } from "../../src/sandbox/tiers.js";

/** A device's sandbox level on its page and for the model (sandbox dev tiers spec §4, §11). */

const deployment = (max: SandboxTier) => ({
  limits: { egress: "allowlist" as const, allowHosts: ["pypi.org"], devHosts: ["github.com"] },
  tiers: { max, default: "dev" as const, allowUnsandboxed: true },
});
const policyOf = (max: SandboxTier) => (tier: SandboxTier | null) =>
  effectiveSandboxPolicy(deployment(max), {}, tier);

const summary = (s: Partial<DeviceLocalPolicySummary>): DeviceLocalPolicySummary => ({
  effectiveTier: "strict",
  isolation: "sandbox",
  localhost: "on",
  unixSockets: "roots",
  allowedDomains: [],
  remoteGrants: "owner",
  ...s,
});

describe("sandboxStateOf", () => {
  it("a cloud device: its stored tier under the ceiling", () => {
    expect(
      sandboxStateOf(policyOf("dev"), {
        source: "cloud",
        tier: "open",
        features: [],
        policy: null,
      }),
    ).toEqual({
      tier: "open",
      effectiveTier: "dev",
      ceiling: "dev",
      cappedBy: "platform",
      defaultTier: "dev",
      allowUnsandboxed: false,
      isolation: "sandbox",
    });
  });

  it("a local device: its reported tier; unsandboxed only when it runs open", () => {
    const local = (policy: DeviceLocalPolicySummary | null, features = ["tiers" as const]) => ({
      source: "local" as const,
      tier: null,
      features,
      policy,
    });
    const none = summary({ tier: "open", isolation: "none" });
    expect(sandboxStateOf(policyOf("open"), local(none))).toMatchObject({
      tier: "open",
      effectiveTier: "open",
      allowUnsandboxed: true,
      isolation: "none",
    });
    // cut to dev by the platform: the device keeps its sandbox
    expect(sandboxStateOf(policyOf("dev"), local(none))).toMatchObject({
      effectiveTier: "dev",
      cappedBy: "platform",
      isolation: "sandbox",
    });
    // a program without the tiers feature runs strict, whatever it reports
    expect(sandboxStateOf(policyOf("open"), local(none, []))).toMatchObject({
      effectiveTier: "strict",
      cappedBy: null,
      isolation: "sandbox",
    });
    // no summary: follows the org's default
    expect(sandboxStateOf(policyOf("open"), local(null))).toMatchObject({
      tier: null,
      effectiveTier: "dev",
    });
  });
});

describe("tierWidens (as the machine judges a policy op)", () => {
  it("strict and no change never widen; a higher tier or an unknown local one may", () => {
    expect(tierWidens(undefined, undefined)).toBe(false);
    expect(tierWidens(undefined, "strict")).toBe(false);
    expect(tierWidens("dev", "strict")).toBe(false);
    expect(tierWidens("dev", "dev")).toBe(false);
    expect(tierWidens("dev", "open")).toBe(true);
    expect(tierWidens(undefined, "dev")).toBe(true);
    expect(tierWidens("open", null)).toBe(false);
    expect(tierWidens("dev", null)).toBe(true);
    expect(tierWidens(undefined, null)).toBe(false);
  });
});
