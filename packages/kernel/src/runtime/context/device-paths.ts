import { createHash } from "node:crypto";
import type { SandboxRoots } from "@capybara-hq/plugin-sdk";
import type { ConversationEvent } from "../../conversations/events.js";

/**
 * The `device_paths` event (environments spec §13.1, ruling R22): the first sandbox tool call
 * of every conversation records the instance's roots (the defaults included), and a later call
 * records them again whenever they differ from the conversation's latest recorded ones (a
 * connected machine's real paths, a mode switch back to the defaults). Model-visible: rendered at
 * its position as a system message; in the log, so it needs no `DriftReason`.
 */

/** The system line of an `device_paths` event (model-visible, English). */
export function devicePathsText(r: SandboxRoots): string {
  return `This environment's directories: workspace ${r.workspace}, skills ${r.skills} (read only), temporary files ${r.tmp}. Use these paths in commands and tool calls.`;
}

/** Whether two sets of roots are the same paths. */
export const sameRoots = (a: SandboxRoots, b: SandboxRoots): boolean =>
  a.workspace === b.workspace && a.skills === b.skills && a.tmp === b.tmp;

/**
 * The idempotency key of an `device_paths` event for `r` that follows the conversation's
 * event at `prevSeq` (0: none). Unique per change (A → B → A gets three events), while parallel
 * calls that saw the same latest event write it once.
 */
export const devicePathsIdemKey = (r: SandboxRoots, prevSeq: number): string =>
  `device_paths:${createHash("sha256")
    .update(JSON.stringify([r.workspace, r.skills, r.tmp]))
    .digest("hex")
    .slice(0, 16)}:${prevSeq}`;

/**
 * The `device_paths` event to append when a sandbox call holds an instance with `roots` and
 * the conversation's latest such event is `latest`; null when nothing changed.
 */
export function devicePathsChange(
  latest: { seq: number; payload: { roots: SandboxRoots } } | undefined,
  roots: SandboxRoots,
  runId: string | undefined,
): {
  type: "device_paths";
  runId?: string;
  idemKey: string;
  payload: { roots: SandboxRoots };
} | null {
  if (latest && sameRoots(latest.payload.roots, roots)) return null;
  return {
    type: "device_paths",
    ...(runId !== undefined && { runId }),
    idemKey: devicePathsIdemKey(roots, latest?.seq ?? 0),
    payload: { roots: { workspace: roots.workspace, skills: roots.skills, tmp: roots.tmp } },
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
