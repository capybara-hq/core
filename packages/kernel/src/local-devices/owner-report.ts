import {
  type DeviceOwnerCeiling,
  parseOwnerCeilingReport,
  type SandboxBrowseScope,
  type SandboxOperationScope,
} from "@capybara-hq/plugin-sdk";
import { coversHost } from "../sandbox/modes.js";
import { isExecutionMethod } from "../sandbox/operation-authority-types.js";
import { localModeOf, localPolicyOf } from "./policy-summary.js";

/** How far restricted (non-Full) operations and project browsing may reach on a machine. */
export type RestrictedProjectReach = "workspace" | "os-user";

/** Which message carried a report (audit and diagnostics only). */
export type OwnerReportVia = "hello" | "policy" | "policy-result" | "bind";

/**
 * The authenticated owner report kept on a machine row (`device_machines.owner_report`, B2): the
 * strict report, the connection and time it arrived, and a block set by an out-of-order report.
 */
export interface StoredOwnerReport {
  report: DeviceOwnerCeiling;
  connectionId: string | null;
  observedAt: string;
  via: OwnerReportVia;
  /** A later report arrived stale or conflicting: no new authority until a valid current one. */
  blocked?: { reason: "stale" | "conflict"; sequence: number; at: string };
}

/** The stored report in `v`, or null (absent or malformed: never trusted). */
export function storedOwnerReportOf(v: unknown): StoredOwnerReport | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  let report: DeviceOwnerCeiling;
  try {
    report = parseOwnerCeilingReport(o.report);
  } catch {
    return null;
  }
  if (typeof o.observedAt !== "string") return null;
  if (o.connectionId !== null && typeof o.connectionId !== "string") return null;
  if (!["hello", "policy", "policy-result", "bind"].includes(String(o.via))) return null;
  const b = o.blocked as Record<string, unknown> | undefined;
  return {
    report,
    connectionId: o.connectionId as string | null,
    observedAt: o.observedAt,
    via: o.via as OwnerReportVia,
    ...(b &&
      (b.reason === "stale" || b.reason === "conflict") &&
      typeof b.sequence === "number" &&
      typeof b.at === "string" && {
        blocked: { reason: b.reason, sequence: b.sequence, at: b.at },
      }),
  };
}

/**
 * What a newly arrived report means against the stored one: a higher sequence is recorded; the
 * same sequence, revision and bytes is idempotent; a lower sequence is stale; the same sequence
 * with other bytes is a protocol conflict.
 */
export function decideOwnerReport(
  stored: StoredOwnerReport | null,
  incoming: DeviceOwnerCeiling,
): "record" | "same" | "stale" | "conflict" {
  if (stored === null) return "record";
  const prev = stored.report;
  if (incoming.sequence > prev.sequence) return "record";
  if (incoming.sequence < prev.sequence) return "stale";
  return JSON.stringify(canonicalReport(incoming)) === JSON.stringify(canonicalReport(prev))
    ? "same"
    : "conflict";
}

const canonicalReport = (r: DeviceOwnerCeiling) => ({
  version: r.version,
  revision: r.revision,
  sequence: r.sequence,
  fullAccess: r.fullAccess,
  restrictedProjectReach: r.restrictedProjectReach,
  restrictedAllowedDomains: [...r.restrictedAllowedDomains],
});

/**
 * The owner facts the kernel decides with (B2), never inferred wider than reported:
 * - `report`: an authenticated version-2 report (Full and reach independent);
 * - `blocked`: a stale or conflicting report arrived: fail closed, admission refused;
 * - `legacy`: only a protocol 2 summary (the active wire until activation): its `mode` translates
 *   exactly (auto: Full + OS-user reach; sandbox: neither);
 * - `missing`: nothing readable: fail closed.
 */
export interface OwnerFacts {
  state: "report" | "blocked" | "legacy" | "missing";
  fullAccess: boolean;
  restrictedProjectReach: RestrictedProjectReach;
  restrictedAllowedDomains: string[];
  revision: string | null;
  sequence: number | null;
  observedAt: string | null;
}

const FAIL_CLOSED = {
  fullAccess: false,
  restrictedProjectReach: "workspace" as const,
  restrictedAllowedDomains: [],
};

