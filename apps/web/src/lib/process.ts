import type { DividerData, TimelineEntry, TimelineSubagent } from "./timeline";

/**
 * Process blocks (conversation process blocks spec §1–§5): a pure pass after the timeline
 * ({@link groupProcess}) that folds a run's thinking, narration and tool calls into one `process`
 * entry per stretch of the run and routes the cards by class, so the thread reads as block →
 * blocking cards → pending actions → files and output cards → answer.
 *
 * - A block opens at the first thinking, narration, tool group, process card, network fact or
 *   single synchronous sub-agent (a `subagents` entry with one row that is not in the background,
 *   spec §10.3). Its key is its first entry's step (`p<runId>:<step>`), the same for a streaming
 *   draft and the step once logged, so the block keeps its key while its first step lands.
 * - It closes at an answer (prose that is not narration), a user message, a sub-agent task or
 *   report, a sub-agent group of two or more rows or a background one, a divider other than a
 *   fallback or a compaction, or the run's `run` entry; a fallback or a compaction inside an open
 *   block is a `note` step.
 * - Every block of a run takes the run's end (`finished`, `stopped`, `failed`) from its `run` row;
 *   the run's last block also its working time. While the run goes, its latest block carries the
 *   run's working clock (`clock`, from the caller's `runStats`), so the head counts from the run's
 *   start; earlier blocks of the run carry none (they show no time).
 * - An undecided approval, question or connect, a device code and a sub-agent's wait stand outside,
 *   right after the block (the block is `waiting` while one is undecided); once decided an
 *   approval or question is a `decided` step at its place in the rail, a connect once its run
 *   ended (until then it still offers Connect).
 * - Handoffs and reveals of a turn (up to the next message that starts a run, so across the blocks
 *   a sub-agent group or a queued message splits) merge into one `pending` entry, after the
 *   blocking cards of the turn's last block; `output` cards, files, sub-agent deliveries and
 *   background task notices follow each block, in log order.
 * - A run that finishes (`ok`) with no answer after its last narration draws that narration again
 *   as its answer prose, right before its `run` row (it stays a narration step in the block too).
 * - `pinned` cards: the latest per (plugin, view) of a run, in first-seen order, sit on the run's
 *   latest block that wrote one (earlier versions are only their call's rail row); after a
 *   `failed` / `stopped` run they stand outside, right after that block. `process` cards stay as
 *   steps after their tools step.
 */

type Entry<K extends TimelineEntry["kind"]> = Extract<TimelineEntry, { kind: K }>;

export type ProcessStep =
  | Entry<"thinking" | "tools" | "network-facts" | "card">
  | { kind: "narration"; key: string; text: string; streaming: boolean }
  | { kind: "subagent"; key: string; row: TimelineSubagent }
  | { kind: "note"; key: string; note: "fallback" | "compacted"; divider: DividerData }
  | { kind: "decided"; key: string; entry: Entry<"approval" | "question" | "connect"> };

export type ProcessEntry = {
  kind: "process";
  key: string;
  /** The run the block belongs to, when its entries name it (steps, tool rows, the run row). */
  runId: string | null;
  state: "running" | "waiting" | "finished" | "stopped" | "failed";
  steps: ProcessStep[];
  /** The run's pinned cards: the latest per (plugin, view), in first-seen order; empty if none. */
  pinned: Entry<"card">[];
  /** The run's working time on the run's last block once it ended (its `run` row), else null. */
  durationMs: number | null;
  /**
   * The going run's working clock on its latest block while that block is live (running or
   * waiting), else null: its working time since `run_started` (waits for a person left out) up to
   * `resumedAt`, when it last started working (null while it waits). The head's elapsed time.
   */
  clock: { workedMs: number; resumedAt: number | null } | null;
  /** Background tasks the block started that are still running. */
  backgroundRunning: number;
};

export type PendingEntry = {
  kind: "pending";
  key: string;
  items: Entry<"handoff" | "reveal">[];
};

export type ThreadEntry =
  | Exclude<TimelineEntry, { kind: "thinking" | "tools" | "network-facts" | "handoff" | "reveal" }>
  | ProcessEntry
  | PendingEntry;

