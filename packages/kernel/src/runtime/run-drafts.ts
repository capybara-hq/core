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
/**
 * UTF-8 bytes of tool input plus bases one step's draft keeps (streaming tool input spec §4); past
 * it a call is marked `inputTruncated` and its later fragments are only published.
 */
export const DRAFT_TOOL_INPUT_MAX = 512 * 1024;

/** One step's draft: `{ text, thinking, tools }` as JSON (spec 2026-11-07 §3.2). */
export const draftKey = (runId: string, step: number): string => `capk:run-draft:${runId}:${step}`;
/** The steps of a run that have a draft (a set, so a reader finds them without a key scan). */
const stepsKey = (runId: string): string => `capk:run-draft-steps:${runId}`;

/** A tool call a step streams (display only: the logged `assistant_message` is what runs). */
export interface DraftTool {
  id: string;
  name: string;
  /** The head of the call's JSON input as streamed (not parseable until it is complete). */
  input: string;
  /** The step's {@link DRAFT_TOOL_INPUT_MAX} was reached: later fragments are not in the draft. */
  inputTruncated?: true;
  /** The file a streaming `Write` replaces (streaming tool input spec §4.1). */
  base?: DraftBase;
}

/**
 * A streaming `Write`'s base: exact, or a guess (spec 2026-11-27 §4.4) naming the candidate's path
 * until the path's verdict. A rejected guess stays, marked, so a lagging draft never brings it back.
 */
export interface DraftBase {
  text: string;
  sha256: string;
  guess?: { path: string };
  verdict?: "confirmed" | "rejected";
}

/**
 * The base a call keeps when `got` arrives (spec 2026-11-27 §4.4): the first one; an exact base
 * replaces a guess not confirmed; the same guess takes a verdict it lacks.
 */
export function mergeDraftBase(
  prev: DraftBase | undefined,
  got: DraftBase | undefined,
): DraftBase | undefined {
  if (got === undefined) return prev;
  if (prev === undefined) return got;
  // an exact base replaces a guess not confirmed: it is only read after a rejection, so a copy
  // that still shows the guess missed the verdict
  if (prev.guess !== undefined && prev.verdict !== "confirmed" && got.guess === undefined)
    return got;
  if (
    prev.verdict === undefined &&
    got.verdict !== undefined &&
    prev.sha256 === got.sha256 &&
    prev.guess?.path === got.guess?.path
  )
    return { ...prev, verdict: got.verdict };
  return prev;
}

/** What one step of a run has streamed so far. */
export interface RunDraft {
  step: number;
  text: string;
  thinking: string;
  tools: DraftTool[];
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
  tools: DraftTool[];
  /** UTF-8 bytes of tool input and bases held, against {@link DRAFT_TOOL_INPUT_MAX}. */
  toolBytes: number;
  /** When the draft was last written (`-Infinity`: never, so the first delta writes at once). */
  writtenAt: number;
  dirty: boolean;
  /** The one trailing write armed while something is held (cancelled by a write, clear, release). */
  timer: NodeJS.Timeout | undefined;
}

const isRecord = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);

const parseTool = (x: unknown): DraftTool[] => {
  if (!isRecord(x) || typeof x.id !== "string" || typeof x.name !== "string") return [];
  const t: DraftTool = {
    id: x.id,
    name: x.name,
    input: typeof x.input === "string" ? x.input : "",
  };
  if (x.inputTruncated === true) t.inputTruncated = true;
  const b = x.base;
  if (isRecord(b) && typeof b.text === "string" && typeof b.sha256 === "string") {
    const base: DraftBase = { text: b.text, sha256: b.sha256 };
    if (isRecord(b.guess) && typeof b.guess.path === "string") base.guess = { path: b.guess.path };
    if (base.guess !== undefined && (b.verdict === "confirmed" || b.verdict === "rejected"))
      base.verdict = b.verdict;
    t.base = base;
  }
  return [t];
};

