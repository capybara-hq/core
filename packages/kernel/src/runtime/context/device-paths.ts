import { createHash } from "node:crypto";
import type { SandboxRoots, SandboxTier } from "@capybara-hq/plugin-sdk";
import type { ConversationEvent } from "../../conversations/events.js";

/**
 * The `device_paths` event (environments spec §13.1, ruling R22; sandbox dev tiers spec §11.5):
 * the first sandbox tool call of every conversation records the instance's roots (the defaults
 * included) and the device's sandbox level, and a later call records them again whenever they
 * differ from the conversation's latest recorded ones (a connected machine's real paths, a mode
 * switch back to the defaults, a tier or isolation change). Model-visible: rendered at its
 * position as a system message; in the log, so it needs no `DriftReason`. Events recorded before
 * tiers have no `tier` / `isolation` and render as they always did.
 */

/** The sandbox level a device's commands run at (spec §11.5), as the model is told it. */
export interface DeviceSandboxLevel {
  tier: SandboxTier;
  isolation: "sandbox" | "none";
  /** `none`: the org's or the platform's sandbox network is off (every tier). */
  network?: "none" | undefined;
  /** A local device's localhost and unix sockets, as its machine reported them (absent: cloud). */
  localhost?: "on" | "off-proxy-detected" | "off" | undefined;
  unixSockets?: "roots" | "all-masked" | "off" | undefined;
  /** The call is in a scheduled run without a person: nobody can approve a domain. */
  unattended?: true | undefined;
}

/** The payload of a `device_paths` event; the level fields are absent on events before tiers. */
export interface DevicePathsPayload extends Omit<DeviceSandboxLevel, "tier" | "isolation"> {
  roots: SandboxRoots;
  tier?: SandboxTier | undefined;
  isolation?: "sandbox" | "none" | undefined;
}

/** The roots line of a `device_paths` event (model-visible, English). */
const rootsText = (r: SandboxRoots): string =>
  `This device's directories: workspace ${r.workspace}, skills ${r.skills} (read only), temporary files ${r.tmp}. Use these paths in commands and tool calls.`;

const TIER_NAMES: Record<SandboxTier, string> = {
  strict: "strict",
  dev: "development",
  open: "open",
};

/** What a domain outside the reachable ones needs: the user's approval, unless nobody is there. */
const otherDomains = (unattended: boolean): string =>
  unattended
    ? "approvals are not available in a scheduled run, so other domains stay blocked."
    : "other domains need the user's approval.";

/** Local servers and unix sockets in `dev` / `open` (a cloud instance has both). */
function localText(level: DeviceSandboxLevel): string {
  const { localhost, unixSockets } = level;
  if (localhost === undefined || unixSockets === undefined) {
    return "Local servers and unix sockets work.";
  }
  const servers =
    localhost === "on"
      ? "Local servers work"
      : localhost === "off-proxy-detected"
        ? "Local servers are blocked on this machine because a local proxy was detected (the user can allow them on the device)"
        : "Local servers are blocked";
  const sockets =
    unixSockets === "roots"
      ? "unix sockets work under the device's directories only"
      : unixSockets === "all-masked"
        ? "unix sockets work inside the device's container only"
        : "unix sockets are blocked";
  return `${servers}; ${sockets}.`;
}

/** The sandbox level line of a `device_paths` event (model-visible, English; spec §11.5). */
export function sandboxLevelText(level: DeviceSandboxLevel): string {
  if (level.isolation === "none") {
    return "Sandbox level: open, without a sandbox. Commands run directly on the user's computer as the user, with their files, credentials and network; be careful with anything that deletes files or sends data out.";
  }
  const head = `Sandbox level: ${TIER_NAMES[level.tier]}.`;
  if (level.network === "none") {
    return `${head} The network is switched off for this organization: no domain is reachable and approval requests cannot change that.`;
  }
  const unattended = level.unattended === true;
  switch (level.tier) {
    case "strict":
      return `${head} Only the organization's allowed domains are reachable; ${otherDomains(unattended)}`;
    case "dev":
      return `${head} Package registries and common developer hosts are reachable; ${otherDomains(unattended)} ${localText(level)}`;
    case "open":
      return `${head} Any public address is reachable. ${localText(level)}`;
  }
}

