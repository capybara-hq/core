import { createHash } from "node:crypto";
import { DEFAULT_SANDBOX_ROOTS, type SandboxRoots } from "@capybara-hq/plugin-sdk";
import type { ConversationEvent } from "../../conversations/events.js";

/**
 * The `environment_paths` event (environments spec §13.1): an instance whose roots differ from
 * {@link DEFAULT_SANDBOX_ROOTS} (a connected machine in OS sandbox mode) is described to the model
 * once per conversation, by the sandbox tool call that first entered it. Model-visible: rendered
 * at its position as a system message; in the log, so it needs no `DriftReason`.
 */

/** The system line of an `environment_paths` event (model-visible, English). */
export function environmentPathsText(r: SandboxRoots): string {
  return `This environment's directories: workspace ${r.workspace}, skills ${r.skills} (read only), temporary files ${r.tmp}. Use these paths in commands and tool calls.`;
}

/** Whether `r` are the default roots (no event is written for them). */
export const isDefaultRoots = (r: SandboxRoots): boolean =>
  r.workspace === DEFAULT_SANDBOX_ROOTS.workspace &&
  r.skills === DEFAULT_SANDBOX_ROOTS.skills &&
  r.tmp === DEFAULT_SANDBOX_ROOTS.tmp;

/**
 * The idempotency key of a conversation's `environment_paths` event for `r`: one event per
 * conversation and roots (other roots later, a replaced machine, get an event of their own).
 */
export const environmentPathsIdemKey = (r: SandboxRoots): string =>
  `environment_paths:${createHash("sha256")
    .update(JSON.stringify([r.workspace, r.skills, r.tmp]))
    .digest("hex")
    .slice(0, 16)}`;

/** The latest `environment_paths` event at or before `seq`; undefined without one. */
export function environmentPathsAt(
  events: readonly ConversationEvent[],
  seq: number,
): Extract<ConversationEvent, { type: "environment_paths" }> | undefined {
  let found: Extract<ConversationEvent, { type: "environment_paths" }> | undefined;
  for (const e of events) {
    if (e.seq > seq) break;
    if (e.type === "environment_paths") found = e;
  }
  return found;
}
