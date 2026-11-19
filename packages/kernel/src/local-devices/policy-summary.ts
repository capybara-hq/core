import type {
  DeviceFeature,
  DeviceLocalPolicySummary,
  SandboxBrowseScope,
  SandboxOperationScope,
} from "@capybara-hq/plugin-sdk";
import { coversHost } from "../sandbox/modes.js";
import { isExecutionMethod, isFullExecutionScope } from "../sandbox/operation-authority-types.js";

const KNOWN_FEATURES: readonly DeviceFeature[] = [
  "networkReport",
  "policyOp",
  "policyOpId",
  "projects",
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
 * `v` as a local policy summary (auto mode spec §4.1), or null when it is absent or not a valid
 * one. The device is the authority on its policy: the kernel only keeps what it last said, for the
 * device page and the `device_paths` event, never to decide what a command may reach.
 */
export function localPolicyOf(v: unknown): DeviceLocalPolicySummary | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (!Array.isArray(o.allowedDomains)) return null;
  if (!o.allowedDomains.every((d): d is string => typeof d === "string")) return null;
  return { allowedDomains: [...o.allowedDomains] };
}

/**
 * What changed between two local policy summaries, in the owner's terms (the device page's change
 * list): hosts added to and removed from the allowlist. The owner ceiling's changes come from the
 * owner report.
 */
export interface LocalPolicyDiff {
  add: string[];
  remove: string[];
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
  return d.add.length > 0 || d.remove.length > 0 ? d : null;
}

/** Who asked for a `policy` op: the deciding account, where, and the network ask it answers. */
export interface PolicyOpSource {
  accountId: string;
  via: "web" | "im";
  approvalId: string | null;
}

/** What the machine reported of an op after its answer was lost (its hello's `recentOps`). */
export interface ReportedPolicyOp {
  /**
   * `absent`: not in the hello's outcomes although the op can no longer reach the machine;
   * `interrupted`: logged `started` only, and its change is not in the policy the hello reports
   * (one whose change is there is `applied`).
   */
  outcome: "applied" | "refused" | "absent" | "interrupted";
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
  /** Always empty for an op sent under protocol 4 (the platform never adds hosts). */
  add: string[];
  remove: string[];
  /**
   * The owner-ceiling narrowing the op asked the machine for: only `false` / `allowlist` /
   * `workspace` (the platform never widens). It explains the machine's own owner report of the
   * change.
   */
  ownerCeiling?: {
    outsideSandbox?: false;
    network?: "allowlist";
    restrictedProjectReach?: "workspace";
  };
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
      outcome === "applied" ||
      outcome === "refused" ||
      outcome === "absent" ||
      outcome === "interrupted"
        ? { outcome }
        : undefined;
    out.push({
      id: o.id,
      add: hosts(o.add),
      remove: hosts(o.remove),
      ...ownerNarrowingOf(o.ownerCeiling),
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
 * Whether the change of `op` is in `policy`: its hosts added and removed. Tells an op the machine
 * logged only as `started` (it stopped between the log and the answer) that was written from one
 * that was not.
 */
export function opVisibleIn(op: PendingPolicyOp, policy: DeviceLocalPolicySummary): boolean {
  if (!op.add.every((h) => policy.allowedDomains.includes(h))) return false;
  return !op.remove.some((h) => policy.allowedDomains.includes(h));
}

/** A stored op's owner narrowing: kept only while it narrows (anything wider is dropped). */
function ownerNarrowingOf(v: unknown): Pick<PendingPolicyOp, "ownerCeiling"> {
  if (typeof v !== "object" || v === null) return {};
  const o = v as Record<string, unknown>;
  const narrowing = {
    ...(o.outsideSandbox === false && { outsideSandbox: false as const }),
    ...(o.network === "allowlist" && { network: "allowlist" as const }),
    ...(o.restrictedProjectReach === "workspace" && {
      restrictedProjectReach: "workspace" as const,
    }),
  };
  return Object.keys(narrowing).length > 0 ? { ownerCeiling: narrowing } : {};
}

/**
 * Whether a v3 owner report's change from `before` to `after` is what the platform's `op` asked
 * for (the machine's own report of it, arriving before the op's answer): something changed, and
 * every changed fact is a narrowing the op carried, to the value it asked for. A widening is never
 * an op's.
 */
export function opExplainsOwnerChange(
  op: PendingPolicyOp,
  before: { fullAccess: boolean; restrictedProjectReach: "workspace" | "os-user" },
  after: { fullAccess: boolean; restrictedProjectReach: "workspace" | "os-user" },
): boolean {
  const fullChanged = before.fullAccess !== after.fullAccess;
  const reachChanged = before.restrictedProjectReach !== after.restrictedProjectReach;
  if (!fullChanged && !reachChanged) return false;
  if (fullChanged && (op.ownerCeiling?.outsideSandbox !== false || after.fullAccess)) return false;
  if (
    reachChanged &&
    (op.ownerCeiling?.restrictedProjectReach !== "workspace" ||
      after.restrictedProjectReach !== "workspace")
  )
    return false;
  return true;
}

/**
 * Whether `diff` is what the platform's `op` did (its answer, or the machine's own report of it
 * before the answer was recorded): hosts within the op's. The device page then lists the change
 * once, as the platform's.
 */
export function opExplains(op: PendingPolicyOp, diff: LocalPolicyDiff): boolean {
  if (!diff.add.every((h) => op.add.includes(h))) return false;
  return diff.remove.every((h) => op.remove.includes(h));
}

/**
 * Revoke only authority removed from a starting grant; explicit additions are not owner baseline.
 * The summary carries the sandbox allowlist only: the owner ceiling (outside the sandbox, the
 * reach) is revoked by the owner report's writer (`ownerReportRevokes`).
 */
export function ownerPolicyRevokes(
  next: DeviceLocalPolicySummary | null,
  scope: SandboxOperationScope | SandboxBrowseScope,
  method: string,
  grantedHosts: readonly string[],
): boolean {
  if (!next) return true;
  if (!("profile" in scope) || isFullExecutionScope(scope)) return false;
  if (!isExecutionMethod(method) || scope.network.kind !== "allowlist") return false;
  return scope.network.hosts.some(
    (host) =>
      !next.allowedDomains.some((pattern) => coversHost(pattern, host)) &&
      !grantedHosts.includes(host),
  );
}
