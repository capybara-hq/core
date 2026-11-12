import { minTier, type SandboxTier, tierAtMost } from "@capybara-hq/plugin-sdk";
import type { KernelConfig } from "../config/schema.js";
import type { OrgSettings } from "../orgs/settings.service.js";

/**
 * Sandbox tiers (sandbox dev tiers spec §4): who may reach which tier, and the network each tier
 * gets. One function, {@link effectiveSandboxPolicy}, combines the platform's ceiling and default
 * (`sandbox.tiers`), the org's (`sandboxTier`) and the device's own choice.
 */

/** The deployment config the policy reads (`sandbox.limits` network fields and `sandbox.tiers`). */
export interface DeploymentSandboxPolicy {
  limits: Pick<KernelConfig["sandbox"]["limits"], "egress" | "allowHosts" | "devHosts">;
  tiers: KernelConfig["sandbox"]["tiers"];
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
