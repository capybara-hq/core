import type { ConversationEvent } from "./conversations";
import type { RunDraftSnapshot } from "./run-drafts";
import type { StreamDelta } from "./stream";

/**
 * The waits before the quick draft reads of one gap (ms): the kernel may publish a delta up to its
 * coalescing window (200 ms) before the draft holding it is written, so a read can come back short.
 * After them the reads go on every {@link DRAFT_SLOW_RETRY_MS} while the step is still streaming.
 */
export const DRAFT_RETRY_MS: readonly number[] = [0, 100, 200, 400, 800, 1600];
/** The wait between the reads that follow the quick ones, until the gap is covered or the step ends. */
export const DRAFT_SLOW_RETRY_MS = 5000;

type Channel = "text" | "thinking";
const CHANNELS: readonly Channel[] = ["text", "thinking"];
const TERMINAL = new Set<ConversationEvent["type"]>(["run_finished", "run_failed", "run_aborted"]);
const stepKey = (runId: string, step: number) => `${runId}:${step}`;

/** One channel of a step as this connection handed it on. */
interface ChannelDraft {
  value: string;
  /** The deltas past a gap in this channel, applied once a draft read covers up to them. */
  held: StreamDelta[];
}

/** What one connection knows of a step's draft. */
interface StepDraft {
  text: ChannelDraft;
  thinking: ChannelDraft;
  /** The draft reads of the current gap so far. */
  attempts: number;
  timer: ReturnType<typeof setTimeout> | null;
  /** A read is in flight. */
  reading: boolean;
}

/** Appends what is new of a delta: `""` when held already, `null` past a gap, else the tail. */
function append(c: ChannelDraft, offset: number, text: string): string | null {
  const have = c.value.length;
  if (offset > have) return null;
  if (offset + text.length <= have) return "";
  const tail = text.slice(have - offset);
  c.value += tail;
  return tail;
}

/** Applies the held deltas that now follow on (in offset order); true when it changed the channel. */
function applyHeld(c: ChannelDraft): boolean {
  if (c.held.length === 0) return false;
  const before = c.value;
  const held = [...c.held].sort((a, b) => (a.offset ?? 0) - (b.offset ?? 0));
  // the deltas after the first one left past the gap are past it too
  c.held = held.filter((d) => append(c, d.offset ?? 0, d.text ?? "") === null);
  return c.value !== before;
}

/**
 * The live drafts of one stream connection (spec 2026-11-07-run-input-and-live-drafts §4): turns
 * `event: draft` frames and offset-carrying deltas into gap-free updates for the stream's
 * `onDelta`. Per step and channel it keeps what it handed on, so it drops the deltas already held,
 * trims an overlapping one, and holds a channel's deltas past a gap (the other channel goes on)
 * while it reads the run's drafts again: {@link DRAFT_RETRY_MS}, then every
 * {@link DRAFT_SLOW_RETRY_MS} until the gap is covered or the step is finalized, reset or its run
 * ends. A read never shrinks what is shown: it is handed on only when it lengthened the step, as a
 * `draft` the reducer merges (the longer of each channel wins). Only an `event: draft` frame
 * replaces both channels; a channel's delta at offset 0 while this connection holds nothing of it
 * replaces that channel alone (it starts over: whatever an earlier connection left is stale).
 * Client state of one browser connection only (nothing shared across requests).
 */
export class LiveDrafts {
  private readonly steps = new Map<string, StepDraft>();
  private readonly finalized = new Set<string>();
  private readonly closedRuns = new Set<string>();
  /** Raised by every (re)open and the close: a read answered for an earlier one is dropped. */
  private epoch = 0;

  constructor(
    private readonly emit: (d: StreamDelta) => void,
    private readonly read: (runId: string) => Promise<RunDraftSnapshot[]>,
  ) {}

  /** A (re)connect: the server sends its `event: draft` frames again; earlier gaps are moot. */
  reset(): void {
    this.epoch++;
    for (const s of this.steps.values()) if (s.timer !== null) clearTimeout(s.timer);
    this.steps.clear();
  }

  close(): void {
    this.reset();
  }

