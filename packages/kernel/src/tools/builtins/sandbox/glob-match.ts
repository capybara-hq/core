/**
 * 线性时间的 glob 匹配（sandbox_glob 用；模式由模型给出，不能编译成会回溯爆炸的正则）。
 *
 * 语法：路径按 `/` 分段；整段 `**` 跨任意层目录（含零层）；段内 `*` 匹配任意个字符（不跨 `/`），`?` 一个字符，
 * `[abc]` / `[a-z]` / `[!x]`（或 `[^x]`）字符类，`{a,b}` 二选一（可嵌套，展开后最多 {@link MAX_ALTERNATIVES} 个）；
 * 其余字符按字面。
 *
 * 复杂度：段内用双指针通配匹配（只回溯到最近的 `*`），O(段长 × 模式段长)；跨段的 `**` 用
 * (模式段数 + 1) × (路径段数 + 1) 的记忆化，整体为多项式，最坏也不会指数回溯。
 * 另限制模式长度、`*` 个数（连续的 `*` 先合并）与展开后的分支数，超过即拒绝。
 */

/** 模式最长字符数。 */
export const MAX_GLOB_LENGTH = 1000;
/** 模式里最多的 `*`（合并连续的之后，各分支合计）。 */
export const MAX_GLOB_STARS = 32;
/** `{a,b}` 展开后最多的分支数。 */
export const MAX_ALTERNATIVES = 64;

/** 模式不合法或超出限制；message 为英文，供工具层拼进给模型的错误。 */
export class GlobPatternError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GlobPatternError";
  }
}

type Token =
  | { kind: "char"; c: string }
  | { kind: "any" }
  | { kind: "star" }
  | { kind: "class"; negate: boolean; items: ([string, string] | string)[] };

/** 一段：`globstar` 为整段 `**`，否则为 token 序列。 */
type Segment = { globstar: true } | { globstar: false; tokens: Token[] };

/** 展开 `{a,b}`（可嵌套）；分支数超过上限抛错。未闭合的 `{` 按字面。 */
function expandBraces(p: string): string[] {
  let depth = 0;
  let open = -1;
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === "[") {
      // 字符类里的花括号按字面
      const end = p.indexOf("]", i + 2);
      if (end !== -1) i = end;
      continue;
    }
    if (c === "{") {
      if (depth === 0) open = i;
      depth++;
    } else if (c === "}" && depth > 0) {
      depth--;
      if (depth === 0) {
        const body = p.slice(open + 1, i);
        const parts: string[] = [];
        let d = 0;
        let start = 0;
        for (let j = 0; j < body.length; j++) {
          if (body[j] === "{") d++;
          else if (body[j] === "}") d--;
          else if (body[j] === "," && d === 0) {
            parts.push(body.slice(start, j));
            start = j + 1;
          }
        }
        parts.push(body.slice(start));
        const prefix = p.slice(0, open);
        const rest = expandBraces(p.slice(i + 1));
        const out: string[] = [];
        for (const part of parts) {
          for (const inner of expandBraces(part)) {
            for (const tail of rest) {
              out.push(prefix + inner + tail);
              if (out.length > MAX_ALTERNATIVES) {
                throw new GlobPatternError(
                  `the pattern expands to more than ${MAX_ALTERNATIVES} alternatives`,
                );
              }
            }
          }
        }
        return out;
      }
    }
  }
  return [p];
}

/** 解析一段（不含 `/`）为 token；连续的 `*` 合并为一个。 */
function parseSegment(seg: string): Token[] {
  const chars = Array.from(seg);
  const out: Token[] = [];
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i] as string;
    if (c === "*") {
      if (out.at(-1)?.kind !== "star") out.push({ kind: "star" });
    } else if (c === "?") {
      out.push({ kind: "any" });
    } else if (c === "[") {
      let j = i + 1;
      let negate = false;
      if (chars[j] === "!" || chars[j] === "^") {
        negate = true;
        j++;
      }
      // `]` 紧跟在开头时按字面
      const first = j;
      while (j < chars.length && (chars[j] !== "]" || j === first)) j++;
      if (j >= chars.length) {
        out.push({ kind: "char", c });
        continue;
      }
      const body = chars.slice(first, j);
      const items: ([string, string] | string)[] = [];
      for (let k = 0; k < body.length; k++) {
        const a = body[k] as string;
        if (body[k + 1] === "-" && k + 2 < body.length) {
          items.push([a, body[k + 2] as string]);
          k += 2;
        } else {
          items.push(a);
        }
      }
      out.push({ kind: "class", negate, items });
      i = j;
    } else {
      out.push({ kind: "char", c });
    }
  }
  return out;
}