const parse = (step: number, v: string | null): RunDraft | null => {
  if (v === null) return null;
  try {
    const d = JSON.parse(v) as { text?: unknown; thinking?: unknown; tools?: unknown };
    return {
      step,
      text: typeof d.text === "string" ? d.text : "",
      thinking: typeof d.thinking === "string" ? d.thinking : "",
      tools: Array.isArray(d.tools) ? d.tools.flatMap(parseTool) : [],
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
 * per {@link DRAFT_FLUSH_MS}: on the first delta past the window, or, when deltas stop inside it,
 * by one trailing one-shot timer per held step (process-local, unref'd, cancelled by a write,
 * {@link clear} and {@link release}), plus once when the model stream ends ({@link flush}). Writes are issued before the delta is published, on the same
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
    const h = this.heldFor(runId, step);
    h[channel] += text;
    this.changed(runId, h);
  }

  /** A tool call the step starts streaming (a call id seen again keeps what it has). */
  startTool(runId: string, step: number, callId: string, name: string): void {
    const h = this.heldFor(runId, step);
    if (h.tools.some((t) => t.id === callId)) return;
    h.tools.push({ id: callId, name, input: "" });
    this.changed(runId, h);
  }

  /**
   * Adds a fragment of a call's input. Past {@link DRAFT_TOOL_INPUT_MAX} for the step the call is
   * marked `inputTruncated` and keeps its head: later fragments are only published.
   */
  appendToolInput(runId: string, step: number, callId: string, text: string): void {
    const h = this.heldFor(runId, step);
    const t = h.tools.find((x) => x.id === callId);
    if (t === undefined || t.inputTruncated) return;
    const bytes = Buffer.byteLength(text);
    if (h.toolBytes + bytes > DRAFT_TOOL_INPUT_MAX) t.inputTruncated = true;
    else {
      t.input += text;
      h.toolBytes += bytes;
    }
    this.changed(runId, h);
  }

  /**
   * The file a streaming `Write` replaces (exact, or a guess); kept by {@link mergeDraftBase} and
   * only within {@link DRAFT_TOOL_INPUT_MAX}, which bases share with the input (spec: "input plus
   * base"). Like {@link appendToolInput}, it ignores a call never started.
   */
  setToolBase(
    runId: string,
    step: number,
    callId: string,
    base: { text: string; sha256: string; guess?: { path: string } },
  ): void {
    const h = this.heldFor(runId, step);
    const t = h.tools.find((x) => x.id === callId);
    if (t === undefined) return;
    const got: DraftBase = { text: base.text, sha256: base.sha256 };
    if (base.guess !== undefined) got.guess = { path: base.guess.path };
    if (mergeDraftBase(t.base, got) !== got) return;
    const bytes = Buffer.byteLength(base.text);
    if (h.toolBytes + bytes > DRAFT_TOOL_INPUT_MAX) return;
    t.base = got;
    h.toolBytes += bytes;
    this.changed(runId, h);
  }

  /**
   * The verdict on a call's guessed base (spec 2026-11-27 §4.4): kept on a guess without one; a
   * call without a guessed base ignores it.
   */
  setToolBaseVerdict(runId: string, step: number, callId: string, confirmed: boolean): void {
    const h = this.heldFor(runId, step);
    const t = h.tools.find((x) => x.id === callId);
    if (t?.base?.guess === undefined || t.base.verdict !== undefined) return;
    t.base = { ...t.base, verdict: confirmed ? "confirmed" : "rejected" };
    this.changed(runId, h);
  }

  /** The step's held draft, a fresh one when the run moved to another step. */
  private heldFor(runId: string, step: number): Held {
    let h = this.held.get(runId);
    if (h?.step !== step) {
      if (h) this.drop(runId, h);
      h = {
        step,
        text: "",
        thinking: "",
        tools: [],
        toolBytes: 0,
        writtenAt: Number.NEGATIVE_INFINITY,
        dirty: false,
        timer: undefined,
      };
      this.held.set(runId, h);
    }
    return h;
  }

  /** The held draft changed: written now when the last write is a window old, else held. */
  private changed(runId: string, h: Held): void {
    const { step } = h;
    h.dirty = true;
    const elapsed = Date.now() - h.writtenAt;
    if (elapsed >= DRAFT_FLUSH_MS) this.write(runId, h);
    else if (h.timer === undefined) {
      // held: written when the window ends even if no delta follows (a tool input, a pause)
      h.timer = setTimeout(() => {
        h.timer = undefined;
        this.flush(runId, step);
      }, DRAFT_FLUSH_MS - elapsed).unref();
    }
  }

  /** The end of the step's model stream: writes what the window still holds. */
  flush(runId: string, step: number): void {
    const h = this.held.get(runId);
    if (h?.step === step && h.dirty) this.write(runId, h);
  }

  /** Deletes the step's draft (its `assistant_message` is logged, or the step starts over). */
  clear(runId: string, step: number): void {
    const h = this.held.get(runId);
    if (h?.step === step) this.drop(runId, h);
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
    const h = this.held.get(runId);
    if (h) this.drop(runId, h);
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

  private drop(runId: string, h: Held): void {
    clearTimeout(h.timer);
    h.timer = undefined;
    this.held.delete(runId);
  }

  private write(runId: string, h: Held): void {
    clearTimeout(h.timer);
    h.timer = undefined;
    h.writtenAt = Date.now();
    h.dirty = false;
    const { step } = h;
    this.redis
      .multi()
      .set(
        draftKey(runId, step),
        JSON.stringify({ text: h.text, thinking: h.thinking, tools: h.tools }),
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
  drafts: Pick<
    RunDrafts,
    | "append"
    | "flush"
    | "clear"
    | "startTool"
    | "appendToolInput"
    | "setToolBase"
    | "setToolBaseVerdict"
  >;
  log: Pick<Logger, "warn">;
}

/**
 * The run's stream sink (one per execution of a run): publishes deltas on the conversation's topic
 * (`conv.<id>`, shared with `{ kind: "events" }`, so a subscriber on any replica gets them) with
 * `offset`, the characters of that channel (text or thinking) this attempt of the step streamed
 * before the delta, and keeps the step's live draft. Tool calls (streaming tool input spec §4):
 * `tool_start`, `tool_base` and `tool_base_verdict` carry no offset, `tool_input`'s `offset` is the characters of that
 * call's input this attempt streamed before the delta. `step_reset` clears the draft and every
 * offset; `stream_end` / `step_end` only flush / clear the draft and are not published. A failed
 * publish is only logged: deltas are drafts, the `assistant_message` in the log is the truth.
 */
export function streamSink(conversationId: string, deps: StreamSinkDeps): StreamSink {
  let at = { runId: "", step: -1, text: 0, thinking: 0, tools: new Map<string, number>() };
  const publish = (msg: ConversationBusMessage) =>
    deps.bus
      .publish(conversationTopic(conversationId), msg)
      .catch((err) => deps.log.warn("stream delta publish failed", { conversationId, err }));
  return (d) => {
    if (d.kind === "stream_end") return deps.drafts.flush(d.runId, d.step);
    if (d.kind === "step_end") return deps.drafts.clear(d.runId, d.step);
    if (at.runId !== d.runId || at.step !== d.step || d.kind === "step_reset") {
      at = { runId: d.runId, step: d.step, text: 0, thinking: 0, tools: new Map() };
    }
    if (d.kind === "step_reset") {
      deps.drafts.clear(d.runId, d.step);
      void publish({ kind: "delta", runId: d.runId, step: d.step, delta: "step_reset" });
      return;
    }
    const { runId, step } = d;
    const text = d.text ?? "";
    if (
      d.kind === "tool_start" ||
      d.kind === "tool_input" ||
      d.kind === "tool_base" ||
      d.kind === "tool_base_verdict"
    ) {
      const callId = d.callId ?? "";
      if (d.kind === "tool_start") {
        const name = d.name ?? "";
        deps.drafts.startTool(runId, step, callId, name);
        void publish({ kind: "delta", runId, step, delta: "tool_start", callId, name });
      } else if (d.kind === "tool_input") {
        const offset = at.tools.get(callId) ?? 0;
        at.tools.set(callId, offset + text.length);
        deps.drafts.appendToolInput(runId, step, callId, text);
        void publish({ kind: "delta", runId, step, delta: "tool_input", callId, text, offset });
      } else if (d.kind === "tool_base_verdict") {
        const confirmed = d.confirmed === true;
        deps.drafts.setToolBaseVerdict(runId, step, callId, confirmed);
        void publish({ kind: "delta", runId, step, delta: "tool_base_verdict", callId, confirmed });
      } else {
        const sha256 = d.sha256 ?? "";
        const guess = d.guess;
        deps.drafts.setToolBase(runId, step, callId, {
          text,
          sha256,
          ...(guess !== undefined && { guess }),
        });
        void publish({
          kind: "delta",
          runId,
          step,
          delta: "tool_base",
          callId,
          text,
          sha256,
          ...(guess !== undefined && { guess }),
        });
      }
      return;
    }
    const offset = at[d.kind];
    at[d.kind] += text.length;
    deps.drafts.append(runId, step, d.kind, text);
    void publish({ kind: "delta", runId, step, delta: d.kind, text, offset });
  };
}
