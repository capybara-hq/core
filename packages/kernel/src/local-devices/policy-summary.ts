import {
  type DeviceFeature,
  type DeviceLocalPolicySummary,
  isSandboxTier,
  type SandboxTier,
} from "@capybara-hq/plugin-sdk";

const KNOWN_FEATURES: readonly DeviceFeature[] = [
  "networkReport",
  "policyOp",
  "policyOpId",
  "tiers",
];

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
  if (o.tier !== undefined && !isSandboxTier(o.tier)) return null;
  if (!isSandboxTier(o.effectiveTier)) return null;
  if (o.isolation !== "sandbox" && o.isolation !== "none") return null;
  if (o.localhost !== "on" && o.localhost !== "off-proxy-detected" && o.localhost !== "off") {
    return null;
  }
  if (o.unixSockets !== "roots" && o.unixSockets !== "all-masked" && o.unixSockets !== "off") {
    return null;
  }
  if (o.remoteGrants !== "owner" && o.remoteGrants !== "off") return null;
  if (!Array.isArray(o.allowedDomains)) return null;
  if (!o.allowedDomains.every((d): d is string => typeof d === "string")) return null;
  return {
    ...(o.tier !== undefined && { tier: o.tier }),
    effectiveTier: o.effectiveTier,
    isolation: o.isolation,
    localhost: o.localhost,
    unixSockets: o.unixSockets,
    allowedDomains: [...o.allowedDomains],
    remoteGrants: o.remoteGrants,
  };
}

/**
 * The isolation a policy summary states, read from its `isolation` field alone (a hello's raw
 * `policy` or the stored column), so a summary the kernel cannot otherwise read (a newer program's
 * new value elsewhere, a broken one) still tells whether commands run without a sandbox: `sandbox`
 * only when it says exactly that, `none` for any other present summary (fail closed), null when
 * there is none.
 */
export function isolationOf(v: unknown): "sandbox" | "none" | null {
  if (v === undefined || v === null) return null;
  if (typeof v === "object" && !Array.isArray(v)) {
    return (v as { isolation?: unknown }).isolation === "sandbox" ? "sandbox" : "none";
  }
  return "none";
}

/**
 * What changed between two local policy summaries, in the owner's terms (the device page's change
 * list, sandbox dev tiers spec §10.4): hosts added to and removed from the allowlist, the chosen
 * tier (`null`: follows the org's default), the localhost access, the isolation and whether the
 * machine accepts the platform's changes. Facts the owner does not set (the effective tier, unix
 * sockets) are left out. Each field is present only when it changed.
 */
export interface LocalPolicyDiff {
  add: string[];
  remove: string[];
  tier?: { from: SandboxTier | null; to: SandboxTier | null };
  localhost?: DeviceLocalPolicySummary["localhost"];
  isolation?: DeviceLocalPolicySummary["isolation"];
  remoteGrants?: DeviceLocalPolicySummary["remoteGrants"];
}

/** The {@link LocalPolicyDiff} from `prev` to `next`; null when nothing the owner sets changed. */
export function localPolicyDiff(
  prev: DeviceLocalPolicySummary,
  next: DeviceLocalPolicySummary,
): LocalPolicyDiff | null {
  const before = new Set(prev.allowedDomains);
  const after = new Set(next.allowedDomains);
  const d: LocalPolicyDiff = {
    add: [...after].filter((h) => !before.has(h)).sort(),
    remove: [...before].filter((h) => !after.has(h)).sort(),
  };
  const fromTier = prev.tier ?? null;
  const toTier = next.tier ?? null;
  if (fromTier !== toTier) d.tier = { from: fromTier, to: toTier };
  if (prev.localhost !== next.localhost) d.localhost = next.localhost;
  if (prev.isolation !== next.isolation) d.isolation = next.isolation;
  if (prev.remoteGrants !== next.remoteGrants) d.remoteGrants = next.remoteGrants;
  const changed =
    d.add.length > 0 ||
    d.remove.length > 0 ||
    d.tier !== undefined ||
    d.localhost !== undefined ||
    d.isolation !== undefined ||
    d.remoteGrants !== undefined;
  return changed ? d : null;
}

/** Who asked for a `policy` op: the deciding account, where, and the network ask it answers. */
export interface PolicyOpSource {
  accountId: string;
  via: "web" | "im";
  approvalId: string | null;
}

