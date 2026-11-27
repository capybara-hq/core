import { createHash } from "node:crypto";
import type { TriggerSubject } from "@capybara-hq/plugin-sdk";

/** A stable, BullMQ-safe key for a trigger subject: `${kind}-${sha1(id).slice(0, 16)}`. */
export function subjectKey(s: TriggerSubject): string {
  const digest = createHash("sha1").update(s.id).digest("hex").slice(0, 16);
  return `${s.kind.replaceAll(":", "-")}-${digest}`;
}

/** Deterministic job id for coalescing events of one subject into one automation run. */
export function coalesceJobId(automationId: string, s: TriggerSubject): string {
  return `automation-coalesce-${automationId.replaceAll(":", "-")}-${subjectKey(s)}`;
}

/** True when the event was caused by a run of this same automation account and agent. */
export function isSelfTriggered(
  a: { accountId: string; agentId: string },
  cause: { runAccountId: string; runAgentId: string } | null,
): boolean {
  return cause !== null && cause.runAccountId === a.accountId && cause.runAgentId === a.agentId;
}

export function depthExceeded(depth: number, max: number): boolean {
  return depth > max;
}
