import { createHash } from "node:crypto";
import {
  type ConversationEvent,
  type ManagedDevicePathsV1,
  ManagedDevicePathsV1Schema,
  type PermissionContextMetaV1,
  type PermissionContextV1,
  PermissionContextV1Schema,
  permissionCodePointCompare,
} from "../../conversations/events.js";

/** A recorded log carries a present v1 marker or version that its strict schema rejects. */
export class RecordedPermissionContextError extends Error {
  override readonly name = "RecordedPermissionContextError";
  constructor(
    readonly seq: number,
    readonly eventType: "permission_context" | "device_paths",
  ) {
    super(
      `Recorded ${eventType} event at seq ${seq} has an unsupported version or an invalid v1 payload`,
    );
  }
}

/** Canonical v1 bytes: explicit nulls, code-point object keys, validated array order. */
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

export function permissionContextText(payload: PermissionContextV1): string {
  const p = PermissionContextV1Schema.parse(payload);
  const s = p.scope;
  const lines = [
    `Permission context for new operations: ${p.availability.state === "supported" && p.effectiveProfile !== null ? labels[p.effectiveProfile] : "unavailable"}.`,
    "This context supersedes earlier device-mode descriptions for new operations.",
  ];
  if (s !== null) {
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
    switch (s.network.kind) {
      case "none":
        lines.push("Network: no destinations are authorized for new commands.");
        break;
      case "allowlist":
        lines.push(
          `Network: new commands may reach only these authorized hosts: ${arrayText(s.network.hosts)}.`,
        );
        break;
      case "environment":
        lines.push(
          s.location === "local"
            ? "Network: the host environment; restricted-profile host lists do not restrict Full access."
            : "Network: the provisioned environment, subject to its outer network boundary.",
        );
        break;
    }
    switch (s.outerNetwork.kind) {
      case "host-environment":
        lines.push("Outer network boundary: the host environment.");
        break;
      case "none":
        lines.push("Outer network boundary: network access is disabled.");
        break;
      case "allowlist":
        lines.push(`Outer network boundary: allowed hosts ${arrayText(s.outerNetwork.hosts)}.`);
        break;
      case "open-public":
        lines.push("Outer network boundary: public addresses only.");
        break;
    }
    lines.push(
      p.execution === "scheduled"
        ? "Scheduled run: only the unattended policy and explicit task grants apply; interactive approvals and chat Full access do not apply."
        : p.effectiveProfile === "request-approval"
          ? "Extra filesystem or network scope requires the person's approval."
          : p.effectiveProfile === "approve-for-me"
            ? "A separate reviewer may approve eligible extra scope; uncertainty asks the person."
            : "No discretionary command approval; explicit policy, device-owner limits and OS permissions still apply.",
    );
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
export const permissionContextHash = (payload: PermissionContextV1): string =>
  hash(["permission_context", 1, PermissionContextV1Schema.parse(payload)]);
export const managedDevicePathsHash = (payload: ManagedDevicePathsV1): string =>
  hash(["device_paths", 1, ManagedDevicePathsV1Schema.parse(payload)]);

function predecessor(seq: number): number {
  if (!Number.isSafeInteger(seq) || seq < 0)
    throw new TypeError("Permission predecessor must be a nonnegative safe integer");
  return seq;
}
export const permissionContextIdemKey = (
  payload: PermissionContextV1,
  previousSeq: number,
): string => `permission_context:v1:${permissionContextHash(payload)}:${predecessor(previousSeq)}`;
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
 * carrying a marker must satisfy its strict v1 schema, covered or not, before any rendering; an
 * unsupported version must never fall back to historical text. Unmarked paths keep their parser.
 */
export function assertRecordedPermissionEvents(events: readonly ConversationEvent[]): void {
  for (const e of events) {
    if (e.type === "permission_context") {
      if (!PermissionContextV1Schema.safeParse(e.payload).success)
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
  return {
    version: 1,
    contextSeq: permissionContextAt(events, Number.POSITIVE_INFINITY)?.seq ?? null,
    hash: hash([1, contributions.map(({ type, text }) => [type, text])]),
  };
}

/** One traversal for request rendering and original-coordinate replay diagnostics. */
export function permissionContextHistory(
  events: readonly ConversationEvent[],
  coversUpToSeq?: number,
): {
  restored: (PermissionContribution & { seq: number })[];
  ordered: Map<number, PermissionContribution>;
  meta: PermissionContextMetaV1 | undefined;
} {
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