function tokenMatches(t: Token, c: string): boolean {
  switch (t.kind) {
    case "char":
      return t.c === c;
    case "any":
      return true;
    case "class": {
      const hit = t.items.some((it) =>
        typeof it === "string" ? it === c : it[0] <= c && c <= it[1],
      );
      return hit !== t.negate;
    }
    default:
      return false;
  }
}

/** 段内通配匹配：双指针，失配时只回溯到最近的 `*`（O(n × m)）。 */
function matchSegment(tokens: readonly Token[], name: string): boolean {
  const s = Array.from(name);
  let p = 0;
  let i = 0;
  let star = -1;
  let mark = 0;
  while (i < s.length) {
    const t = tokens[p];
    if (t !== undefined && t.kind !== "star" && tokenMatches(t, s[i] as string)) {
      p++;
      i++;
    } else if (t !== undefined && t.kind === "star") {
      star = p;
      mark = i;
      p++;
    } else if (star !== -1) {
      p = star + 1;
      mark++;
      i = mark;
    } else {
      return false;
    }
  }
  while (tokens[p]?.kind === "star") p++;
  return p === tokens.length;
}

/** 一个分支：按段匹配，`**` 用 (段数 + 1)² 的记忆化。 */
function matchSegments(pattern: readonly Segment[], path: readonly string[]): boolean {
  const P = pattern.length;
  const N = path.length;
  // 0 = 未算，1 = 不匹配，2 = 匹配
  const memo = new Uint8Array((P + 1) * (N + 1));
  const go = (i: number, j: number): boolean => {
    const k = i * (N + 1) + j;
    const m = memo[k];
    if (m !== 0) return m === 2;
    let r: boolean;
    if (i === P) {
      r = j === N;
    } else {
      const seg = pattern[i] as Segment;
      if (seg.globstar) {
        r = go(i + 1, j) || (j < N && go(i, j + 1));
      } else {
        r = j < N && matchSegment(seg.tokens, path[j] as string) && go(i + 1, j + 1);
      }
    }
    memo[k] = r ? 2 : 1;
    return r;
  };
  return go(0, 0);
}

/**
 * 编译 glob（相对路径，`/` 分隔）为匹配函数。模式不合法或超出限制抛 {@link GlobPatternError}。
 */
export function compileGlob(pattern: string): (relPath: string) => boolean {
  if (pattern.length > MAX_GLOB_LENGTH) {
    throw new GlobPatternError(`the pattern is longer than ${MAX_GLOB_LENGTH} characters`);
  }
  const branches = expandBraces(pattern).map((alt) => {
    const segs: Segment[] = [];
    for (const raw of alt.split("/")) {
      if (raw === "") continue;
      if (raw === "**") {
        // 连续的 `**` 合并
        if (!(segs.at(-1) as { globstar?: boolean } | undefined)?.globstar) {
          segs.push({ globstar: true });
        }
      } else {
        segs.push({ globstar: false, tokens: parseSegment(raw) });
      }
    }
    return segs;
  });
  let stars = 0;
  for (const segs of branches) {
    for (const s of segs) {
      stars += s.globstar ? 1 : s.tokens.filter((t) => t.kind === "star").length;
    }
  }
  if (stars > MAX_GLOB_STARS) {
    throw new GlobPatternError(`the pattern has more than ${MAX_GLOB_STARS} wildcards`);
  }
  return (relPath) => {
    const parts = relPath.split("/").filter((x) => x !== "");
    return branches.some((segs) => matchSegments(segs, parts));
  };
}