/** The level a payload records; undefined for an event recorded before tiers. */
export function devicePathsLevel(p: DevicePathsPayload): DeviceSandboxLevel | undefined {
  if (p.tier === undefined) return undefined;
  return {
    tier: p.tier,
    isolation: p.isolation ?? "sandbox",
    ...(p.network !== undefined && { network: p.network }),
    ...(p.localhost !== undefined && { localhost: p.localhost }),
    ...(p.unixSockets !== undefined && { unixSockets: p.unixSockets }),
    ...(p.unattended === true && { unattended: true as const }),
  };
}

/** The system message of a `device_paths` event (model-visible, English). */
export function devicePathsText(p: DevicePathsPayload): string {
  const roots = rootsText(p.roots);
  const level = devicePathsLevel(p);
  return level === undefined ? roots : `${roots}\n${sandboxLevelText(level)}`;
}

/** The fields of a level, in a fixed order (absent ones left out). */
const levelKey = (l: DeviceSandboxLevel | undefined): unknown[] =>
  l === undefined
    ? []
    : [
        l.tier,
        l.isolation,
        ...(l.network !== undefined ? [`network:${l.network}`] : []),
        ...(l.localhost !== undefined ? [`localhost:${l.localhost}`] : []),
        ...(l.unixSockets !== undefined ? [`unixSockets:${l.unixSockets}`] : []),
        ...(l.unattended === true ? ["unattended"] : []),
      ];

/** Whether two sets of roots are the same paths. */
export const sameRoots = (a: SandboxRoots, b: SandboxRoots): boolean =>
  a.workspace === b.workspace && a.skills === b.skills && a.tmp === b.tmp;

/**
 * The idempotency key of a `device_paths` event for `p` that follows the conversation's event at
 * `prevSeq` (0: none). Unique per change (A → B → A gets three events), while parallel calls that
 * saw the same latest event write it once.
 */
export const devicePathsIdemKey = (p: DevicePathsPayload, prevSeq: number): string =>
  `device_paths:${createHash("sha256")
    .update(
      JSON.stringify([
        p.roots.workspace,
        p.roots.skills,
        p.roots.tmp,
        ...levelKey(devicePathsLevel(p)),
      ]),
    )
    .digest("hex")
    .slice(0, 16)}:${prevSeq}`;

/**
 * The `device_paths` event to append when a sandbox call holds an instance with `roots` in a
 * device at `level`, and the conversation's latest such event is `latest`; null when nothing
 * changed. Without a `level` (not known: test stubs, a replay of a call recorded before tiers)
 * only the roots are compared and recorded.
 */
export function devicePathsChange(
  latest: { seq: number; payload: DevicePathsPayload } | undefined,
  roots: SandboxRoots,
  runId: string | undefined,
  level?: DeviceSandboxLevel,
): {
  type: "device_paths";
  runId?: string;
  idemKey: string;
  payload: DevicePathsPayload;
} | null {
  if (
    latest &&
    sameRoots(latest.payload.roots, roots) &&
    (level === undefined ||
      JSON.stringify(levelKey(devicePathsLevel(latest.payload))) ===
        JSON.stringify(levelKey(level)))
  ) {
    return null;
  }
  const payload: DevicePathsPayload = {
    roots: { workspace: roots.workspace, skills: roots.skills, tmp: roots.tmp },
    ...(level !== undefined && devicePathsLevel({ roots, ...level })),
  };
  return {
    type: "device_paths",
    ...(runId !== undefined && { runId }),
    idemKey: devicePathsIdemKey(payload, latest?.seq ?? 0),
    payload,
  };
}

/** The latest `device_paths` event at or before `seq`; undefined without one. */
export function devicePathsAt(
  events: readonly ConversationEvent[],
  seq: number,
): Extract<ConversationEvent, { type: "device_paths" }> | undefined {
  let found: Extract<ConversationEvent, { type: "device_paths" }> | undefined;
  for (const e of events) {
    if (e.seq > seq) break;
    if (e.type === "device_paths") found = e;
  }
  return found;
}
