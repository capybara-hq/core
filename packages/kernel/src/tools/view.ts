/**
 * Structured tool views (UI refresh B, spec §5.5 / §5.9): the line diff behind the `edit` view of
 * `tool_result.view`. Display only: the view is never sent to the model.
 */

/** At most this many diff lines (context + added + removed) go into one view. */
export const TOOL_VIEW_DIFF_MAX_LINES = 2000;
/** A diff line longer than this is cut (the `tool_result.view` schema limit). */
export const TOOL_VIEW_LINE_MAX_CHARS = 2000;
/** Above this size (bytes, either side) no hunks are computed, only counts. */
export const TOOL_VIEW_DIFF_MAX_BYTES = 1024 * 1024;
/**
 * The most diff text (UTF-8 bytes, all lines together) one view carries; beyond it the rest is left
 * out with `truncated: true`. The view sits in an event row that every events fetch re-reads.
 */
export const TOOL_VIEW_DIFF_MAX_TEXT_BYTES = 256 * 1024;
/**
 * The most edits the Myers search looks for in the part that differs; beyond it the part is shown as
 * removed then added (still a correct diff, just not minimal), so time and memory stay bounded.
 */
const MAX_EDITS = 1000;

export interface DiffLine {
  kind: "ctx" | "add" | "del";
  text: string;
}

export interface Hunk {
  /** First old line of the hunk (1-based; 0 when the hunk has no old lines, as in unified diffs). */
  oldStart: number;
  /** First new line of the hunk (1-based; 0 when the hunk has no new lines). */
  newStart: number;
  lines: DiffLine[];
}

export interface LineDiff {
  hunks: Hunk[];
  added: number;
  removed: number;
  /** Hunks were left out (the line cap) or not computed (a side over 1 MB). */
  truncated: boolean;
}

/** Lines of a text; a final newline does not start another line. */
function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

const byteLength = (s: string) => Buffer.byteLength(s, "utf8");

/** Added / removed counts by comparing the line multisets (no alignment). */
function countOnly(a: string[], b: string[]): { added: number; removed: number } {
  const left = new Map<string, number>();
  for (const l of a) left.set(l, (left.get(l) ?? 0) + 1);
  let added = 0;
  for (const l of b) {
    const n = left.get(l) ?? 0;
    if (n > 0) left.set(l, n - 1);
    else added++;
  }
  let removed = 0;
  for (const n of left.values()) removed += n;
  return { added, removed };
}

/**
 * Myers' O(ND) edit script between `a` and `b` (both already stripped of their common prefix and
 * suffix): the list of operations in order. Null when more than {@link MAX_EDITS} edits are needed.
 */
function myers(a: string[], b: string[]): DiffLine["kind"][] | null {
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
      if (x >= n && y >= m) return backtrack(trace, d, n, m, offset);
    }
    v = next;
  }
  return null;
}