/** The facts of a stored report alone (a successful record). */
export function ownerFactsOfReport(stored: StoredOwnerReport): OwnerFacts {
  if (stored.blocked)
    return {
      state: "blocked",
      ...FAIL_CLOSED,
      revision: stored.report.revision,
      sequence: stored.report.sequence,
      observedAt: stored.observedAt,
    };
  return {
    state: "report",
    fullAccess: stored.report.fullAccess,
    restrictedProjectReach: stored.report.restrictedProjectReach,
    restrictedAllowedDomains: [...stored.report.restrictedAllowedDomains],
    revision: stored.report.revision,
    sequence: stored.report.sequence,
    observedAt: stored.observedAt,
  };
}

/** A machine row's owner facts: its authenticated report, else its protocol 2 summary. */
export function ownerFactsOf(row: { owner_report?: unknown; local_policy?: unknown }): OwnerFacts {
  const stored = storedOwnerReportOf(row.owner_report);
  if (stored !== null) return ownerFactsOfReport(stored);
  const summary = localPolicyOf(row.local_policy);
  if (summary === null)
    return { state: "missing", ...FAIL_CLOSED, revision: null, sequence: null, observedAt: null };
  return {
    state: "legacy",
    fullAccess: summary.mode === "auto",
    restrictedProjectReach: summary.mode === "auto" ? "os-user" : "workspace",
    restrictedAllowedDomains: [...summary.allowedDomains],
    revision: null,
    sequence: null,
    observedAt: null,
  };
}

/** True when `path` lies in one of `roots` (absolute, normalized). */
const within = (path: string, root: string) =>
  root === "/" || path === root || path.startsWith(`${root}/`);

/**
 * The owner writer's selector (B2): what an owner-ceiling change takes from a running admission.
 * Full work loses only to Full being removed; broad browsing (`/`) and restricted roots outside
 * the machine's own roots lose only to the reach narrowing to the workspace; a restricted
 * execution loses a host only when no independent grant keeps it. A restricted-only change never
 * touches Full work, and a Full-only change never touches restricted work.
 */
export function ownerReportRevokes(
  next: OwnerFacts,
  scope: SandboxOperationScope | SandboxBrowseScope,
  method: string,
  grantedHosts: readonly string[],
  machineRoots: readonly string[],
): boolean {
  if (next.state === "blocked" || next.state === "missing") return true;
  const inMachine = (root: string) => machineRoots.some((r) => within(root, r));
  if (!("profile" in scope))
    return (
      next.restrictedProjectReach === "workspace" && scope.readRoots.some((r) => !inMachine(r))
    );
  if (scope.profile === "full-access") return !next.fullAccess;
  if (next.restrictedProjectReach === "workspace" && outsideMachineRoots(scope, machineRoots))
    return true;
  if (!isExecutionMethod(method) || scope.network.kind !== "allowlist") return false;
  return scope.network.hosts.some(
    (host) =>
      !next.restrictedAllowedDomains.some((pattern) => coversHost(pattern, host)) &&
      !grantedHosts.includes(host),
  );
}

/**
 * A restricted operation scope reaching outside the machine's own roots (a selected project beyond
 * the workspace): what narrowing the reach to the workspace takes away (B2). The owner writer and
 * the platform/org Full-off writers share it.
 */
export function outsideMachineRoots(
  scope: SandboxOperationScope | SandboxBrowseScope,
  machineRoots: readonly string[] | undefined,
): boolean {
  if (machineRoots === undefined || !("profile" in scope) || scope.filesystem.kind !== "scoped")
    return false;
  return [...scope.filesystem.readRoots, ...scope.filesystem.writeRoots].some(
    (r) => !machineRoots.some((m) => within(r, m)),
  );
}

/** The machine's reported roots as a list (workspace, tmp, skills ...), or none. */
export function machineRootList(roots: unknown): string[] {
  if (typeof roots !== "object" || roots === null) return [];
  return Object.values(roots as Record<string, unknown>).filter(
    (r): r is string => typeof r === "string" && r.startsWith("/"),
  );
}

/**
 * The protocol-2 mode encoding of a machine's owner Full permission (the kernel's internal
 * lifecycle ceiling encoding; never re-encodes reach): its authenticated report when there is one
 * (a blocked report fails closed), else the protocol 2 derivation ({@link localModeOf}).
 */
export function ownerModeOf(row: {
  features: unknown;
  local_policy: unknown;
  owner_report?: unknown;
}): "auto" | "sandbox" {
  const stored = storedOwnerReportOf(row.owner_report);
  if (stored === null) return localModeOf(row.features, row.local_policy);
  return ownerFactsOfReport(stored).fullAccess ? "auto" : "sandbox";
}
