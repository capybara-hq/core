import type { DeviceFeature, DeviceLocalPolicySummary } from "@capybara-hq/plugin-sdk";

const KNOWN_FEATURES: readonly DeviceFeature[] = ["networkReport", "policyOp"];

/**
 * The known features in `v` (a hello's `features` or the stored column), in a fixed order and
 * deduped; anything else (unknown names, a non-array) is dropped.
 */
export function deviceFeaturesOf(v: unknown): DeviceFeature[] {
  if (!Array.isArray(v)) return [];
  return KNOWN_FEATURES.filter((f) => v.includes(f));
}

/**
 * `v` as a local policy summary (network ask-to-allow spec §5.4), or null when it is absent or not
 * a valid one. The device is the authority on its policy: the kernel only keeps what it last said,
 * for the device page and to pick a card's options, never to decide what a command may reach.
 */
export function localPolicyOf(v: unknown): DeviceLocalPolicySummary | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (o.network !== "allowlist" && o.network !== "open") return null;
  if (o.remoteGrants !== "owner" && o.remoteGrants !== "off") return null;
  if (!Array.isArray(o.allowedDomains)) return null;
  if (!o.allowedDomains.every((d): d is string => typeof d === "string")) return null;
  return {
    network: o.network,
    allowedDomains: [...o.allowedDomains],
    remoteGrants: o.remoteGrants,
  };
}
