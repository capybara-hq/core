import { type DividerData, isCallKey, type TimelineEntry, type TimelineSubagent } from "./timeline";

/**
 * Process blocks (conversation process blocks spec §1–§5): a pure pass after the timeline
 * ({@link groupProcess}) that folds a run's thinking, narration and tool calls into one `process`
 * entry per stretch of the run and routes the cards by class, so the thread reads as block →
 * blocking cards → pending actions → files and output cards → answer.
 *
 * - A block opens at the first thinking, narration, tool group, process card, network fact or
 *   single synchronous sub-agent (a `subagents` entry with one row that is not in the background,
 *   spec §10.3).
 * - It closes at an answer (prose that is not narration), a user message, a sub-agent task or
 *   report, a sub-agent group of two or more rows or a background one, a divider other than a
 *   fallback or a compaction, or the run's `run` entry; a fallback or a compaction inside an open
 *   block is a `note` step.
 * - An undecided approval, question or connect, a device code and a sub-agent's wait stand outside,
 *   right after the block (the block is `waiting` while one is undecided); once decided an
 *   approval, question or connect is a `decided` step at its place in the rail.
 * - Handoffs and reveals of the block merge into one `pending` entry after the blocking cards;
 *   `output` cards, files, sub-agent deliveries and background task notices follow, in log order.
 * - `pinned` cards: the run's latest one sits on the run's latest block that wrote one (earlier
 *   versions are only their call's rail row); after a `failed` / `stopped` run it stands outside,
 *   right after the block. `process` cards stay as steps after their tools step.
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
  /** The run the block belongs to, when its entries name it (tool rows, drafts, the run row). */
  runId: string | null;
  state: "running" | "waiting" | "finished" | "stopped" | "failed";
  steps: ProcessStep[];
  /** The latest pinned card of the block's run. */
  pinned?: Entry<"card">;
  /** The run's working time once it ended (its `run` row), else null. */
  durationMs: number | null;
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

/** The cards that wait for a person: outside the block, right after it. */
type Blocking = Entry<"approval" | "question" | "connect" | "device-code" | "subagent-wait">;

interface OpenBlock {
  block: ProcessEntry;
  blocking: Blocking[];
  pending: Entry<"handoff" | "reveal">[];
  /** Output cards, files and notices, in log order. */
  outputs: ThreadEntry[];
}

/** A draft's key (`d<runId>:<step>`, `…:thinking`) names its run. */
const DRAFT_KEY = /^d(.+):\d+(?::thinking)?$/;

/** The run an entry names, or null (log prose and thinking carry no run). */
function runIdOf(e: TimelineEntry): string | null {
  switch (e.kind) {
    case "tools":
      for (const t of e.rows) if (isCallKey(t.row.id)) return t.row.id.split("\u0000")[0] || null;
      return null;
    case "reveal":
      return e.runId;
    case "thinking":
    case "prose":
      return DRAFT_KEY.exec(e.key)?.[1] ?? null;
    default:
      return null;
  }
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
export function groupProcess(entries: readonly TimelineEntry[]): ThreadEntry[] {
  const finishedTasks = new Set<string>();
  for (const e of entries) if (e.kind === "background") finishedTasks.add(e.taskId);

  const out: ThreadEntry[] = [];
  const s: {
    /** The block being filled, with what stands after it. */
    open: OpenBlock | null;
    /** The block closed last, until a run row settles it (its run's end and working time). */
    lastClosed: ProcessEntry | null;
  } = { open: null, lastClosed: null };
  /** Run → the block holding the run's latest pinned card. */
  const pinnedBlock = new Map<string, ProcessEntry>();

  const noteRun = (b: ProcessEntry, e: TimelineEntry) => {
    if (b.runId !== null) return;
    const runId = runIdOf(e);
    if (runId !== null) b.runId = runId;
  };
  const ensure = (first: TimelineEntry): OpenBlock => {
    if (s.open === null) {
      s.open = {
        block: {
          kind: "process",
          key: `p${first.key}`,
          runId: null,
          state: "running",
          steps: [],
          durationMs: null,
          backgroundRunning: 0,
        },
        blocking: [],
        pending: [],
        outputs: [],
      };
    }
    noteRun(s.open.block, first);
    return s.open;
  };
  const addStep = (e: TimelineEntry, step: ProcessStep) => ensure(e).block.steps.push(step);
  const pushPending = (items: Entry<"handoff" | "reveal">[]) => {
    const last = out.at(-1);
    if (last?.kind === "pending") last.items.push(...items);
    else out.push({ kind: "pending", key: `pending:${items[0]?.key ?? ""}`, items: [...items] });
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
    if (o.pending.length > 0) pushPending(o.pending);
    out.push(...o.outputs);
    s.lastClosed = b;
  };
  /** Outside the block when one is open (after it, by class), else at its place. */
  const outside = (e: ThreadEntry, bucket: "blocking" | "outputs") => {
    if (s.open === null) out.push(e);
    else if (bucket === "blocking") s.open.blocking.push(e as Blocking);
    else s.open.outputs.push(e);
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
        } else {
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
        else if (e.placement === "pinned") {
          const b = ensure(e).block;
          const runId = b.runId;
          const prev = runId === null ? undefined : pinnedBlock.get(runId);
          if (prev !== undefined && prev !== b) delete prev.pinned;
          b.pinned = e;
          if (runId !== null) pinnedBlock.set(runId, b);
        } else outside(e, "outputs");
        break;
      case "approval":
      case "question":
      case "connect":
        if (s.open !== null && decided(e, s.open.block))
          addStep(e, { kind: "decided", key: e.key, entry: e });
        else outside(e, "blocking");
        break;
      case "device-code":
      case "subagent-wait":
        outside(e, "blocking");
        break;
      case "handoff":
      case "reveal":
        if (s.open === null) pushPending([e]);
        else s.open.pending.push(e);
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
        const b = s.lastClosed;
        s.lastClosed = null;
        if (b !== null && (b.runId === null || b.runId === e.runId)) {
          b.runId ??= e.runId;
          b.state = e.status === "ok" ? "finished" : e.status;
          b.durationMs = e.durationMs;
        }
        out.push(e);
        break;
      }
      case "user":
        close(e.pending === true ? "live" : "ended");
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

  // A stopped or failed run's pinned card stands outside, right after its block (spec §4).
  const result: ThreadEntry[] = [];
  for (const e of out) {
    result.push(e);
    if (
      e.kind === "process" &&
      e.pinned !== undefined &&
      (e.state === "stopped" || e.state === "failed")
    ) {
      result.push(e.pinned);
      delete e.pinned;
    }
  }
  return result;
}
