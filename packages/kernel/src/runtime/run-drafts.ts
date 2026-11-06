import type { ExtensionContext, Logger } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import type { Redis } from "ioredis";
import {
  type ConversationBusMessage,
  conversationTopic,
  EventLog,
} from "../conversations/event-log.js";
import type { KernelSchemaDb } from "../db/kernel-schema.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { KERNEL_LOGGER, REDIS } from "../infra/tokens.js";
import { assistantIdemKey, type StreamSink } from "./model-call.js";

/** How long a draft lives without a write (a step that keeps streaming keeps refreshing it). */
export const DRAFT_TTL_SECONDS = 600;
/** At most one write per step per window, plus the one at the end of the model stream. */
export const DRAFT_FLUSH_MS = 200;

/** One step's draft: `{ text, thinking }` as JSON (spec 2026-11-07 §3.2). */
export const draftKey = (runId: string, step: number): string => `capk:run-draft:${runId}:${step}`;
/** The steps of a run that have a draft (a set, so a reader finds them without a key scan). */
const stepsKey = (runId: string): string => `capk:run-draft-steps:${runId}`;

/** What one step of a run has streamed so far. */
export interface RunDraft {
  step: number;
  text: string;
  thinking: string;
}

/** A draft of a conversation's active run (the `event: draft` frame's data). */
export interface LiveDraft extends RunDraft {
  runId: string;
}

/** The step a run is streaming in this process, and what of it is not written yet. */
interface Held {
  step: number;
  text: string;
  thinking: string;
  /** When the draft was last written (`-Infinity`: never, so the first delta writes at once). */
  writtenAt: number;
  dirty: boolean;
}

const parse = (step: number, v: string | null): RunDraft | null => {
  if (v === null) return null;
  try {
    const d = JSON.parse(v) as { text?: unknown; thinking?: unknown };
    return {
      step,
      text: typeof d.text === "string" ? d.text : "",
      thinking: typeof d.thinking === "string" ? d.thinking : "",
    };
  } catch {
    return null;
  }
};

/**
 * Live drafts (spec 2026-11-07-run-input-and-live-drafts §3.2): what each step of a running run
 * has streamed so far, kept in Redis so a viewer that (re)connects on any replica gets the text
 * already shown, then the deltas from there on.
 *
 * The writer is the process executing the run: it holds the step's draft in memory (only for the
 * runs it executes; {@link release} drops them when the execution ends) and writes it at most once
 * per {@link DRAFT_FLUSH_MS}, on the first delta past the window (no timer), plus once when the
 * model stream ends ({@link flush}). Writes are issued before the delta is published, on the same
 * connection as the bus publish, so a viewer that sees a delta past its snapshot and asks again
 * gets a draft at least that far whenever that delta was written. Every write refreshes the
 * {@link DRAFT_TTL_SECONDS} TTL; {@link clear} deletes the step's draft once its
 * `assistant_message` is logged or the step is reset. Redis failures are logged, never thrown to
 * the run: a draft is a convenience, the log stays the truth.
 */