function backtrack(
  trace: Int32Array[],
  dEnd: number,
  n: number,
  m: number,
  offset: number,
): DiffLine["kind"][] {
  const ops: DiffLine["kind"][] = [];
  let x = n;
  let y = m;
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

/** A diff line as the view keeps it: cut to the schema limit, NUL as U+FFFD (jsonb rejects it). */
const cut = (s: string) =>
  (s.length > TOOL_VIEW_LINE_MAX_CHARS ? s.slice(0, TOOL_VIEW_LINE_MAX_CHARS) : s).replaceAll(
    "\0",
    "\uFFFD",
  );

/**
 * The line diff from `before` to `after` as unified-diff hunks with `context` lines around each
 * change. Output is capped at {@link TOOL_VIEW_DIFF_MAX_LINES} lines (`truncated: true` beyond);
 * when either side is over 1 MB no hunks are computed and the counts come from comparing line sets.
 */
export function lineDiff(before: string, after: string, context = 3): LineDiff {
  const a = splitLines(before);
  const b = splitLines(after);
  if (
    byteLength(before) > TOOL_VIEW_DIFF_MAX_BYTES ||
    byteLength(after) > TOOL_VIEW_DIFF_MAX_BYTES
  ) {
    return { hunks: [], ...countOnly(a, b), truncated: true };
  }
  // common prefix and suffix first: most edits change one small region
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (
    suf < a.length - pre &&
    suf < b.length - pre &&
    a[a.length - 1 - suf] === b[b.length - 1 - suf]
  ) {
    suf++;
  }
  const midA = a.slice(pre, a.length - suf);
  const midB = b.slice(pre, b.length - suf);
  const mid = myers(midA, midB) ?? [
    ...midA.map((): DiffLine["kind"] => "del"),
    ...midB.map((): DiffLine["kind"] => "add"),
  ];
  const ops: DiffLine["kind"][] = [
    ...Array<DiffLine["kind"]>(pre).fill("ctx"),
    ...mid,
    ...Array<DiffLine["kind"]>(suf).fill("ctx"),
  ];

  // walk the script, keeping old / new line numbers for every operation
  type Op = { kind: DiffLine["kind"]; ai: number; bi: number };
  const all: Op[] = [];
  let ai = 0;
  let bi = 0;
  let added = 0;
  let removed = 0;
  for (const kind of ops) {
    all.push({ kind, ai, bi });
    if (kind === "ctx") {
      ai++;
      bi++;
    } else if (kind === "del") {
      ai++;
      removed++;
    } else {
      bi++;
      added++;
    }
  }

  // group changes into hunks: a change starts or extends a hunk when within 2 * context of the last
  const ranges: [number, number][] = [];
  for (let i = 0; i < all.length; i++) {
    if ((all[i] as Op).kind === "ctx") continue;
    const start = Math.max(0, i - context);
    const end = Math.min(all.length, i + context + 1);
    const lastRange = ranges.at(-1);
    if (lastRange && start <= lastRange[1]) lastRange[1] = end;
    else ranges.push([start, end]);
  }

  const hunks: Hunk[] = [];
  let emitted = 0;
  let textBytes = 0;
  let truncated = false;
  for (const [start, end] of ranges) {
    if (emitted >= TOOL_VIEW_DIFF_MAX_LINES || textBytes >= TOOL_VIEW_DIFF_MAX_TEXT_BYTES) {
      truncated = true;
      break;
    }
    const slice = all.slice(start, end);
    const room = TOOL_VIEW_DIFF_MAX_LINES - emitted;
    const lines: DiffLine[] = [];
    let first: Op | undefined;
    for (const o of slice.length > room ? slice.slice(0, room) : slice) {
      const text = cut((o.kind === "add" ? b[o.bi] : a[o.ai]) as string);
      const size = byteLength(text);
      if (textBytes + size > TOOL_VIEW_DIFF_MAX_TEXT_BYTES) break;
      textBytes += size;
      first ??= o;
      lines.push({ kind: o.kind, text });
    }
    if (lines.length < slice.length) truncated = true;
    if (first === undefined) break;
    const hasOld = lines.some((l) => l.kind !== "add");
    const hasNew = lines.some((l) => l.kind !== "del");
    hunks.push({
      oldStart: hasOld ? first.ai + 1 : first.ai,
      newStart: hasNew ? first.bi + 1 : first.bi,
      lines,
    });
    emitted += lines.length;
  }
  return { hunks, added, removed, truncated };
}

/** The longest path in a view (the `tool_result.view` schema limit, UTF-16 units). */
export const TOOL_VIEW_PATH_MAX_CHARS = 1024;

/** A path cut to fit a view (kept whole when it fits; the row shows it as given). */
export function viewPath(path: string): string {
  if (path.length <= TOOL_VIEW_PATH_MAX_CHARS) return path;
  const head = path.slice(0, TOOL_VIEW_PATH_MAX_CHARS - 1);
  // never end on half a surrogate pair
  return `${/[\uD800-\uDBFF]$/.test(head) ? head.slice(0, -1) : head}…`;
}