/** The going run's working clock, as `runStats` reads it from the log. */
export type RunClockState = { runId: string | null; workedMs: number; resumedAt: number | null };

/** The cards that wait for a person: outside the block, right after it. */
type Blocking = Entry<"approval" | "question" | "connect" | "device-code" | "subagent-wait">;

interface OpenBlock {
  block: ProcessEntry;
  blocking: Blocking[];
  /** Output cards, files and notices, in log order. */
  outputs: ThreadEntry[];
}

/** The run an entry names, or null. */
function runIdOf(e: TimelineEntry): string | null {
  if ((e.kind === "thinking" || e.kind === "prose" || e.kind === "tools") && e.step)
    return e.step.runId;
  if (e.kind === "subagents" && e.step) return e.step.runId;
  if (e.kind === "reveal") return e.runId;
  return null;
}

/** The step an entry came from, as a block key part (`<runId>:<step>`), or null. */
function stepKeyOf(e: TimelineEntry): string | null {
  const at =
    e.kind === "thinking" || e.kind === "prose" || e.kind === "tools" || e.kind === "subagents"
      ? e.step
      : undefined;
  return at === undefined ? null : `${at.runId}:${at.step}`;
}

/** The tool rows of a block's steps. */
const toolsOf = (b: ProcessEntry) => b.steps.flatMap((s) => (s.kind === "tools" ? s.rows : []));

/** Whether an approval, question or connect has been decided (a connect: its call went on). */
function decided(e: Entry<"approval" | "question" | "connect">, b: ProcessEntry | null): boolean {
  if (e.kind === "approval") return e.item.decided !== null;
  if (e.kind === "question") return e.item.answered !== null;
  const call = b === null ? undefined : toolsOf(b).find((t) => t.callId === e.item.callId);
  return call !== undefined && call.row.waiting !== "connect";
}

/**
 * Whether a blocking card folds into the rail as a `decided` step: an approval or question once
 * decided; a connect only once its run ended. A connect's call goes on without waiting for the
 * person (its result says the connector is not connected), so while the run goes on the card
 * still offers Connect and stays outside: folded into a block that closes at the answer, its
 * button would vanish under the person's hand.
 */
function folds(e: Entry<"approval" | "question" | "connect">, b: ProcessEntry | null): boolean {
  return e.kind === "connect" ? e.item.closed : decided(e, b);
}

/** Waiting for a person: an undecided card outside, a row waiting, a device code's call running. */
function waits(o: OpenBlock): boolean {
  const rows = toolsOf(o.block);
  for (const c of o.blocking) {
    if (c.kind === "approval" || c.kind === "question" || c.kind === "connect") {
      if (!decided(c, o.block)) return true;
    } else if (c.kind === "device-code") {
      const call = rows.find((t) => t.callId === c.callId);
      if (call !== undefined && (call.row.status === "running" || call.row.status === "pending"))
        return true;
    }
  }
  if (rows.some((t) => t.row.waiting !== undefined)) return true;
  return o.block.steps.some((s) => s.kind === "subagent" && s.row.row.status === "waiting");
}

/**
 * Folds each stretch of a run into one `process` entry and orders the cards around it (spec §1–§5;
 * the rules are in this module's header). Pure: the timeline's entry objects are reused.
 */