@Injectable()
export class RunDrafts {
  private readonly held = new Map<string, Held>();

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(KernelDb) private readonly kdb: KernelDb,
    @Inject(EventLog) private readonly eventLog: Pick<EventLog, "findByIdem">,
    @Inject(KERNEL_LOGGER) private readonly log: Pick<Logger, "warn">,
  ) {}

  private get db(): KernelSchemaDb {
    return this.kdb.db;
  }

  /** Adds a delta to the step's draft; writes it when the last write is a window old. */
  append(runId: string, step: number, channel: "text" | "thinking", text: string): void {
    let h = this.held.get(runId);
    if (h?.step !== step) {
      h = { step, text: "", thinking: "", writtenAt: Number.NEGATIVE_INFINITY, dirty: false };
      this.held.set(runId, h);
    }
    h[channel] += text;
    h.dirty = true;
    if (Date.now() - h.writtenAt >= DRAFT_FLUSH_MS) this.write(runId, h);
  }

  /** The end of the step's model stream: writes what the window still holds. */
  flush(runId: string, step: number): void {
    const h = this.held.get(runId);
    if (h?.step === step && h.dirty) this.write(runId, h);
  }

  /** Deletes the step's draft (its `assistant_message` is logged, or the step starts over). */
  clear(runId: string, step: number): void {
    if (this.held.get(runId)?.step === step) this.held.delete(runId);
    this.redis
      .multi()
      .del(draftKey(runId, step))
      .srem(stepsKey(runId), String(step))
      .exec()
      .catch((err) => this.log.warn("run draft clear failed", { runId, step, err }));
  }

  /**
   * Drops what this process holds for the run (its execution here ended: finished, suspended,
   * handed over). Redis keeps what was written: another worker may continue the run, and a step
   * that never ended is not shown once the run is no longer running (TTL removes it).
   */
  release(runId: string): void {
    this.held.delete(runId);
  }

  /** The run's steps with a draft, by step. */
  async read(runId: string): Promise<RunDraft[]> {
    const steps = (await this.redis.smembers(stepsKey(runId)))
      .map(Number)
      .filter((n) => Number.isSafeInteger(n))
      .sort((a, b) => a - b);
    if (steps.length === 0) return [];
    const values = await this.redis.mget(steps.map((s) => draftKey(runId, s)));
    return steps.flatMap((s, i) => parse(s, values[i] ?? null) ?? []);
  }

  /**
   * The drafts a viewer of the conversation is shown: steps of its running run (or only `runId`)
   * whose `assistant_message` is not logged. Redis is read before the log, so a step finalized
   * meanwhile is either skipped here or its `assistant_message` reaches the viewer after the draft.
   */
  async live(conversationId: string, runId?: string): Promise<LiveDraft[]> {
    let q = this.db
      .selectFrom("runs")
      .select("id")
      .where("conversation_id", "=", conversationId)
      .where("status", "=", "running");
    if (runId !== undefined) q = q.where("id", "=", runId);
    const out: LiveDraft[] = [];
    for (const run of await q.execute()) {
      for (const d of await this.read(run.id)) {
        const final = await this.eventLog.findByIdem(
          conversationId,
          assistantIdemKey(run.id, d.step),
        );
        if (final === undefined) out.push({ runId: run.id, ...d });
      }
    }
    return out;
  }

  /** Whether the run belongs to the conversation (the draft route's 404). */
  async runOf(conversationId: string, runId: string): Promise<boolean> {
    const row = await this.db
      .selectFrom("runs")
      .select("id")
      .where("id", "=", runId)
      .where("conversation_id", "=", conversationId)
      .executeTakeFirst();
    return row !== undefined;
  }

  private write(runId: string, h: Held): void {
    h.writtenAt = Date.now();
    h.dirty = false;
    const { step } = h;
    this.redis
      .multi()
      .set(
        draftKey(runId, step),
        JSON.stringify({ text: h.text, thinking: h.thinking }),
        "EX",
        DRAFT_TTL_SECONDS,
      )
      .sadd(stepsKey(runId), String(step))
      .expire(stepsKey(runId), DRAFT_TTL_SECONDS)
      .exec()
      .catch((err) => this.log.warn("run draft write failed", { runId, step, err }));
  }
}

/** What {@link streamSink} uses. */
export interface StreamSinkDeps {
  bus: Pick<ExtensionContext["bus"], "publish">;
  drafts: Pick<RunDrafts, "append" | "flush" | "clear">;
  log: Pick<Logger, "warn">;
}

/**
 * The run's stream sink (one per execution of a run): publishes deltas on the conversation's topic
 * (`conv.<id>`, shared with `{ kind: "events" }`, so a subscriber on any replica gets them) with
 * `offset`, the characters of that channel (text or thinking) this attempt of the step streamed
 * before the delta, and keeps the step's live draft. `step_reset` clears the draft and both
 * offsets; `stream_end` / `step_end` only flush / clear the draft and are not published. A failed
 * publish is only logged: deltas are drafts, the `assistant_message` in the log is the truth.
 */
export function streamSink(conversationId: string, deps: StreamSinkDeps): StreamSink {
  let at = { runId: "", step: -1, text: 0, thinking: 0 };
  const publish = (msg: ConversationBusMessage) =>
    deps.bus
      .publish(conversationTopic(conversationId), msg)
      .catch((err) => deps.log.warn("stream delta publish failed", { conversationId, err }));
  return (d) => {
    if (d.kind === "stream_end") return deps.drafts.flush(d.runId, d.step);
    if (d.kind === "step_end") return deps.drafts.clear(d.runId, d.step);
    if (at.runId !== d.runId || at.step !== d.step || d.kind === "step_reset") {
      at = { runId: d.runId, step: d.step, text: 0, thinking: 0 };
    }
    if (d.kind === "step_reset") {
      deps.drafts.clear(d.runId, d.step);
      void publish({ kind: "delta", runId: d.runId, step: d.step, delta: "step_reset" });
      return;
    }
    const text = d.text ?? "";
    const offset = at[d.kind];
    at[d.kind] += text.length;
    deps.drafts.append(d.runId, d.step, d.kind, text);
    void publish({ kind: "delta", runId: d.runId, step: d.step, delta: d.kind, text, offset });
  };
}
