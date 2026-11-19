import type { AppendEvent, EventLog } from "../conversations/event-log.js";
import type { ConversationEvent } from "../conversations/events.js";
import { ApiError } from "../errors.js";
import type {
  PermissionContextPort,
  PermissionContextRequestInput,
} from "../runtime/model-call.js";
import {
  assertSnapshotPermissionEvents,
  type DriftReason,
  recordedPermissionContextDrift,
} from "./reconstruct.js";
import { type CaseSnapshot, toEvents } from "./snapshot.js";

/**
 * Recorded-only permission context for a full-run replay (permission context replay spec B4).
 *
 * The seed copies the events before the original run's `run_started` (seq < R) at their own seqs,
 * so an earlier run's `permission_context` is in the eval conversation once and is never appended
 * again. The feeder only ever appends the original run's own `permission_context` events
 * (seq > R), each at the generated request boundary where the original run had made it visible:
 * the original requests `C = (step, attempt, callSeq, U = min(toSeq, callSeq - 1))` are mapped to
 * a generated `(step, attempt)` by {@link selectOriginalRequest}, the consumed boundary only moves
 * forward, and an event is fed once its first visible original request is at or before it. Replays
 * never read live permission state, call a reviewer, preview, admit, provision, resume, probe or
 * touch a device: the feeder writes recorded payloads into the eval conversation and nothing else.
 */

/** One original agent request of the replayed run, in source `callSeq` order. */
export interface OriginalRequest {
  step: number;
  attempt: number;
  callSeq: number;
  /** The last event seq the request could see: `min(request.toSeq, callSeq - 1)`. */
  upTo: number;
}

/** A target-run `permission_context` and the first original request that saw it. */
export interface FeedableContext {
  seq: number;
  payload: unknown;
  /** Index into the original requests of the first one whose `upTo` covers `seq`. */
  firstVisible: number;
}

/** What a recording schedules for its replay: the original requests and the feedable events. */
export interface PermissionFeedPlan {
  requests: OriginalRequest[];
  contexts: FeedableContext[];
}

const invalid = (message: string): ApiError => new ApiError("eval.snapshot_invalid", message);

/** Whether the recording holds any v1 permission marker (event, managed path or metadata). */
export function hasPermissionMarkers(events: readonly ConversationEvent[]): boolean {
  return events.some(
    (e) =>
      e.type === "permission_context" ||
      (e.type === "device_paths" &&
        (e.payload as { permissionContextVersion?: unknown }).permissionContextVersion !==
          undefined) ||
      (e.type === "model_call" &&
        (e.payload.request as { permissionContext?: unknown }).permissionContext !== undefined),
  );
}

/**
 * The original requests of the run started at `runStartedSeq` and its feedable contexts. Rejects
 * (`eval.snapshot_invalid`) a duplicate `(step, attempt)`, a step or attempt going backwards in
 * `callSeq` order, and a visibility bound `upTo` going backwards: a valid log only appends.
 */
export function permissionFeedPlan(
  events: readonly ConversationEvent[],
  runId: string,
  runStartedSeq: number,
): PermissionFeedPlan {
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  const requests: OriginalRequest[] = [];
  for (const e of sorted) {
    if (e.type !== "model_call" || e.runId !== runId || e.seq <= runStartedSeq) continue;
    const p = e.payload as { step: number; attempt?: number; request: { toSeq: number } };
    const r: OriginalRequest = {
      step: p.step,
      // a legacy record without an attempt is the step's first (the replay's existing fallback)
      attempt: p.attempt ?? 1,
      callSeq: e.seq,
      upTo: Math.min(p.request.toSeq, e.seq - 1),
    };
    const prev = requests.at(-1);
    if (prev !== undefined) {
      if (r.step < prev.step || (r.step === prev.step && r.attempt <= prev.attempt)) {
        throw invalid(
          `Recorded model_call at seq ${e.seq} repeats or goes back from step ${prev.step} attempt ${prev.attempt}`,
        );
      }
      if (r.upTo < prev.upTo) {
        throw invalid(`Recorded model_call at seq ${e.seq} sees fewer events than the one before`);
      }
    }
    requests.push(r);
  }
  const contexts: FeedableContext[] = [];
  for (const e of sorted) {
    if (e.type !== "permission_context" || e.runId !== runId || e.seq <= runStartedSeq) continue;
    const firstVisible = requests.findIndex((r) => r.upTo >= e.seq);
    // never seen by an original request (logged after the last one): never fed
    if (firstVisible < 0) continue;
    contexts.push({ seq: e.seq, payload: e.payload, firstVisible });
  }
  return { requests, contexts };
}

