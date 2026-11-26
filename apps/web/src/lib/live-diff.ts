/**
 * Live diffs for a Write or Edit whose input is still streaming (streaming tool input spec §6.4).
 * Display only. The algorithm is a port of the kernel's `lineDiff` (Myers, bounded edit budget,
 * hunks with context); the web never imports the kernel.
 */
import { cutDiffLine as cut, type DiffData, type DiffHunk } from "@capybara-hq/design";

/** At most this many live lines are kept (the kernel's `TOOL_VIEW_DIFF_MAX_LINES`). */
export const MAX_LINES = 2000;
/** The most edits the search looks for; beyond it the part is shown as removed then added. */
const MAX_EDITS = 1000;
/**
 * The live diff's budget: lower than {@link MAX_EDITS}, since a streaming Write's diff is redone
 * on every frame (the result's diff is the kernel's, with its own budget).
 */
export const LIVE_MAX_EDITS = 400;
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

/** Counts the Myers searches run (a test seam: a remembered fallback runs none). */
export const liveDiffStats = { myersRuns: 0 };

/**
 * Myers' O(ND) edit script from `a` to `b`, where `b` is a prefix of the final text: the script may
 * stop after all of `b` with part of `a` unread (that tail costs nothing). Returns the operations
 * and how many lines of `a` they cover; null when more than `maxEdits` edits are needed.
 *
 * One array of furthest points, updated in place (step `d` writes the diagonals of `d`'s parity and
 * reads only the other's); before each step the trace keeps just the diagonals `-d..d` it reads,
 * so the trace holds O(D²) numbers, not O(D · maxEdits).
 */
function myersPrefix(
  a: string[],
  b: string[],
  maxEdits: number,
): { ops: Kind[]; used: number } | null {
  liveDiffStats.myersRuns++;
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, maxEdits);
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  // trace[d][k + d]: the furthest x on diagonal k after step d - 1
  const trace: Int32Array[] = [];
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice(offset - d, offset + d + 1));
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
      v[offset + k] = x;
      if (y === m && x <= n) return { ops: backtrack(trace, d, x, m), used: x };
    }
  }
  return null;
}

function backtrack(trace: Int32Array[], dEnd: number, endX: number, endY: number) {
  const ops: Kind[] = [];
  let x = endX;
  let y = endY;
  for (let d = dEnd; d > 0; d--) {
    const v = trace[d] as Int32Array;
    const at = (k: number) => v[k + d] as number;
    const k = x - y;
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
    const prevK = down ? k + 1 : k - 1;
    const prevX = at(prevK);
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

/**
 * The operations aligning the base lines `a` with the written lines `b`, and how many lines of `a`
 * they cover. Past `maxEdits` the part is removed then added (`fallback`): correct, not minimal.
 */
export function alignOps(
  a: string[],
  b: string[],
  maxEdits = MAX_EDITS,
): { ops: Kind[]; used: number; fallback: boolean } {
  const found = myersPrefix(a, b, maxEdits);
  if (found) return { ...found, fallback: false };
  return { ...fallbackOps(a, b), fallback: true };
}

/** The part past the budget: every line of `a` removed, then every line of `b` added. */
function fallbackOps(a: string[], b: string[]): { ops: Kind[]; used: number } {
  return { ops: [...a.map((): Kind => "del"), ...b.map((): Kind => "add")], used: a.length };
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
      text: cut((o.kind === "add" ? b[o.bi] : a[o.ai]) as string),
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
 * The streaming calls whose live diff fell back, by call id and base sha256. The prefix's edit
 * distance only grows as the written text grows (every path for a longer text passes through the
 * end of the shorter one), so once over the budget a call stays over it: its later frames skip the
 * search. Bounded (oldest first out); client state of this page only.
 */
const fellBack = new Set<string>();
const FELL_BACK_MAX = 64;

/** What identifies a streaming Write's search across frames: the call and its base. */
export interface LiveDiffKey {
  callId: string;
  baseSha256: string;
}

/**
 * The live diff of a streaming Write against its base: Myers over the base lines and the complete
 * lines of `prefix`; the unfinished last line is always shown as added. Base lines past the last
 * aligned (non-blank, matched) line are `pending`, not removals. With `key`, a search that fell
 * back is remembered for that call and base, and not run again on its later frames.
 */
export function liveWriteDiff(base: string, prefix: string, key?: LiveDiffKey): LiveDiff {
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
  const memo = key === undefined ? undefined : `${key.callId}\u0000${key.baseSha256}`;
  let aligned: { ops: Kind[]; used: number };
  if (memo !== undefined && fellBack.has(memo)) aligned = fallbackOps(midA, midB);
  else {
    const found = alignOps(midA, midB, LIVE_MAX_EDITS);
    if (found.fallback && memo !== undefined) {
      fellBack.add(memo);
      if (fellBack.size > FELL_BACK_MAX) fellBack.delete(fellBack.values().next().value as string);
    }
    aligned = found;
  }
  const { ops: mid, used: usedMid } = aligned;
  const used = pre + usedMid;
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
    ...splitLines(oldText).map((text) => ({ kind: "del" as const, text: cut(text) })),
    ...splitLines(newPrefix).map((text) => ({ kind: "add" as const, text: cut(text) })),
  ];
  if (lines.length === 0) return { hunks: [], truncated: false };
  return { hunks: [{ oldStart: 0, newStart: 0, lines }], truncated: false };
}

/** The neutral form of a streaming Write with no base: the text as context lines numbered from 1. */
export function writingLines(prefix: string): DiffData {
  const parts = splitLines(prefix);
  if (parts.length === 0) return { hunks: [], truncated: false };
  return {
    hunks: [
      { oldStart: 1, newStart: 1, lines: parts.map((text) => ({ kind: "ctx", text: cut(text) })) },
    ],
    truncated: false,
  };
}
