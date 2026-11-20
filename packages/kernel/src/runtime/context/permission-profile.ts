import { createHash } from "node:crypto";
import {
  type ConversationEvent,
  type ManagedDevicePathsV1,
  ManagedDevicePathsV1Schema,
  type PermissionContextMetaV1,
  type PermissionContextSandbox,
  type PermissionContextV2,
  PermissionContextV2Schema,
  permissionCodePointCompare,
  RecordedPermissionContextSchema,
} from "../../conversations/events.js";

/** A recorded log carries a present marker or version that its strict schema rejects. */
export class RecordedPermissionContextError extends Error {
  override readonly name = "RecordedPermissionContextError";
  constructor(
    readonly seq: number,
    readonly eventType: "permission_context" | "device_paths",
  ) {
    super(
      `Recorded ${eventType} event at seq ${seq} has an unsupported version or an invalid payload`,
    );
  }
}

/** Canonical bytes: explicit nulls, code-point object keys, validated array order. */
export function canonicalPermissionJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) {
    if (Object.keys(value).length !== value.length)
      throw new TypeError("Permission JSON requires dense arrays without extra fields");
    return `[${value.map(canonicalPermissionJson).join(",")}]`;
  }
  if (
    typeof value === "object" &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  ) {
    return `{${Object.keys(value)
      .sort(permissionCodePointCompare)
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalPermissionJson((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  }
  throw new TypeError("Permission JSON requires finite JSON values and explicit nulls");
}
const hash = (value: unknown): string =>
  createHash("sha256").update(canonicalPermissionJson(value), "utf8").digest("hex");

/** JSON quoting makes recorded values inert, including markup and Unicode line separators. */
export const permissionQuote = (value: string): string =>
  JSON.stringify(value).replace(
    /[<>&\u2028\u2029]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
const arrayText = (values: readonly string[]): string =>
  `[${values.map(permissionQuote).join(",")}]`;
const labels = {
  "request-approval": "Request approval",
  "approve-for-me": "Approve for me",
  "full-access": "Full access",
};

const ESCALATE = 'set `sandbox: "escalated"` with a justification';

function networkLine(s: NonNullable<PermissionContextV2["scope"]>): string {
  switch (s.network.kind) {
    case "none":
      return "Network: no destinations are authorized for new commands.";
    case "allowlist":
      return `Network: new commands may reach only these authorized hosts: ${arrayText(s.network.hosts)}.`;
    case "open-public":
      return "Network: the open public internet; private, LAN, loopback, link-local and metadata addresses are closed inside the sandbox.";
    case "environment":
      return s.location === "local"
        ? "Network: the host environment; restricted-profile host lists do not restrict Full access."
        : "Network: the provisioned environment, subject to its outer network boundary.";
  }
}

function outerLine(outer: NonNullable<PermissionContextV2["scope"]>["outerNetwork"]): string {
  switch (outer.kind) {
    case "host-environment":
      return "Outer network boundary: the host environment.";
    case "none":
      return "Outer network boundary: network access is disabled.";
    case "allowlist":
      return `Outer network boundary: allowed hosts ${arrayText(outer.hosts)}.`;
    case "open-public":
      return "Outer network boundary: public addresses only.";
  }
}

/** Hosts on a sandbox whose network covers the whole instance: no call can add one. */
const instanceHostsLine = (box: PermissionContextSandbox): string =>
  `${box.network.kind === "none" ? "Network hosts" : "Hosts outside the network allowlist"}: not approvable per call on this device; the device's host list must include them.`;

/**
 * Who approves each crossing kind under the recorded sandbox (approval-only profiles design,
 * "Profiles"). The escalation clause appears only where running outside the sandbox is available:
 * an operation-boundary sandbox whose device allows it, in an interactive run.
 */
function approverLines(p: PermissionContextV2, box: PermissionContextSandbox): string[] {
  if (p.execution === "scheduled")
    return [
      "Scheduled run: only the unattended policy and explicit task grants apply; interactive approvals and chat Full access do not apply.",
    ];
  const instance = box.boundary === "instance";
  const escalation = box.outsideSandbox && !instance;
  if (p.effectiveProfile === "full-access") {
    const lines = [
      `Full access: commands run in the sandbox; crossings this device allows are approved automatically${escalation ? `; to run a command outside the sandbox ${ESCALATE}` : ""}.`,
    ];
    // a host no call can add (an instance-boundary allowlist) is not approved automatically
    // either; only a block that records `perCallHosts` says so (a stored one renders its bytes)
    if (box.perCallHosts === false && box.network.kind !== "open-public")
      lines.push(instanceHostsLine(box));
    // a sub-agent's escalation is never auto-granted: the review model decides it; nor is an
    // escalation that touches credentials (maintainer ruling 2026-11-19)
    if (escalation && p.inherited)
      lines.push(
        "In this sub-agent, a separate reviewer decides each escalation; uncertainty asks the person.",
      );
    else if (escalation)
      lines.push(
        "An escalation that reads, prints or links credentials goes to a separate reviewer instead; uncertainty asks the person.",
      );
    return lines;
  }
  const approver =
    p.effectiveProfile === "request-approval"
      ? "the person approves"
      : "a separate reviewer approves; uncertainty asks the person";
  const lines: string[] = [];
  if (!instance)
    lines.push(`Directories outside the readable or writable directories: ${approver}.`);
  // `none` is both an allowlist without hosts and the kill switch, which the block does not tell
  // apart: the line names the approver and leaves the device's network switch to the device
  if (box.network.kind !== "open-public")
    lines.push(
      instance
        ? instanceHostsLine(box)
        : box.network.kind === "none"
          ? `Network hosts (none authorized yet): ${approver}, where this device allows network access.`
          : `Hosts outside the network allowlist: ${approver}.`,
    );
  if (escalation) lines.push(`Running a command outside the sandbox: ${approver}; ${ESCALATE}.`);
  lines.push(`Sensitive commands: ${approver}.`);
  return lines;
}

/**
 * The policy line of a supported context that records no sandbox block: only a stored version 1
 * context read as version 2 (the producer always records the block). It renders the bytes that
 * context rendered as version 1, so replaying a stored log never drifts.
 */
function unsandboxedPolicyLine(p: PermissionContextV2): string {
  return p.execution === "scheduled"
    ? "Scheduled run: only the unattended policy and explicit task grants apply; interactive approvals and chat Full access do not apply."
    : p.effectiveProfile === "request-approval"
      ? "Extra filesystem or network scope requires the person's approval."
      : p.effectiveProfile === "approve-for-me"
        ? "A separate reviewer may approve eligible extra scope; uncertainty asks the person."
        : "No discretionary command approval; explicit policy, device-owner limits and OS permissions still apply.";
}

/**
 * The model-facing text of a recorded context: the sandbox once (its boundary, directories and
 * network), then the approver per crossing kind. A supported context without a sandbox block
 * keeps the profile-level policy line.
 */
export function permissionContextText(payload: PermissionContextV2): string {
  // a stored v1 payload renders as its up-converted form: the same bytes it rendered as v1
  const p = readRecordedPermissionContext(payload);
  const s = p.scope;
  const box = p.sandbox;
  const lines = [
    `Permission context for new operations: ${p.availability.state === "supported" && p.effectiveProfile !== null ? labels[p.effectiveProfile] : "unavailable"}.`,
    "This context supersedes earlier device-mode descriptions for new operations.",
  ];
  if (s !== null) {
    if (box !== null)
      lines.push(
        box.boundary === "instance"
          ? "Sandbox: the same under every profile; the provisioned device instance is the sandbox, its whole filesystem is in scope and its outer network applies."
          : "Sandbox: the same under every profile; new commands run in the device's OS sandbox, limited to the directories and network below.",
      );
    lines.push(`Working directory: ${permissionQuote(s.workingRoot)}.`);
    if (s.filesystem.kind === "scoped") {
      lines.push(
        `Readable directories: ${arrayText(s.filesystem.readDirectories)}.`,
        `Writable directories: ${arrayText(s.filesystem.writeDirectories)}.`,
      );
    } else
      lines.push(
        s.location === "local"
          ? "Filesystem: this device as the existing OS user; no additional OS privileges."
          : "Filesystem: the provisioned device environment as its existing OS user; no additional OS privileges.",
      );
    lines.push(networkLine(s), outerLine(s.outerNetwork));
    if (box !== null) lines.push(...approverLines(p, box));
    else lines.push(unsandboxedPolicyLine(p));
  } else if (p.availability.state !== "supported") {
    lines.push(
      `Device operations are ${p.availability.state === "unprobed" ? "unverified" : "unavailable"}: ${permissionQuote(p.availability.reason)}.`,
    );
  }
  lines.push(
    "Changes apply to new operations. Work already started keeps its starting permissions. Actual owner or organization revocation may still stop affected work.",
  );
  return lines.join("\n");
}

export function managedDevicePathsText(payload: ManagedDevicePathsV1): string {
  const p = ManagedDevicePathsV1Schema.parse(payload);
  return `Device directories: workspace ${permissionQuote(p.roots.workspace)}, skills ${permissionQuote(p.roots.skills)}, temporary files ${permissionQuote(p.roots.tmp)}.\nSelected working directory: ${permissionQuote(p.workingRoot)}. These paths do not grant access; the current permission context governs new operations.`;
}
/** A recorded payload read as v2 (a stored v1 one up-converted with `sandbox: null`); throws. */
export function readRecordedPermissionContext(payload: unknown): PermissionContextV2 {
  return RecordedPermissionContextSchema.parse(payload);
}
/** The canonical hash of a recorded device sandbox block (request metadata `sandbox`). */
export const permissionSandboxHash = (sandbox: PermissionContextSandbox): string =>
  hash(["permission_sandbox", 2, sandbox]);
export const permissionContextHash = (payload: PermissionContextV2): string =>
  hash(["permission_context", 2, PermissionContextV2Schema.parse(payload)]);
export const managedDevicePathsHash = (payload: ManagedDevicePathsV1): string =>
  hash(["device_paths", 1, ManagedDevicePathsV1Schema.parse(payload)]);

function predecessor(seq: number): number {
  if (!Number.isSafeInteger(seq) || seq < 0)
    throw new TypeError("Permission predecessor must be a nonnegative safe integer");
  return seq;
}
export const permissionContextIdemKey = (
  payload: PermissionContextV2,
  previousSeq: number,
): string => `permission_context:v2:${permissionContextHash(payload)}:${predecessor(previousSeq)}`;
export const managedDevicePathsIdemKey = (
  payload: ManagedDevicePathsV1,
  previousSeq: number,
): string =>
  `device_paths:permission-v1:${managedDevicePathsHash(payload)}:${predecessor(previousSeq)}`;

export function permissionContextAt(
  events: readonly ConversationEvent[],
  seq: number,
): Extract<ConversationEvent, { type: "permission_context" }> | undefined {
  let latest: Extract<ConversationEvent, { type: "permission_context" }> | undefined;
  for (const e of events)
    if (
      e.type === "permission_context" &&
      e.seq <= seq &&
      (latest === undefined || e.seq > latest.seq)
    )
      latest = e;
  return latest;
}
/**
 * Snapshot validation for raw (cast) events: every `permission_context` and every `device_paths`
 * carrying a marker must satisfy its strict schema, covered or not, before any rendering; an
 * unsupported version must never fall back to historical text. Unmarked paths keep their parser.
 */
export function assertRecordedPermissionEvents(events: readonly ConversationEvent[]): void {
  for (const e of events) {
    if (e.type === "permission_context") {
      if (!RecordedPermissionContextSchema.safeParse(e.payload).success)
        throw new RecordedPermissionContextError(e.seq, e.type);
    } else if (
      e.type === "device_paths" &&
      typeof e.payload === "object" &&
      e.payload !== null &&
      (e.payload as { permissionContextVersion?: unknown }).permissionContextVersion !==
        undefined &&
      !ManagedDevicePathsV1Schema.safeParse(e.payload).success
    )
      throw new RecordedPermissionContextError(e.seq, e.type);
  }
}
export interface PermissionContribution {
  type: "permission_context" | "device_paths";
  text: string;
}
export function permissionContextMeta(
  events: readonly ConversationEvent[],
  contributions: readonly PermissionContribution[],
): PermissionContextMetaV1 | undefined {
  if (contributions.length === 0) return undefined;
  const located = permissionContextAt(events, Number.POSITIVE_INFINITY);
  const sandbox = located?.payload.sandbox ?? null;
  return {
    version: 1,
    contextSeq: located?.seq ?? null,
    hash: hash([1, contributions.map(({ type, text }) => [type, text])]),
    ...(sandbox !== null && { sandbox: permissionSandboxHash(sandbox) }),
  };
}

/**
 * One traversal for request rendering and original-coordinate replay diagnostics. Both callers get
 * the same marker rule: a present marker or version that fails its strict schema (covered by a
 * summary or not) throws {@link RecordedPermissionContextError} before anything renders, so it is
 * never shown as historical device-mode text nor surfaces as a raw schema error. Unmarked events
 * are left to their historical rendering.
 */
export function permissionContextHistory(
  events: readonly ConversationEvent[],
  coversUpToSeq?: number,
): {
  restored: (PermissionContribution & { seq: number })[];
  ordered: Map<number, PermissionContribution>;
  meta: PermissionContextMetaV1 | undefined;
} {
  assertRecordedPermissionEvents(events);
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  const floor = coversUpToSeq ?? Number.NEGATIVE_INFINITY;
  const restored: (PermissionContribution & { seq: number })[] = [];
  const contribution = (e: ConversationEvent): PermissionContribution | undefined => {
    if (e.type === "permission_context")
      return { type: e.type, text: permissionContextText(e.payload) };
    if (e.type === "device_paths" && e.payload.permissionContextVersion === 1)
      return { type: e.type, text: managedDevicePathsText(e.payload) };
    return undefined;
  };
  if (coversUpToSeq !== undefined) {
    const paths = sorted.filter((e) => e.type === "device_paths" && e.seq <= floor).at(-1);
    const permission = permissionContextAt(sorted, floor);
    for (const e of [paths, permission]) {
      if (!e) continue;
      const item = contribution(e);
      if (item) restored.push({ ...item, seq: e.seq });
    }
  }
  const ordered = new Map<number, PermissionContribution>();
  for (const e of sorted) {
    if (e.seq <= floor) continue;
    const item = contribution(e);
    if (item) ordered.set(e.seq, item);
  }
  return {
    restored,
    ordered,
    meta: permissionContextMeta(sorted, [...restored, ...ordered.values()]),
  };
}