  event(e: ConversationEvent): void {
    if (e.runId === null) return;
    if (e.type === "assistant_message") {
      const key = stepKey(e.runId, e.payload.step);
      this.finalized.add(key);
      this.drop(key);
    } else if (TERMINAL.has(e.type)) {
      this.closedRuns.add(e.runId);
      for (const key of [...this.steps.keys()]) if (key.startsWith(`${e.runId}:`)) this.drop(key);
    }
  }

  /** `event: draft`: the step's draft at the open, replacing both channels. */
  draft(d: { runId: string; step: number; text: string; thinking: string }): void {
    const key = stepKey(d.runId, d.step);
    if (this.ignored(d.runId, key)) return;
    const old = this.steps.get(key);
    this.drop(key);
    const s = this.create(key);
    s.text.value = d.text;
    s.thinking.value = d.thinking;
    for (const ch of CHANNELS) {
      s[ch].held = old?.[ch].held ?? [];
      applyHeld(s[ch]);
    }
    this.emit({
      runId: d.runId,
      step: d.step,
      delta: "draft",
      text: s.text.value,
      thinking: s.thinking.value,
      replace: true,
    });
    this.readAgain(d.runId, d.step, s);
  }

  delta(d: StreamDelta): void {
    const key = stepKey(d.runId, d.step);
    if (this.ignored(d.runId, key)) return;
    if (d.delta === "step_reset") {
      this.drop(key);
      this.emit(d);
      return;
    }
    if (d.delta === "draft") return;
    // a delta without an offset (an older kernel): handed on as it is
    if (d.offset === undefined) {
      this.emit(d);
      return;
    }
    const text = d.text ?? "";
    if (text === "") return;
    const ch: Channel = d.delta;
    const s = this.steps.get(key) ?? this.create(key);
    const c = s[ch];
    if (c.held.length > 0) {
      c.held.push(d);
      return;
    }
    if (d.offset === 0 && c.value === "") {
      // the channel starts over: it replaces what an earlier connection left of it, nothing else
      c.value = text;
      this.emit({ runId: d.runId, step: d.step, delta: "draft", [ch]: text, replace: true });
      return;
    }
    const tail = append(c, d.offset, text);
    if (tail === null) {
      c.held.push(d);
      this.readAgain(d.runId, d.step, s);
    } else if (tail !== "") {
      this.emit({ ...d, text: tail, offset: c.value.length - tail.length });
    }
  }

  private ignored(runId: string, key: string): boolean {
    return this.finalized.has(key) || this.closedRuns.has(runId);
  }

  private create(key: string): StepDraft {
    const s: StepDraft = {
      text: { value: "", held: [] },
      thinking: { value: "", held: [] },
      attempts: 0,
      timer: null,
      reading: false,
    };
    this.steps.set(key, s);
    return s;
  }

  private drop(key: string): void {
    const s = this.steps.get(key);
    if (s?.timer != null) clearTimeout(s.timer);
    this.steps.delete(key);
  }

  /** Schedules the next draft read while a channel holds deltas past a gap (none left: done). */
  private readAgain(runId: string, step: number, s: StepDraft): void {
    if (s.text.held.length === 0 && s.thinking.held.length === 0) {
      s.attempts = 0;
      return;
    }
    if (s.reading || s.timer !== null) return;
    const wait = DRAFT_RETRY_MS[s.attempts] ?? DRAFT_SLOW_RETRY_MS;
    s.attempts++;
    const epoch = this.epoch;
    const key = stepKey(runId, step);
    const current = () => epoch === this.epoch && this.steps.get(key) === s;
    s.timer = setTimeout(() => {
      s.timer = null;
      if (!current()) return;
      s.reading = true;
      const done = (drafts: RunDraftSnapshot[]) => {
        s.reading = false;
        if (!current()) return;
        const got = drafts.find((x) => x.step === step);
        let changed = false;
        for (const ch of CHANNELS) {
          // the stored draft and what this connection holds are prefixes of one stream
          const stored = got?.[ch] ?? "";
          if (stored.length > s[ch].value.length) {
            s[ch].value = stored;
            changed = true;
          }
          if (applyHeld(s[ch])) changed = true;
        }
        if (changed)
          this.emit({
            runId,
            step,
            delta: "draft",
            text: s.text.value,
            thinking: s.thinking.value,
          });
        this.readAgain(runId, step, s);
      };
      this.read(runId).then(done, () => done([]));
    }, wait);
  }
}
