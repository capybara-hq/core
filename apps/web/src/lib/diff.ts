/**
 * 纯文本按行比较（技能变更的差异展示）：LCS 求最长公共子序列，输出带前缀的行
 * （`+ ` 新增、`- ` 删除、`  ` 不变），只保留改动前后 {@link CONTEXT} 行上下文，中间以 `⋯` 隔开。
 * 两边行数之积超过 {@link MAX_CELLS} 时不做逐行比较，整段按「删除旧的、加入新的」输出。
 */

const CONTEXT = 3;
const MAX_CELLS = 4_000_000;
const GAP = "⋯";

type Op = { kind: " " | "+" | "-"; text: string };

const splitLines = (s: string): string[] => {
  if (s === "") return [];
  const lines = s.split("\n");
  // 末尾换行不算一行
  if (lines.at(-1) === "") lines.pop();
  return lines;
};

function ops(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  if (n * m > MAX_CELLS) {
    return [
      ...a.map((text) => ({ kind: "-" as const, text })),
      ...b.map((text) => ({ kind: "+" as const, text })),
    ];
  }
  // lcs[i][j]：a[i..] 与 b[j..] 的 LCS 长度（一维数组按行存）
  const w = m + 1;
  const lcs = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * w + j] =
        a[i] === b[j]
          ? (lcs[(i + 1) * w + j + 1] as number) + 1
          : Math.max(lcs[(i + 1) * w + j] as number, lcs[i * w + j + 1] as number);
    }
  }
  const out: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: " ", text: a[i] as string });
      i++;
      j++;
    } else if ((lcs[(i + 1) * w + j] as number) >= (lcs[i * w + j + 1] as number)) {
      out.push({ kind: "-", text: a[i] as string });
      i++;
    } else {
      out.push({ kind: "+", text: b[j] as string });
      j++;
    }
  }
  for (; i < n; i++) out.push({ kind: "-", text: a[i] as string });
  for (; j < m; j++) out.push({ kind: "+", text: b[j] as string });
  return out;
}

/** 两段文本的差异（见文件注释）；没有改动时返回空串。 */
export function lineDiff(before: string, after: string): string {
  const all = ops(splitLines(before), splitLines(after));
  if (all.every((o) => o.kind === " ")) return "";
  const keep = all.map(() => false);
  all.forEach((o, k) => {
    if (o.kind === " ") return;
    for (let x = Math.max(0, k - CONTEXT); x <= Math.min(all.length - 1, k + CONTEXT); x++) {
      keep[x] = true;
    }
  });
  const lines: string[] = [];
  let skipped = false;
  all.forEach((o, k) => {
    if (!keep[k]) {
      skipped = true;
      return;
    }
    if (skipped && lines.length > 0) lines.push(GAP);
    skipped = false;
    lines.push(`${o.kind} ${o.text}`);
  });
  return lines.join("\n");
}

/** 一个文件相对当前版本的变化。 */
export type FileChange = "added" | "removed" | "modified" | "unchanged";

/**
 * 把提议的文件与当前版本的文件按路径配对（提议的在前、按其顺序；只在当前版本里的随后）。
 * 内容读不到（null）时，有大小差异或一边缺失才能判定变化，否则按「修改」处理（无法比较）。
 */
export function pairFiles<F extends { path: string; size: number; content: string | null }>(
  proposed: readonly F[],
  current: readonly F[],
): { path: string; change: FileChange; before: F | undefined; after: F | undefined }[] {
  const cur = new Map(current.map((f) => [f.path, f]));
  const seen = new Set<string>();
  const out: { path: string; change: FileChange; before: F | undefined; after: F | undefined }[] =
    [];
  for (const f of proposed) {
    seen.add(f.path);
    const before = cur.get(f.path);
    let change: FileChange = "added";
    if (before) {
      change =
        before.content !== null && f.content !== null && before.content === f.content
          ? "unchanged"
          : "modified";
    }
    out.push({ path: f.path, change, before, after: f });
  }
  for (const f of current) {
    if (!seen.has(f.path))
      out.push({ path: f.path, change: "removed", before: f, after: undefined });
  }
  return out;
}
