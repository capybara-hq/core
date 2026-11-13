import { createHash } from "node:crypto";
import type { SandboxRoots } from "@capybara-hq/plugin-sdk";
import type { ConversationEvent } from "../../conversations/events.js";
import type { DeviceNetwork, SandboxMode } from "../../sandbox/modes.js";

/**
 * The `device_paths` event (environments spec §13.1, ruling R22; auto mode spec §4.2): the first
 * sandbox tool call of every conversation records the instance's roots (the defaults included) and
 * the device's mode and network, and a later call records them again whenever they differ from the
 * conversation's latest recorded ones (a connected machine's real paths, a mode switch back to the
 * defaults, a network change). Model-visible: rendered at its position as a system message; in the
 * log, so it needs no `DriftReason`. Events recorded before auto mode carry the old `tier` /
 * `isolation` fields and render exactly as they always did.
 */

/** The mode and network a device's commands run at, as the model is told them. */
export interface DeviceModeLevel {
  mode: SandboxMode;
  allowedMode: SandboxMode;
  network: DeviceNetwork;
  /** A connected machine (`true`) rather than a cloud container. */
  local: boolean;
}

/** The payload of a `device_paths` event; the mode fields are absent on events before auto mode. */
export interface DevicePathsPayload {
  roots: SandboxRoots;
  mode?: SandboxMode | undefined;
  allowedMode?: SandboxMode | undefined;
  /** A device network; `"none"` only on events recorded before auto mode. */
  network?: DeviceNetwork | "none" | undefined;
  local?: boolean | undefined;
  /** Before auto mode: the tier and isolation the device ran at. */
  tier?: LegacyTier | undefined;
  isolation?: "sandbox" | "none" | undefined;
  localhost?: "on" | "off-proxy-detected" | "off" | undefined;
  unixSockets?: "roots" | "all-masked" | "off" | undefined;
  unattended?: true | undefined;
}

/** The tier names of events recorded before auto mode (read only by their old rendering). */
type LegacyTier = "strict" | "dev" | "open";

/** The old level of a payload (before auto mode), for its unchanged rendering. */
export interface LegacyLevel {
  tier: LegacyTier;
  isolation: "sandbox" | "none";
  network?: "none" | undefined;
  localhost?: "on" | "off-proxy-detected" | "off" | undefined;
  unixSockets?: "roots" | "all-masked" | "off" | undefined;
  unattended?: true | undefined;
}

/** The roots line of a `device_paths` event (model-visible, English). */
const rootsText = (r: SandboxRoots): string =>
  `This device's directories: workspace ${r.workspace}, skills ${r.skills} (read only), temporary files ${r.tmp}. Use these paths in commands and tool calls.`;

const TIER_NAMES: Record<LegacyTier, string> = {
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
function localText(level: LegacyLevel): string {
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

/** The old level line of a `device_paths` event (before auto mode; kept byte for byte). */
function sandboxLevelText(level: LegacyLevel): string {
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

/** The mode and network line of a `device_paths` event (model-visible, English). */
export function modeLevelText(level: DeviceModeLevel): string {
  if (!level.local) {
    const head = `Mode: ${level.mode}. Commands run in the device's container; outside it `;
    return level.network.kind === "open-public"
      ? `${head}only public addresses are reachable (loopback, private and cloud metadata addresses are blocked).`
      : `${head}the network reaches the organization's allowlisted hosts.`;
  }
  if (level.mode === "auto") {
    return "Mode: auto. Commands run as the user on this machine, with their files, credentials and network; every command is reviewed and dangerous ones are blocked or need approval.";
  }
  return "Mode: sandbox. Only the workspace, skills and temporary files are writable; the network reaches the allowed hosts.";
}

/** The old level a payload records; undefined for an event recorded after auto mode. */
function legacyLevel(p: DevicePathsPayload): LegacyLevel | undefined {
  if (p.tier === undefined) return undefined;
  return {
    tier: p.tier,
    isolation: p.isolation ?? "sandbox",
    ...(p.network === "none" && { network: "none" as const }),
    ...(p.localhost !== undefined && { localhost: p.localhost }),
    ...(p.unixSockets !== undefined && { unixSockets: p.unixSockets }),
    ...(p.unattended === true && { unattended: true as const }),
  };
}

/** A payload's level: the current mode/network shape or the pre-auto-mode one. */
export type DevicePathsLevel = DeviceModeLevel | LegacyLevel;

/** The level a payload records, in either shape; undefined without one. */
export function devicePathsLevel(p: DevicePathsPayload): DevicePathsLevel | undefined {
  if (
    p.mode !== undefined &&
    p.allowedMode !== undefined &&
    typeof p.network === "object" &&
    p.network !== null
  ) {
    return {
      mode: p.mode,
      allowedMode: p.allowedMode,
      network: { kind: p.network.kind, hosts: [...p.network.hosts] },
      local: p.local === true,
    };
  }
  return legacyLevel(p);
}

/** The system message of a `device_paths` event (model-visible, English). */
export function devicePathsText(p: DevicePathsPayload): string {
  const roots = rootsText(p.roots);
  const level = devicePathsLevel(p);
  if (level === undefined) return roots;
  return `${roots}\n${"mode" in level ? modeLevelText(level) : sandboxLevelText(level)}`;
}

/** The fields of a level, in a fixed order (absent ones left out). */
const levelKey = (l: DevicePathsLevel | undefined): unknown[] => {
  if (l === undefined) return [];
  if ("mode" in l) return [l.mode, l.network.kind];
  return [
    l.tier,
    l.isolation,
    ...(l.network !== undefined ? [`network:${l.network}`] : []),
    ...(l.localhost !== undefined ? [`localhost:${l.localhost}`] : []),
    ...(l.unixSockets !== undefined ? [`unixSockets:${l.unixSockets}`] : []),
    ...(l.unattended === true ? ["unattended"] : []),
  ];
};

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
 * changed. Without a `level` (not known: test stubs, a replay of a call recorded before auto mode)
 * only the roots are compared and recorded.
 */
export function devicePathsChange(
  latest: { seq: number; payload: DevicePathsPayload } | undefined,
  roots: SandboxRoots,
  runId: string | undefined,
  level?: DevicePathsLevel,
): {
  type: "device_paths";
  runId?: string;
  idemKey: string;
  payload: DevicePathsPayload;
} | null {
  if (latest) {
    const sameLevel =
      level === undefined ||
      JSON.stringify(levelKey(devicePathsLevel(latest.payload))) ===
        JSON.stringify(levelKey(level));
    if (sameRoots(latest.payload.roots, roots) && sameLevel) return null;
  }
  const payload: DevicePathsPayload = {
    roots: { workspace: roots.workspace, skills: roots.skills, tmp: roots.tmp },
    ...(level !== undefined && level),
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