export function groupProcess(
  entries: readonly TimelineEntry[],
  run?: RunClockState,
): ThreadEntry[] {
  const finishedTasks = new Set<string>();
  for (const e of entries) if (e.kind === "background") finishedTasks.add(e.taskId);

  const out: ThreadEntry[] = [];
  const s: {
    /** The block being filled, with what stands after it. */
    open: OpenBlock | null;
    /** Blocks since the last run row: the next run row settles those of its run (or of none). */
    unsettled: ProcessEntry[];
    /** A run is going (a block opened since the last run row): a message now is taken in by it. */
    inRun: boolean;
    /** The turn's handoffs and reveals, and where their pending entry goes in `out`. */
    turn: { items: Entry<"handoff" | "reveal">[]; slot: number | null };
    /** The latest narration with no answer after it (the run's answer if it finishes so). */
    unanswered: Entry<"prose"> | null;
  } = {
    open: null,
    unsettled: [],
    inRun: false,
    turn: { items: [], slot: null },
    unanswered: null,
  };
  /** Run → its pinned cards by (plugin, view) and the block that shows them. */
  const pinnedOf = new Map<string, { block: ProcessEntry; cards: Map<string, Entry<"card">> }>();
  const usedKeys = new Set<string>();

  const noteRun = (b: ProcessEntry, e: TimelineEntry) => {
    if (b.runId !== null) return;
    const runId = runIdOf(e);
    if (runId !== null) b.runId = runId;
  };
  /** A key both a draft and its logged step give (made unique when a step opens two blocks). */
  const blockKey = (first: TimelineEntry) => {
    const base = `p${stepKeyOf(first) ?? first.key}`;
    let key = base;
    for (let n = 2; usedKeys.has(key); n++) key = `${base}:${n}`;
    usedKeys.add(key);
    return key;
  };
  const ensure = (first: TimelineEntry): OpenBlock => {
    if (s.open === null) {
      s.inRun = true;
      s.open = {
        block: {
          kind: "process",
          key: blockKey(first),
          runId: null,
          state: "running",
          steps: [],
          pinned: [],
          durationMs: null,
          clock: null,
          backgroundRunning: 0,
        },
        blocking: [],
        outputs: [],
      };
    }
    noteRun(s.open.block, first);
    return s.open;
  };
  const addStep = (e: TimelineEntry, step: ProcessStep) => ensure(e).block.steps.push(step);
  /** Places the turn's pending entry (after the blocking cards of its last block) and ends it. */
  const endTurn = () => {
    const { items, slot } = s.turn;
    s.turn = { items: [], slot: null };
    if (items.length === 0) return;
    const entry: PendingEntry = {
      kind: "pending",
      key: `pending:${items[0]?.key ?? ""}`,
      items,
    };
    out.splice(slot ?? out.length, 0, entry);
  };
  /**
   * Closes the open block: `ended` when its stretch is over, `live` when the run still goes on past
   * it (a streaming answer, a message not taken in yet, the end of the timeline).
   */
  const close = (how: "ended" | "live") => {
    const o = s.open;
    if (o === null) return;
    s.open = null;
    const b = o.block;
    b.state = how === "ended" ? "finished" : waits(o) ? "waiting" : "running";
    b.backgroundRunning = toolsOf(b).filter(
      (t) =>
        t.background?.taskId != null &&
        t.row.status === "done" &&
        !finishedTasks.has(t.background.taskId),
    ).length;
    out.push(b, ...o.blocking);
    s.turn.slot = out.length;
    out.push(...o.outputs);
    s.unsettled.push(b);
  };
  /** Outside the block when one is open (after it, by class), else at its place. */
  const outside = (e: ThreadEntry, bucket: "blocking" | "outputs") => {
    if (s.open === null) out.push(e);
    else if (bucket === "blocking") s.open.blocking.push(e as Blocking);
    else s.open.outputs.push(e);
  };
  const pin = (e: Entry<"card">) => {
    const b = ensure(e).block;
    const runId = b.runId;
    if (runId === null) {
      // no run named yet: the latest per (plugin, view) on this block alone
      const i = b.pinned.findIndex((c) => c.plugin === e.plugin && c.view === e.view);
      if (i < 0) b.pinned.push(e);
      else b.pinned[i] = e;
      return;
    }
    let p = pinnedOf.get(runId);
    if (p === undefined) {
      p = { block: b, cards: new Map() };
      pinnedOf.set(runId, p);
    }
    if (p.block !== b) {
      p.block.pinned = [];
      p.block = b;
    }
    // a Map keeps a key's first-seen position when its value is replaced
    p.cards.set(`${e.plugin}\u0000${e.view}`, e);
    b.pinned = [...p.cards.values()];
  };

  for (const e of entries) {
    switch (e.kind) {
      case "thinking":
      case "tools":
      case "network-facts":
        addStep(e, e);
        break;
      case "prose":
        if (e.narration) {
          addStep(e, { kind: "narration", key: e.key, text: e.text, streaming: e.streaming });
          if (e.text.trim() !== "") s.unanswered = e;
        } else {
          if (e.text.trim() !== "") s.unanswered = null;
          if (s.open !== null) noteRun(s.open.block, e);
          close(e.streaming ? "live" : "ended");
          out.push(e);
        }
        break;
      case "subagents": {
        const only = e.rows.length === 1 ? e.rows[0] : undefined;
        if (only !== undefined && only.row.background === false) {
          addStep(e, { kind: "subagent", key: e.key, row: only });
        } else {
          close("ended");
          out.push(e);
        }
        break;
      }
      case "divider":
        if (s.open !== null && (e.divider === "fallback" || e.divider === "compacted")) {
          const { kind: _kind, key: _key, ...divider } = e;
          addStep(e, { kind: "note", key: e.key, note: e.divider, divider });
        } else {
          if (e.divider === "compact-failed") close("ended");
          out.push(e);
        }
        break;
      case "card":
        if (e.placement === "process") addStep(e, e);
        else if (e.placement === "pinned") pin(e);
        else outside(e, "outputs");
        break;
      case "approval":
      case "question":
      case "connect":
        if (s.open !== null && folds(e, s.open.block))
          addStep(e, { kind: "decided", key: e.key, entry: e });
        else outside(e, "blocking");
        break;
      case "device-code":
      case "subagent-wait":
        outside(e, "blocking");
        break;
      case "handoff":
      case "reveal":
        // with no block open, the pending entry stands where the first of them does
        if (s.open === null && s.turn.slot === null) s.turn.slot = out.length;
        s.turn.items.push(e);
        break;
      case "files":
      case "background":
      case "delivery":
        outside(e, "outputs");
        break;
      case "run": {
        if (s.open !== null) {
          s.open.block.runId ??= e.runId;
          close("ended");
        }
        // every block of the run takes its end; the last one also its working time
        const mine = s.unsettled.filter((b) => b.runId === null || b.runId === e.runId);
        s.unsettled = [];
        s.inRun = false;
        for (const b of mine) {
          b.runId ??= e.runId;
          b.state = e.status === "ok" ? "finished" : e.status;
        }
        const last = mine.at(-1);
        if (last !== undefined) last.durationMs = e.durationMs;
        // a finished run with no answer after its last narration: that narration is its answer
        const promoted = s.unanswered;
        s.unanswered = null;
        if (
          e.status === "ok" &&
          promoted !== null &&
          (promoted.step === undefined || e.runId === null || promoted.step.runId === e.runId)
        ) {
          out.push({ ...promoted, key: `${promoted.key}:answer`, narration: false });
        }
        out.push(e);
        break;
      }
      case "user":
        close(e.pending === true ? "live" : "ended");
        // a message taken in by the going run (queued, or not yet) stays in the turn
        if (!s.inRun) endTurn();
        out.push(e);
        break;
      case "task":
      case "skill-report":
        close("ended");
        out.push(e);
        break;
      default: {
        const never: never = e;
        out.push(never);
      }
    }
  }
  close("live");
  endTurn();

  // the going run's clock on its latest block, while that block is live (spec §1.3)
  if (run !== undefined && run.runId !== null) {
    const last = out.findLast((e): e is ProcessEntry => e.kind === "process");
    if (
      last !== undefined &&
      (last.runId === run.runId || last.runId === null) &&
      (last.state === "running" || last.state === "waiting")
    )
      last.clock = { workedMs: run.workedMs, resumedAt: run.resumedAt };
  }

  // A stopped or failed run's pinned cards stand outside, right after their block (spec §4).
  const result: ThreadEntry[] = [];
  for (const e of out) {
    result.push(e);
    if (
      e.kind === "process" &&
      e.pinned.length > 0 &&
      (e.state === "stopped" || e.state === "failed")
    ) {
      result.push(...e.pinned);
      e.pinned = [];
    }
  }
  return result;
}