/** What the machine reported of an op after its answer was lost (its hello's `recentOps`). */
export interface ReportedPolicyOp {
  /** `absent`: not in the hello's outcomes although the op can no longer reach the machine. */
  outcome: "applied" | "refused" | "absent";
}

/**
 * The intent of a `policy` op the platform sends to a machine (transactional outbox spec §7), kept
 * on the machine's row (`pending_policy_ops`) from before the op is sent until its outcome is
 * recorded: the change asked for, who asked, and until when (epoch ms) a summary the machine
 * reports by itself may still be that op's. `sent`: on its way or in flight, the
 * `device-op-resolve` job owed for `resolveAt`; `unknown`: no answer came, and only the machine's
 * next hello (`recentOps`) or a later `policyStatus` can tell what became of it.
 */
export interface PendingPolicyOp {
  id: string;
  add: string[];
  remove: string[];
  /** Present when the op set the tier (null: follow the org's default). */
  tier?: SandboxTier | null;
  isolation?: "sandbox";
  source: PolicyOpSource;
  actorTokenId?: string;
  status: "sent" | "unknown";
  /** When the intent was written (epoch ms). */
  sentAt: number;
  /** From when the op can no longer reach the machine (epoch ms): the resolve job's `runAt`. */
  resolveAt: number;
  until: number;
  /** Set by a hello that reported the op's outcome (or its absence) before the op was resolved. */
  reported?: ReportedPolicyOp;
}

/** The pending ops stored on a machine row (malformed entries dropped). */
export function pendingPolicyOpsOf(v: unknown): PendingPolicyOp[] {
  if (!Array.isArray(v)) return [];
  const hosts = (x: unknown) =>
    Array.isArray(x) ? x.filter((h): h is string => typeof h === "string") : [];
  const out: PendingPolicyOp[] = [];
  for (const e of v) {
    if (typeof e !== "object" || e === null) continue;
    const o = e as Record<string, unknown>;
    if (typeof o.id !== "string" || typeof o.until !== "number") continue;
    if (typeof o.sentAt !== "number" || typeof o.resolveAt !== "number") continue;
    if (o.status !== "sent" && o.status !== "unknown") continue;
    const src = o.source as Record<string, unknown> | null | undefined;
    if (typeof src !== "object" || src === null || typeof src.accountId !== "string") continue;
    if (src.via !== "web" && src.via !== "im") continue;
    const rep = o.reported as Record<string, unknown> | null | undefined;
    const outcome = typeof rep === "object" && rep !== null ? rep.outcome : undefined;
    const reported: ReportedPolicyOp | undefined =
      outcome === "applied" || outcome === "refused" || outcome === "absent"
        ? { outcome }
        : undefined;
    out.push({
      id: o.id,
      add: hosts(o.add),
      remove: hosts(o.remove),
      ...("tier" in o && { tier: isSandboxTier(o.tier) ? o.tier : null }),
      ...(o.isolation === "sandbox" && { isolation: "sandbox" as const }),
      source: {
        accountId: src.accountId,
        via: src.via,
        approvalId: typeof src.approvalId === "string" ? src.approvalId : null,
      },
      ...(typeof o.actorTokenId === "string" && { actorTokenId: o.actorTokenId }),
      status: o.status,
      sentAt: o.sentAt,
      resolveAt: o.resolveAt,
      until: o.until,
      ...(reported !== undefined && { reported }),
    });
  }
  return out;
}

/**
 * Whether `diff` is what the platform's `op` did (its answer, or the machine's own report of it
 * before the answer was recorded): hosts within the op's, the tier the op set, and only what a
 * tier change moves with it (the isolation back to `sandbox`, the localhost access). The device
 * page then lists the change once, as the platform's.
 */
export function opExplains(op: PendingPolicyOp, diff: LocalPolicyDiff): boolean {
  if (!diff.add.every((h) => op.add.includes(h))) return false;
  if (!diff.remove.every((h) => op.remove.includes(h))) return false;
  if (diff.tier !== undefined && (op.tier === undefined || diff.tier.to !== op.tier)) return false;
  if (diff.isolation !== undefined && op.isolation === undefined && op.tier === undefined) {
    return false;
  }
  if (diff.localhost !== undefined && op.tier === undefined) return false;
  return diff.remoteGrants === undefined;
}
