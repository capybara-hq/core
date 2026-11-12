import { isSandboxTier, minTier, type SandboxTier, tierAtMost } from "@capybara-hq/plugin-sdk";
import type { KernelConfig } from "../config/schema.js";
import type { KernelSchemaDb } from "../db/kernel-schema.js";
import type { OrgSettings } from "../orgs/settings.service.js";
import { type PlatformTiers, readPlatformTiers } from "./platform-tiers.js";

/**
 * Sandbox tiers (sandbox dev tiers spec §4): who may reach which tier, and the network each tier
 * gets. One function, {@link effectiveSandboxPolicy}, combines the platform's ceiling and default
 * (`sandbox.tiers`), the org's (`sandboxTier`) and the device's own choice.
 */

/**
 * What the policy reads of the platform: the `sandbox.limits` network fields and the effective
 * platform tiers (`readPlatformTiers`: the startup config over the admin console's choice).
 */
export interface DeploymentSandboxPolicy {
  limits: Pick<KernelConfig["sandbox"]["limits"], "egress" | "allowHosts" | "devHosts">;
  tiers: PlatformTiers;
}

/**
 * The platform side of the policy, read live: the `sandbox.limits` network fields of the config
 * and the effective platform tiers (in the caller's transaction when there is one).
 */
export async function readDeploymentSandboxPolicy(
  db: KernelSchemaDb,
  config: { get(): Pick<KernelConfig, "sandbox"> },
): Promise<DeploymentSandboxPolicy> {
  return { limits: config.get().sandbox.limits, tiers: await readPlatformTiers(db, config) };
}

/** The org settings the policy reads. */
export type OrgSandboxSettings = Pick<OrgSettings, "sandboxEgress" | "sandboxTier">;

/**
 * The org's base list `L` (spec §3): `none` when the org's or the platform's egress is `none`,
 * else an allowlist of the org's hosts (the platform's `allowHosts` when the org gives none).
 * Network requests and approvals add to this list; tiers widen it (§4.2).
 */
export interface BaseSandboxEgress {
  egress: "none" | "allowlist";
  allowHosts: string[];
}

/** The network of one tier: what a cloud instance is created with, or a local exec's ceiling. */
export interface SandboxNetwork {
  egress: "none" | "allowlist" | "open";
  allowHosts: string[];
}

/** The effective sandbox policy of one device (or of a new device, with no tier of its own). */
export interface EffectiveSandboxPolicy extends SandboxNetwork {
  /** min(device tier ?? the org's default, the org's ceiling, the platform's ceiling). */
  tier: SandboxTier;
  /** min(org max, platform max): the highest tier a device of the org may reach. */
  ceiling: SandboxTier;
  /** The org's default tier (the platform's when the org sets none), at most {@link ceiling}. */
  defaultTier: SandboxTier;
  /** Which ceiling cut the chosen tier (the device's, else the org's default), null when none did. */
  cappedBy: "org" | "platform" | null;
  /** The base list `L` the tiers widen. */
  base: BaseSandboxEgress;
  /** The dev hosts `D` (`sandbox.limits.devHosts`). */
  devHosts: string[];
  /** Whether a local device may run unsandboxed: platform and org allow it and the ceiling is open. */
  allowUnsandboxed: boolean;
}

/** The org's base list `L`: see {@link BaseSandboxEgress}. */
export function baseSandboxEgress(
  deployment: Pick<DeploymentSandboxPolicy["limits"], "egress" | "allowHosts">,
  org: OrgSettings["sandboxEgress"],
): BaseSandboxEgress {
  if (deployment.egress === "none" || org?.mode === "none")
    return { egress: "none", allowHosts: [] };
  return { egress: "allowlist", allowHosts: [...(org?.allowHosts ?? deployment.allowHosts)] };
}

/**
 * The network of `tier` over the base list (spec §4.2): `none` stays `none` in every tier; an
 * allowlist is `L` in strict, `L ∪ D` in dev and open egress in open.
 */
export function networkForTier(
  base: BaseSandboxEgress,
  devHosts: readonly string[],
  tier: SandboxTier,
): SandboxNetwork {
  if (base.egress === "none") return { egress: "none", allowHosts: [] };
  if (tier === "open") return { egress: "open", allowHosts: [] };
  if (tier === "dev") {
    return { egress: "allowlist", allowHosts: [...new Set([...base.allowHosts, ...devHosts])] };
  }
  return { egress: "allowlist", allowHosts: [...base.allowHosts] };
}