/**
 * The original request that supplies a generated `(step, attempt)`'s permission context (spec B4
 * table), as an index into `requests`; undefined when there is none (seeded history only):
 * - the same step's exact attempt; inside a gap, the greatest earlier attempt of that step; before
 *   its first recorded attempt, that first attempt (the first actually sent request supplies the
 *   initial context); past its last, its last;
 * - a step with no original request: the last request of the greatest earlier original step,
 *   never a later step (past every original step: the final request);
 * - before every original step, or a run without requests: none.
 */
export function selectOriginalRequest(
  requests: readonly OriginalRequest[],
  step: number,
  attempt: number,
): number | undefined {
  let lastEarlier: number | undefined;
  let sameStep: number[] = [];
  for (const [i, r] of requests.entries()) {
    if (r.step < step) lastEarlier = i;
    else if (r.step === step) sameStep.push(i);
  }
  if (sameStep.length > 0) {
    sameStep = sameStep.sort(
      (a, b) => (requests[a] as OriginalRequest).attempt - (requests[b] as OriginalRequest).attempt,
    );
    const exact = sameStep.find((i) => (requests[i] as OriginalRequest).attempt === attempt);
    if (exact !== undefined) return exact;
    const earlier = sameStep.filter((i) => (requests[i] as OriginalRequest).attempt < attempt);
    // before the first recorded attempt: that first attempt, by explicit policy (spec B4)
    return earlier.at(-1) ?? sameStep[0];
  }
  return lastEarlier;
}

/** The persistent identity of a fed event: the generated run and the original event's seq. */
export const replayPermissionContextIdemKey = (generatedRunId: string, originalSeq: number) =>
  `replay_permission_context:${generatedRunId}:${originalSeq}`;

/** The replayed (generated) conversation and run the feeder may write to. */
export interface ReplayTarget {
  conversationId: string;
  runId: string;
}

/**
 * Recorded original-coordinate diagnostics over every original request of the replayed run (spec
 * "Replay and meaningful drift detection"): the reasons (`permission_profile_changed`,
 * `device_sandbox_changed`) of every request that cannot reproduce its recorded permission
 * metadata from its own bounded range, deduplicated. Throws `eval.snapshot_invalid` for a recorded
 * event its strict schema rejects. Never compares generated seqs or hashes with the original.
 */
export function recordedRunPermissionDrift(s: CaseSnapshot): DriftReason[] {
  const events = toEvents(s);
  if (!hasPermissionMarkers(events)) return [];
  assertSnapshotPermissionEvents(events);
  const drift = new Set<DriftReason>();
  for (const e of events)
    if (e.type === "model_call" && e.runId === s.runId)
      for (const reason of recordedPermissionContextDrift(events, e)) drift.add(reason);
  return [...drift];
}

/**
 * The recorded-only feeder for the replay of `s` (spec B4) into `target`, or undefined for a
 * recording without any v1 permission marker, so the request boundary stays absent and old
 * recordings build their requests exactly as before. A marked recording gets a feeder even when no
 * target-run event is feedable (an earlier run's seeded context still applies).
 */
export function recordedPermissionContext(
  s: CaseSnapshot,
  eventLog: Pick<EventLog, "append">,
  target: ReplayTarget,
): PermissionContextPort | undefined {
  const events = toEvents(s);
  if (!hasPermissionMarkers(events)) return undefined;
  assertSnapshotPermissionEvents(events);
  const start = events.find((e) => e.runId === s.runId && e.type === "run_started");
  if (start === undefined) {
    throw new ApiError("eval.call_not_found", "The snapshot does not contain the run's start");
  }
  const plan = permissionFeedPlan(events, s.runId, start.seq);
  /** The furthest original request reached so far (monotone). */
  let reached = -1;
  /** Accelerator only: original seq → generated seq; the idem keys are the durable truth. */
  const fed = new Map<number, number>();
  return {
    async beforeRequest(input: PermissionContextRequestInput): Promise<void> {
      // fail closed: this feeder writes only into the eval conversation it was made for
      if (input.conversationId !== target.conversationId || input.runId !== target.runId) {
        throw new Error("The recorded permission feeder belongs to another replay");
      }
      if (input.signal.aborted) return;
      const chosen = selectOriginalRequest(plan.requests, input.step, input.attempt);
      if (chosen !== undefined) reached = Math.max(reached, chosen);
      const due = plan.contexts.filter((c) => c.firstVisible <= reached && !fed.has(c.seq));
      if (due.length === 0) return;
      // one batch in source order; an idem hit returns the event an earlier entry already wrote
      const written = await eventLog.append(
        target.conversationId,
        due.map(
          (c): AppendEvent =>
            ({
              type: "permission_context",
              runId: target.runId,
              idemKey: replayPermissionContextIdemKey(target.runId, c.seq),
              payload: structuredClone(c.payload),
            }) as AppendEvent,
        ),
      );
      for (const [i, c] of due.entries()) {
        const w = written[i];
        if (w !== undefined) fed.set(c.seq, w.seq);
      }
    },
  };
}
