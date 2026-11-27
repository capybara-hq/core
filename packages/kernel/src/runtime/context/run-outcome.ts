import type { ConversationEvent, EventPayload } from "../../conversations/events.js";

/**
 * The run outcome note (reliability spec §"Run outcome notes", maintainer decision 2026-11-28): a
 * run that ended `failed` or `aborted` is followed, in every later request, by one system message
 * at its terminal event's position saying that it ended before it finished and why. Without it the
 * model sees only the replayed partial reply and the pairing guard's "Result unknown" results, and
 * cannot tell a stopped run from a finished one.
 *
 * The text is derived from the terminal event's payload alone (the abort reason and detail, the
 * error code), mapped onto a few neutral categories: never the recorded message, which may hold
 * provider text, URLs or other details the model must not see. A compact run (`run_started.trigger:
 * "compact"`) gets no note: the model took no part in it, and its outcome is the summary (or
 * nothing). Every other run gets one, a sub-agent's included (its own log: the next run a
 * `SendMessage` starts sees how the previous one ended). The note sits where the run ended, so it
 * never moves or changes once rendered (append-only); a summary that covers it drops it, and the
 * compaction transcript carries it as a system line.
 */

const PREFIX = "The previous run ended before it finished";

/** Why a stopped run stopped, from `run_aborted` (model-facing English, no trailing period). */
function abortedReason(p: EventPayload<"run_aborted">): string {
  if (p.detail === "wait_timeout")
    return "it was stopped because the dispatching agent's wait for it timed out";
  if (p.reason === "user" && p.byAccountId !== null) return "it was stopped by the user";
  if (p.reason === "shutdown_exhausted") return "it was interrupted and could not be resumed";
  return "it was stopped";
}

/** The neutral category of a `run_failed` error code (model-facing English, no trailing period). */
function failedReason(code: string): string {
  switch (code) {
    case "model.rate_limited":
    case "model.overloaded":
      return "the model service was overloaded or rate-limited";
    case "model.server":
    case "run.provider_error":
      return "the model service returned an error";
    case "model.timeout":
      return "the model service did not respond in time";
    case "model.network":
      return "a network error";
    case "model.auth":
      return "the model service rejected the platform's credentials";
    case "model.invalid_request":
      return "the model service rejected the request";
    case "model.context_overflow":
    case "run.context_too_large":
      return "the conversation no longer fit the model's context window";
    case "model.refusal":
      return "the model declined to respond";
    case "model.unconfigured":
    case "run.model_unavailable":
    case "run.provider_unavailable":
      return "the model was unavailable";
    case "run.storage_unavailable":
      return "attachment storage was unavailable";
    case "run.hook_denied":
      return "a platform policy blocked the model request";
    case "run.delivery_failed":
      return "the reply could not be delivered";
    case "run.stalled":
    case "run.orphaned":
      return "it was interrupted and could not be resumed";
    default:
      return "an internal error";
  }
}

/** The note for one terminal event (model-facing English). */
export function runOutcomeText(
  e: Extract<ConversationEvent, { type: "run_failed" | "run_aborted" }>,
): string {
  const why =
    e.type === "run_aborted" ? abortedReason(e.payload) : failedReason(e.payload.error.code);
  return `${PREFIX}: ${why}.`;
}

/**
 * The notes a request renders, by the seq of their terminal event: every `run_failed` /
 * `run_aborted` whose run is not a compact run. Read from the log alone (`events` in any order).
 */
export function runOutcomeNotes(events: readonly ConversationEvent[]): Map<number, string> {
  const compact = new Set<string>();
  for (const e of events) {
    if (e.type === "run_started" && e.payload.trigger === "compact" && e.runId !== null) {
      compact.add(e.runId);
    }
  }
  const out = new Map<number, string>();
  for (const e of events) {
    if (e.type !== "run_failed" && e.type !== "run_aborted") continue;
    if (e.runId !== null && compact.has(e.runId)) continue;
    out.set(e.seq, runOutcomeText(e));
  }
  return out;
}
