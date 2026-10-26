import type { ContentBlock } from "@capybara-hq/plugin-sdk";
import { matchKey } from "./recorded-tools.js";

/**
 * 评分的结构差异（D3）：基线与候选的工具调用（名字与参数）、回复文本的相似度、停止原因。纯函数，不发请求。
 * - 工具调用先按名字做 LCS 对齐（中间插入 / 删除一个调用不会让后面的全部错位）：对上的同名调用参数相同为
 *   `same`（参数按规范化 JSON 比较，键顺序不同也算相同），否则 `args_changed`；两个对齐点之间多出来的
 *   按位置配对为 `name_changed`，剩下的是 `added`（只在候选）/ `removed`（只在基线）；
 *   两边调用数之积超过 {@link MAX_ALIGN_CELLS} 时不做对齐（DP 表是 O(n·m)），改为按位置逐个比较；
 * - 文本相似度见 {@link textSimilarity}（C8）。
 */

export interface ToolCallDiffEntry {
  index: number;
  kind: "same" | "args_changed" | "name_changed" | "added" | "removed";
  baseline?: { name: string; input: unknown };
  candidate?: { name: string; input: unknown };
}

export interface StructuralDiff {
  toolCalls: ToolCallDiffEntry[];
  toolCallsMatch: boolean;
  textSimilarity: number;
  stopReasonMatch: boolean;
}

type Call = { name: string; input: unknown };

/** 词数之积超过它时只比是否相等（C8：LCS 是 O(n·m)）。 */
export const MAX_LCS_CELLS = 4_000_000;

const words = (s: string): string[] => s.split(/\s+/).filter((w) => w.length > 0);

/** 工具调用数之积超过它时按位置比较，不做名字对齐。 */
export const MAX_ALIGN_CELLS = 1_000_000;

/** 两个序列的 LCS 长度（两行滚动数组，行长取较短的一边）。 */
function lcsLength<T>(x: readonly T[], y: readonly T[], eq: (p: T, q: T) => boolean): number {
  const [a, b] = x.length >= y.length ? [x, y] : [y, x];
  let prev = new Array<number>(b.length + 1).fill(0);
  let cur = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      cur[j] = eq(a[i - 1] as T, b[j - 1] as T)
        ? (prev[j - 1] as number) + 1
        : Math.max(prev[j] as number, cur[j - 1] as number);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[b.length] as number;
}

/**
 * 文本相似度（C8）：按空白切词，`2·LCS / (|a| + |b|)`；两边都没有词为 1；词数之积超过 {@link MAX_LCS_CELLS}
 * 时只比是否相等（1 或 0）。
 */
export function textSimilarity(a: string, b: string): number {
  const x = words(a);
  const y = words(b);
  if (x.length === 0 && y.length === 0) return 1;
  if (x.length === 0 || y.length === 0) return 0;
  if (x.length * y.length > MAX_LCS_CELLS) {
    return x.length === y.length && x.every((w, i) => w === y[i]) ? 1 : 0;
  }
  return (2 * lcsLength(x, y, (p, q) => p === q)) / (x.length + y.length);
}

/** 按名字的 LCS 对齐：返回对上的下标对（升序）。 */
function alignByName(a: readonly Call[], b: readonly Call[]): [number, number][] {
  const n = a.length;
  const m = b.length;
  if (n * m > MAX_ALIGN_CELLS) {
    // 规模过大：按位置比较（同一位置同名的算对上，其余由 gap 按位置配对为 name_changed / added / removed）
    const pairs: [number, number][] = [];
    for (let i = 0; i < Math.min(n, m); i++) if (a[i]?.name === b[i]?.name) pairs.push([i, i]);
    return pairs;
  }
  // 工具调用数通常很少，完整 DP 表即可
  const t: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const row = t[i] as number[];
      row[j] =
        a[i]?.name === b[j]?.name
          ? ((t[i + 1] as number[])[j + 1] as number) + 1
          : Math.max((t[i + 1] as number[])[j] as number, row[j + 1] as number);
    }
  }
  const pairs: [number, number][] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i]?.name === b[j]?.name) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (((t[i + 1] as number[])[j] as number) >= ((t[i] as number[])[j + 1] as number)) {
      i++;
    } else {
      j++;
    }
  }
  return pairs;
}

function diffToolCalls(a: readonly Call[], b: readonly Call[]): ToolCallDiffEntry[] {
  const kinds: Omit<ToolCallDiffEntry, "index">[] = [];
  const gap = (ai: number, aEnd: number, bj: number, bEnd: number) => {
    while (ai < aEnd && bj < bEnd) {
      kinds.push({
        kind: "name_changed",
        baseline: a[ai] as Call,
        candidate: b[bj] as Call,
      });
      ai++;
      bj++;
    }
    for (; ai < aEnd; ai++) kinds.push({ kind: "removed", baseline: a[ai] as Call });
    for (; bj < bEnd; bj++) kinds.push({ kind: "added", candidate: b[bj] as Call });
  };
  let i = 0;
  let j = 0;
  for (const [pi, pj] of alignByName(a, b)) {
    gap(i, pi, j, pj);
    const x = a[pi] as Call;
    const y = b[pj] as Call;
    kinds.push({
      kind: matchKey(x.name, x.input) === matchKey(y.name, y.input) ? "same" : "args_changed",
      baseline: x,
      candidate: y,
    });
    i = pi + 1;
    j = pj + 1;
  }
  gap(i, a.length, j, b.length);
  return kinds.map((k, index) => ({ index, ...k }));
}

export function structuralDiff(
  baseline: { toolCalls: Call[]; text: string; stopReason: string | null },
  candidate: { toolCalls: Call[]; text: string; stopReason: string | null },
): StructuralDiff {
  const toolCalls = diffToolCalls(baseline.toolCalls, candidate.toolCalls);
  return {
    toolCalls,
    toolCallsMatch: toolCalls.every((e) => e.kind === "same"),
    textSimilarity: textSimilarity(baseline.text, candidate.text),
    stopReasonMatch: baseline.stopReason === candidate.stopReason,
  };
}

/** 一条回复的工具调用与文本（文本块用换行连接；thinking 不算回复）。 */
export function replyParts(content: readonly ContentBlock[]): { toolCalls: Call[]; text: string } {
  const toolCalls: Call[] = [];
  const texts: string[] = [];
  for (const b of content) {
    if (b.type === "tool_call") toolCalls.push({ name: b.name, input: b.input });
    else if (b.type === "text") texts.push(b.text);
  }
  return { toolCalls, text: texts.join("\n") };
}
