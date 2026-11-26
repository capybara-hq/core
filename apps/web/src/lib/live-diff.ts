/**
 * Live diffs for a Write or Edit whose input is still streaming (streaming tool input spec §6.4).
 * Display only. The algorithm is a port of the kernel's `lineDiff` (Myers, bounded edit budget,
 * hunks with context); the web never imports the kernel.
 */
import type { DiffData, DiffHunk } from "@capybara-hq/design";

/** At most this many diff lines are kept (the kernel's `TOOL_VIEW_DIFF_MAX_LINES`). */
const MAX_LINES = 2000;
/** The most edits the search looks for; beyond it the part is shown as removed then added. */
const MAX_EDITS = 1000;
const CONTEXT = 3;

type Kind = "ctx" | "add" | "del";

export interface LiveDiff {
  diff: DiffData;
  /** Added lines among the aligned part (the unfinished last line included). */
  added: number;
  /** Base lines removed before the last aligned line. */
  removed: number;
  /** Base lines past the last aligned line: not removals yet, only the final result decides. */
  pending: number;
}

/** Lines of a finished text; a final newline does not start another line. */
function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/**
 * Myers' O(ND) edit script from `a` to `b`, where `b` is a prefix of the final text: the script may
 * stop after all of `b` with part of `a` unread (that tail costs nothing). Returns the operations
 * and how many lines of `a` they cover; null when more than {@link MAX_EDITS} edits are needed.
 */
function myersPrefix(a: string[], b: string[]): { ops: Kind[]; used: number } | null {
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, MAX_EDITS);
  const offset = max + 1;
  let v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  for (let d = 0; d <= max; d++) {
    trace.push(v);
    const next = v.slice();
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && (v[offset + k - 1] as number) < (v[offset + k + 1] as number))) {
        x = v[offset + k + 1] as number;
      } else {
        x = (v[offset + k - 1] as number) + 1;
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      next[offset + k] = x;
      if (y === m && x <= n) return { ops: backtrack(trace, d, x, m, offset), used: x };
    }
    v = next;
  }
  return null;
}

function backtrack(trace: Int32Array[], dEnd: number, endX: number, endY: number, offset: number) {
  const ops: Kind[] = [];
  let x = endX;
  let y = endY;
  for (let d = dEnd; d > 0; d--) {
    const v = trace[d] as Int32Array;
    const k = x - y;
    const down =
      k === -d || (k !== d && (v[offset + k - 1] as number) < (v[offset + k + 1] as number));
    const prevK = down ? k + 1 : k - 1;
    const prevX = v[offset + prevK] as number;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push("ctx");
      x--;
      y--;
    }
    ops.push(down ? "add" : "del");
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) {
    ops.push("ctx");
    x--;
    y--;
  }
  return ops.reverse();
}

interface Op {
  kind: Kind;
  ai: number;
  bi: number;
}

/** Group operations into hunks with {@link CONTEXT} lines around each change. */
function hunksOf(all: Op[], a: string[], b: string[]): DiffHunk[] {
  const ranges: [number, number][] = [];
  for (let i = 0; i < all.length; i++) {
    if ((all[i] as Op).kind === "ctx") continue;
    const start = Math.max(0, i - CONTEXT);
    const end = Math.min(all.length, i + CONTEXT + 1);
    const last = ranges.at(-1);
    if (last && start <= last[1]) last[1] = end;
    else ranges.push([start, end]);
  }
  return ranges.map(([start, end]) => {
    const slice = all.slice(start, end);
    const first = slice[0] as Op;
    const lines = slice.map((o) => ({
      kind: o.kind,
      text: (o.kind === "add" ? b[o.bi] : a[o.ai]) as string,
    }));
    const hasOld = lines.some((l) => l.kind !== "add");
    const hasNew = lines.some((l) => l.kind !== "del");
    return {
      oldStart: hasOld ? first.ai + 1 : first.ai,
      newStart: hasNew ? first.bi + 1 : first.bi,
      lines,
    };
  });
}

