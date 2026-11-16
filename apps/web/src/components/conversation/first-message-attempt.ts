import { ApiClientError } from "../../lib/api";
import { type FirstMessageRequest, serializeFirstMessage } from "../../lib/conversations";
import type { ComposerMessage } from "./ComposerBar";

/**
 * A new conversation's first send, as one attempt (permission profiles, Task 10 slice C):
 *
 * - `sending`: the request is on its way (one at a time).
 * - `outcome-unknown`: no answer (network) or a server error: it may or may not have committed.
 * - `rejected`: a 4xx refusal. A generic 409 `conflict` (`conflict: true`) is a stale displayed
 *   scope or the same id with another body; the web cannot tell which, and it proves no rollback
 *   of an earlier unknown outcome.
 * - `resolved`: the kernel answered 200/201 with the conversation.
 *
 * The id and the serialized bytes are frozen when the attempt starts; a retry sends them again
 * and never rebuilds them from the composer's current controls.
 */
export type FirstMessageAttemptState = "sending" | "outcome-unknown" | "rejected" | "resolved";

export interface FirstMessageAttempt {
  state: FirstMessageAttemptState;
  orgId: string;
  agentId: string;
  clientMessageId: string;
  /** What makes two sends the same logical request (see {@link firstMessageIntent}). */
  intentKey: string;
  /** The exact request body every retry sends. */
  serializedBody: string;
  /** Some send of this attempt had no definite answer. */
  hadUnknownOutcome: boolean;
  /** The latest refusal was a generic 409 conflict. */
  conflict: boolean;
  /** The message as the composer sent it (its pending bubble and the draft to give back). */
  message: ComposerMessage;
  result?: { conversationId: string };
}

/**
 * The logical request apart from its id and the browser context: org, agent, text, resources,
 * files, skill, device, project, profile with its consent revision, model and effort. Any change
 * makes a new logical request with a new id; the composer's narrower draft key is not the
 * authority here.
 */
export function firstMessageIntent(orgId: string, r: FirstMessageRequest): string {
  const m = r.message;
  return JSON.stringify([
    orgId,
    r.agentId,
    m.text,
    (m.attachments ?? []).map((a) => [a.connectorId, a.uri]),
    m.files ?? [],
    m.skill?.name ?? null,
    m.model ?? null,
    m.effort ?? null,
    r.deviceId ?? null,
    r.project ?? null,
    r.permission.profile,
    r.permission.consentScopeRevision ?? null,
  ]);
}

/** A new logical request: the id and the bytes are fixed here, once. */
export function startFirstMessage(
  orgId: string,
  r: FirstMessageRequest,
  message: ComposerMessage,
  clientMessageId: string,
): FirstMessageAttempt {
  return {
    state: "sending",
    orgId,
    agentId: r.agentId,
    clientMessageId,
    intentKey: firstMessageIntent(orgId, r),
    serializedBody: serializeFirstMessage(r, clientMessageId),
    hadUnknownOutcome: false,
    conflict: false,
    message: { ...message, clientMessageId },
  };
}

/** The original sent again: same org, agent, id and bytes. */
export const retryFirstMessage = (a: FirstMessageAttempt): FirstMessageAttempt => ({
  ...a,
  state: "sending",
});

/** No answer, or a server error, leaves the outcome unknown; any other refusal is definite. */
export function failureOutcome(e: unknown): "outcome-unknown" | "rejected" {
  if (!(e instanceof ApiClientError)) return "outcome-unknown";
  return e.status === 0 || e.status >= 500 ? "outcome-unknown" : "rejected";
}

export function settleFirstMessage(
  a: FirstMessageAttempt,
  outcome: { conversationId: string } | { error: unknown },
): FirstMessageAttempt {
  if ("conversationId" in outcome)
    return {
      ...a,
      state: "resolved",
      conflict: false,
      result: { conversationId: outcome.conversationId },
    };
  const state = failureOutcome(outcome.error);
  return {
    ...a,
    state,
    hadUnknownOutcome: a.hadUnknownOutcome || state === "outcome-unknown",
    conflict:
      state === "rejected" &&
      outcome.error instanceof ApiClientError &&
      outcome.error.status === 409,
  };
}

/**
 * Kept for an explicit Retry original: an unknown outcome, a conflict, or any refusal after an
 * unknown outcome (the original may have committed). A definite refusal of an attempt that never
 * went unanswered created nothing and is dropped.
 */
export const isRecoverable = (a: FirstMessageAttempt): boolean =>
  a.state === "outcome-unknown" || (a.state === "rejected" && (a.conflict || a.hadUnknownOutcome));

/** The latest recoverable attempt of this very request (an unchanged send retries it). */
export function recoverableFor(
  attempts: readonly FirstMessageAttempt[],
  intentKey: string,
): FirstMessageAttempt | undefined {
  return attempts.findLast((a) => a.intentKey === intentKey && isRecoverable(a));
}