/** The network of `tier` under `policy` (e.g. the ceiling's for a local device's exec args). */
export function limitsForTier(policy: EffectiveSandboxPolicy, tier: SandboxTier): SandboxNetwork {
  return networkForTier(policy.base, policy.devHosts, tier);
}

/**
 * The effective sandbox policy (spec §4.2). `deviceTier` is the device's own choice (null =
 * follow the org's default). The org's ceiling is its `sandboxTier.max` (absent = the platform's)
 * cut to the platform's; its default is `sandboxTier.default ?? sandbox.tiers.default`, cut to the
 * ceiling. Stored values above the platform (the platform lowered its max later) are cut, never
 * honoured.
 */
export function effectiveSandboxPolicy(
  deployment: DeploymentSandboxPolicy,
  org: OrgSandboxSettings,
  deviceTier: SandboxTier | null,
): EffectiveSandboxPolicy {
  const platformMax = deployment.tiers.max;
  const orgMax = org.sandboxTier?.max ?? platformMax;
  const ceiling = minTier(orgMax, platformMax);
  const chosenDefault = org.sandboxTier?.default ?? deployment.tiers.default;
  const defaultTier = minTier(chosenDefault, ceiling);
  const chosen = deviceTier ?? chosenDefault;
  const tier = minTier(chosen, ceiling);
  // the platform caps when its max is the lowest ceiling (an org max at or above it cuts nothing)
  const cappedBy: EffectiveSandboxPolicy["cappedBy"] =
    tier === chosen ? null : tierAtMost(platformMax, orgMax) ? "platform" : "org";
  const base = baseSandboxEgress(deployment.limits, org.sandboxEgress);
  const devHosts = [...deployment.limits.devHosts];
  return {
    tier,
    ceiling,
    defaultTier,
    cappedBy,
    ...networkForTier(base, devHosts, tier),
    base,
    devHosts,
    allowUnsandboxed:
      deployment.tiers.allowUnsandboxed &&
      (org.sandboxTier?.allowUnsandboxed ?? true) &&
      ceiling === "open",
  };
}

/**
 * What decides whether a running cloud instance must change (spec §7.1): its tier and egress
 * mode only. `allowHosts`, cpu, memory and disk reach instances created afterwards.
 */
export interface AppliedLimits {
  tier: SandboxTier;
  egress: SandboxNetwork["egress"];
}

/** The {@link AppliedLimits} of `limits`. */
export const appliedOf = (limits: AppliedLimits): AppliedLimits => ({
  tier: limits.tier,
  egress: limits.egress,
});

/** Whether `a` and `b` are the same tier and egress mode (null, unknown, is never the same). */
export const sameApplied = (a: AppliedLimits | null | undefined, b: AppliedLimits): boolean =>
  a != null && a.tier === b.tier && a.egress === b.egress;

const EGRESS_MODES: readonly string[] = ["none", "allowlist", "open"];

function appliedFrom(v: unknown): AppliedLimits | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  if (!isSandboxTier(o.tier) || typeof o.egress !== "string" || !EGRESS_MODES.includes(o.egress)) {
    return null;
  }
  return { tier: o.tier, egress: o.egress as AppliedLimits["egress"] };
}

/**
 * `device_instances.instance_limits` read leniently: `applied` is what the instance runs with
 * (null: unknown, e.g. an instance made before migration 0117, which differs from every effective
 * value); `unapplied` is a newer value the provider could not apply without a file reset.
 */
export function readInstanceLimits(v: unknown): {
  applied: AppliedLimits | null;
  unapplied: AppliedLimits | null;
} {
  if (typeof v !== "object" || v === null) return { applied: null, unapplied: null };
  return {
    applied: appliedFrom(v),
    unapplied: appliedFrom((v as { unapplied?: unknown }).unapplied),
  };
}

/** The JSON written to `device_instances.instance_limits`. */
export function instanceLimitsJson(
  applied: AppliedLimits | null,
  unapplied?: AppliedLimits,
): string | null {
  if (applied === null && unapplied === undefined) return null;
  return JSON.stringify({
    ...(applied !== null && appliedOf(applied)),
    ...(unapplied !== undefined && { unapplied: appliedOf(unapplied) }),
  });
}