/** Keep the last {@link MAX_LINES} diff lines (a live view follows the tail). */
function capLines(hunks: DiffHunk[]): DiffData {
  const total = hunks.reduce((s, h) => s + h.lines.length, 0);
  if (total <= MAX_LINES) return { hunks, truncated: false };
  let drop = total - MAX_LINES;
  const kept: DiffHunk[] = [];
  for (const h of hunks) {
    if (drop >= h.lines.length) {
      drop -= h.lines.length;
      continue;
    }
    if (drop === 0) {
      kept.push(h);
      continue;
    }
    const lines = h.lines.slice(drop);
    const skippedOld = h.lines.slice(0, drop).filter((l) => l.kind !== "add").length;
    const skippedNew = h.lines.slice(0, drop).filter((l) => l.kind !== "del").length;
    kept.push({
      oldStart: h.oldStart + skippedOld,
      newStart: h.newStart + skippedNew,
      lines,
    });
    drop = 0;
  }
  return { hunks: kept, truncated: true, totalLines: total };
}

/**
 * The live diff of a streaming Write against its base: Myers over the base lines and the complete
 * lines of `prefix`; the unfinished last line is always shown as added. Base lines past the last
 * aligned (non-blank, matched) line are `pending`, not removals.
 */
export function liveWriteDiff(base: string, prefix: string): LiveDiff {
  const a = splitLines(base);
  const b = splitLines(prefix);
  const unfinished = prefix !== "" && !prefix.endsWith("\n");
  const complete = unfinished ? b.slice(0, -1) : b;
  const finished = complete.length;

  // common prefix first: a rewrite usually starts the same way
  let pre = 0;
  while (pre < a.length && pre < finished && a[pre] === complete[pre]) pre++;
  const midA = a.slice(pre);
  const midB = complete.slice(pre);
  const searched = myersPrefix(midA, midB);
  const mid: Kind[] = searched
    ? searched.ops
    : [...midA.map((): Kind => "del"), ...midB.map((): Kind => "add")];
  const used = pre + (searched ? searched.used : midA.length);
  const ops: Kind[] = [...Array<Kind>(pre).fill("ctx"), ...mid];
  if (unfinished) ops.push("add");

  const all: Op[] = [];
  let ai = 0;
  let bi = 0;
  for (const kind of ops) {
    all.push({ kind, ai, bi });
    if (kind === "ctx") {
      ai++;
      bi++;
    } else if (kind === "del") ai++;
    else bi++;
  }

  // the last aligned line: the last non-blank base line matched by a written line
  let lastAligned = -1;
  all.forEach((o, i) => {
    if (o.kind === "ctx" && (a[o.ai] as string).trim() !== "") lastAligned = i;
  });
  let pending = a.length - used;
  let removed = 0;
  let added = 0;
  const shown: Op[] = [];
  all.forEach((o, i) => {
    if (o.kind === "del" && i > lastAligned) {
      pending++;
      return;
    }
    if (o.kind === "del") removed++;
    else if (o.kind === "add") added++;
    shown.push(o);
  });
  return { diff: capLines(hunksOf(shown, a, b)), added, removed, pending };
}

/** The live diff of a streaming Edit: `old` as removed lines, the growing `new` as added; no numbers. */
export function liveEditDiff(oldText: string, newPrefix: string): DiffData {
  const lines: { kind: Kind; text: string }[] = [
    ...splitLines(oldText).map((text) => ({ kind: "del" as const, text })),
    ...splitLines(newPrefix).map((text) => ({ kind: "add" as const, text })),
  ];
  if (lines.length === 0) return { hunks: [], truncated: false };
  return { hunks: [{ oldStart: 0, newStart: 0, lines }], truncated: false };
}

/** The neutral form of a streaming Write with no base: the text as context lines numbered from 1. */
export function writingLines(prefix: string): DiffData {
  const parts = splitLines(prefix);
  if (parts.length === 0) return { hunks: [], truncated: false };
  return {
    hunks: [{ oldStart: 1, newStart: 1, lines: parts.map((text) => ({ kind: "ctx", text })) }],
    truncated: false,
  };
}
