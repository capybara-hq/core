import type { ConversationEvent } from "./conversations";
import type { DraftTool, RunDraftSnapshot } from "./run-drafts";
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

/** One streamed tool call as this connection handed it on: its input is a channel of its own. */
interface ToolDraft {
  name: string;
  input: ChannelDraft;
  inputTruncated: boolean;
  base?: { text: string; sha256: string };
}

/** What one connection knows of a step's draft. */
interface StepDraft {
  text: ChannelDraft;
  thinking: ChannelDraft;
  /** By call id, in the order the calls first showed. */
  tools: Map<string, ToolDraft>;
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

const toolDraft = (name: string): ToolDraft => ({
  name,
  input: { value: "", held: [] },
  inputTruncated: false,
});

/** The tools as the `draft` update carries them. */
function toolsOf(s: StepDraft): DraftTool[] {
  return [...s.tools].map(([id, t]) => {
    const tool: DraftTool = { id, name: t.name, input: t.input.value };
    if (t.inputTruncated) tool.inputTruncated = true;
    if (t.base !== undefined) tool.base = t.base;
    return tool;
  });
}

const holdsGap = (s: StepDraft): boolean =>
  s.text.held.length > 0 ||
  s.thinking.held.length > 0 ||
  [...s.tools.values()].some((t) => !t.inputTruncated && t.input.held.length > 0);

/**
 * The live drafts of one stream connection (spec 2026-11-07-run-input-and-live-drafts §4): turns
 * `event: draft` frames and offset-carrying deltas into gap-free updates for the stream's
 * `onDelta`. Per step and channel it keeps what it handed on, so it drops the deltas already held,
 * trims an overlapping one, and holds a channel's deltas past a gap (the other channel goes on)
 * while it reads the run's drafts again: {@link DRAFT_RETRY_MS}, then every
 * {@link DRAFT_SLOW_RETRY_MS} until the gap is covered or the step is finalized, reset or its run
 * ends. A read never shrinks what is shown: it is handed on only when it lengthened the step, as a
 * `draft` the reducer merges (the longer of each channel wins). An `event: draft` frame resyncs
 * both channels (`resync`: a channel that is a prefix of what the page shows keeps the longer,
 * since the store lags the screen by up to its coalescing window; any other replaces it); a
 * streamed tool call's input is one more channel per call id with the same rules (its deltas carry
 * the characters of that call's input before them), and its base is kept once; a
 * channel's delta at offset 0 while this connection holds nothing of it replaces that channel
 * alone (it starts over: whatever an earlier connection left is stale).
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

  /** `event: draft`: the step's draft at the open, resyncing both channels. */
  draft(d: {
    runId: string;
    step: number;
    text: string;
    thinking: string;
    tools: readonly DraftTool[];
  }): void {
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
    for (const t of d.tools) {
      const tool = toolDraft(t.name);
      tool.input.value = t.input;
      tool.inputTruncated = t.inputTruncated === true;
      if (t.base !== undefined) tool.base = t.base;
      s.tools.set(t.id, tool);
    }
    // A call this connection saw (or holds deltas of) since its open that the frame does not list
    // yet: the store lags the stream by its coalescing window, so it is kept. The frame's list is
    // then every call of the step this connection knows; the reducer drops any other (one an
    // earlier connection showed, before a `step_reset` during the disconnect).
    for (const [id, t] of old?.tools ?? []) {
      const tool = s.tools.get(id);
      if (tool === undefined) s.tools.set(id, t);
      else {
        tool.input.held = t.input.held;
        if (tool.base === undefined && t.base !== undefined) tool.base = t.base;
      }
    }
    for (const t of s.tools.values()) {
      if (t.inputTruncated) t.input.held = [];
      else applyHeld(t.input);
    }
    this.emit({
      runId: d.runId,
      step: d.step,
      delta: "draft",
      text: s.text.value,
      thinking: s.thinking.value,
      tools: toolsOf(s),
      resync: true,
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
    if (d.delta === "tool_start" || d.delta === "tool_base") {
      this.toolEvent(key, d);
      return;
    }
    // a text, thinking or tool_input delta always carries its offset (the kernel's delta frame)
    const offset = d.offset as number;
    const text = d.text ?? "";
    if (text === "") return;
    const s = this.steps.get(key) ?? this.create(key);
    let tool: ToolDraft | undefined;
    if (d.delta === "tool_input") {
      if (d.callId === undefined) return;
      tool = s.tools.get(d.callId);
      if (tool === undefined) {
        tool = toolDraft(d.name ?? "");
        s.tools.set(d.callId, tool);
      }
    }
    const ch = d.delta as Channel;
    const c = tool !== undefined ? tool.input : s[ch];
    const startOver = (): void => {
      c.value = text;
      this.emit(
        tool !== undefined
          ? {
              runId: d.runId,
              step: d.step,
              delta: "draft",
              tools: [{ id: d.callId as string, name: tool.name, input: text }],
              replace: true,
            }
          : { runId: d.runId, step: d.step, delta: "draft", [ch]: text, replace: true },
      );
    };
    if (c.held.length > 0) {
      c.held.push(d);
      return;
    }
    if (offset === 0 && c.value === "") {
      // the channel starts over: it replaces what an earlier connection left of it, nothing else
      startOver();
      return;
    }
    const tail = append(c, offset, text);
    if (tail === null) {
      // a truncated call's draft stops short of the stream: nothing to wait for, nothing to read
      if (tool?.inputTruncated) return;
      c.held.push(d);
      this.readAgain(d.runId, d.step, s);
    } else if (tail !== "") {
      this.emit({ ...d, text: tail, offset: c.value.length - tail.length });
    }
  }

  /** `tool_start` (the call exists) and `tool_base` (kept once) pass through, recorded here. */
  private toolEvent(key: string, d: StreamDelta): void {
    if (d.callId === undefined) return;
    const s = this.steps.get(key) ?? this.create(key);
    let tool = s.tools.get(d.callId);
    if (tool === undefined) {
      tool = toolDraft(d.name ?? "");
      s.tools.set(d.callId, tool);
    } else if (d.name !== undefined && tool.name === "") {
      tool.name = d.name;
    }
    if (d.delta === "tool_base") {
      if (tool.base !== undefined || d.text === undefined || d.sha256 === undefined) return;
      tool.base = { text: d.text, sha256: d.sha256 };
    }
    this.emit(d);
  }

  private ignored(runId: string, key: string): boolean {
    return this.finalized.has(key) || this.closedRuns.has(runId);
  }

  private create(key: string): StepDraft {
    const s: StepDraft = {
      text: { value: "", held: [] },
      thinking: { value: "", held: [] },
      tools: new Map(),
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
    if (!holdsGap(s)) {
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
        for (const st of got?.tools ?? []) {
          let tool = s.tools.get(st.id);
          if (tool === undefined) {
            tool = toolDraft(st.name);
            s.tools.set(st.id, tool);
            changed = true;
          }
          if (st.input.length > tool.input.value.length) {
            tool.input.value = st.input;
            changed = true;
          }
          if (st.inputTruncated === true && !tool.inputTruncated) {
            tool.inputTruncated = true;
            tool.input.held = [];
            changed = true;
          }
          if (tool.base === undefined && st.base !== undefined) {
            tool.base = st.base;
            changed = true;
          }
        }
        for (const t of s.tools.values()) if (applyHeld(t.input)) changed = true;
        if (changed)
          this.emit({
            runId,
            step,
            delta: "draft",
            text: s.text.value,
            thinking: s.thinking.value,
            tools: toolsOf(s),
          });
        this.readAgain(runId, step, s);
      };
      this.read(runId).then(done, () => done([]));
    }, wait);
  }
}
