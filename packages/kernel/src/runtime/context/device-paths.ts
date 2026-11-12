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

/** The sandbox level a device's commands run at (spec §11.5). */
export interface DeviceSandboxLevel {
  tier: SandboxTier;
  isolation: "sandbox" | "none";
}

/** The payload of a `device_paths` event. */
export interface DevicePathsPayload {
  roots: SandboxRoots;
  /** Absent on events recorded before tiers. */
  tier?: SandboxTier | undefined;
  isolation?: "sandbox" | "none" | undefined;
}

/** The roots line of a `device_paths` event (model-visible, English). */
const rootsText = (r: SandboxRoots): string =>
  `This device's directories: workspace ${r.workspace}, skills ${r.skills} (read only), temporary files ${r.tmp}. Use these paths in commands and tool calls.`;

/** The sandbox level line of a `device_paths` event (model-visible, English; spec §11.5). */
export function sandboxLevelText(level: DeviceSandboxLevel): string {
  if (level.isolation === "none") {
    return "Sandbox level: open, without a sandbox. Commands run directly on the user's computer as the user, with their files, credentials and network; be careful with anything that deletes files or sends data out.";
  }
  switch (level.tier) {
    case "strict":
      return "Sandbox level: strict. Only the organization's allowed domains are reachable; other domains need the user's approval.";
    case "dev":
      return "Sandbox level: development. Package registries and common developer hosts are reachable; other domains need the user's approval. Local servers and unix sockets work.";
    case "open":
      return "Sandbox level: open. Any public address is reachable. Local servers and unix sockets work.";
  }
}

/** The system message of a `device_paths` event (model-visible, English). */
export function devicePathsText(p: DevicePathsPayload): string {
  const roots = rootsText(p.roots);
  if (p.tier === undefined) return roots;
  return `${roots}\n${sandboxLevelText({ tier: p.tier, isolation: p.isolation ?? "sandbox" })}`;
}

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
        ...(p.tier !== undefined ? [p.tier, p.isolation ?? "sandbox"] : []),
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
      (latest.payload.tier === level.tier &&
        (latest.payload.isolation ?? "sandbox") === level.isolation))
  ) {
    return null;
  }
  const payload: DevicePathsPayload = {
    roots: { workspace: roots.workspace, skills: roots.skills, tmp: roots.tmp },
    ...(level !== undefined && { tier: level.tier, isolation: level.isolation }),
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
