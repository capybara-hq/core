import { describe, expect, it } from "vitest";
import {
  MAX_ALIGN_CELLS,
  replyParts,
  structuralDiff,
  textSimilarity,
} from "../../src/evals/diff.js";

/** 评分（T6 / D3、C8）：工具调用与参数的结构差异、文本相似度（空白切词的 LCS 比值）。 */

const side = (
  toolCalls: { name: string; input: unknown }[],
  text = "",
  stopReason = "end_turn",
) => ({
  toolCalls,
  text,
  stopReason,
});

describe("textSimilarity", () => {
  it("相同为 1，全不同为 0，LCS 比值 2·LCS/(|a|+|b|)", () => {
    expect(textSimilarity("a b c", "a b c")).toBe(1);
    expect(textSimilarity("a b c", "x y z")).toBe(0);
    expect(textSimilarity("a b c d", "a b x d")).toBe(0.75);
  });

  it("按空白切词：多余空白不影响；两边都空为 1，一边空为 0", () => {
    expect(textSimilarity("  a\n b\tc ", "a b c")).toBe(1);
    expect(textSimilarity("", "   ")).toBe(1);
    expect(textSimilarity("a", "")).toBe(0);
    expect(textSimilarity("a b", "b a")).toBe(0.5);
  });

  it("词数之积超过 4,000,000 时只比是否相等", () => {
    const a = Array.from({ length: 2001 }, (_, i) => `w${i}`).join(" ");
    const b = Array.from({ length: 2000 }, (_, i) => `w${i}`).join(" ");
    // 2001 × 2000 > 4e6：不算 LCS（否则接近 1）
    expect(textSimilarity(a, b)).toBe(0);
    expect(textSimilarity(a, `${a} `)).toBe(1);
    // 2000 × 2000 = 4e6：照常算
    const c = Array.from({ length: 2000 }, (_, i) => (i === 0 ? "x" : `w${i}`)).join(" ");
    expect(textSimilarity(b, c)).toBeCloseTo(1999 / 2000, 10);
  });
});

describe("structuralDiff", () => {
  it("参数键顺序不同算 same；整体一致时 toolCallsMatch 为 true", () => {
    const d = structuralDiff(
      side([{ name: "search", input: { q: "x", limit: 3, opts: { a: 1, b: 2 } } }], "hi"),
      side([{ name: "search", input: { opts: { b: 2, a: 1 }, limit: 3, q: "x" } }], "hi"),
    );
    expect(d.toolCalls).toEqual([
      {
        index: 0,
        kind: "same",
        baseline: { name: "search", input: { q: "x", limit: 3, opts: { a: 1, b: 2 } } },
        candidate: { name: "search", input: { opts: { b: 2, a: 1 }, limit: 3, q: "x" } },
      },
    ]);
    expect(d.toolCallsMatch).toBe(true);
    expect(d.textSimilarity).toBe(1);
    expect(d.stopReasonMatch).toBe(true);
  });

  it("sandbox_bash calls that differ only in description are the same call", () => {
    const d = structuralDiff(
      side([{ name: "sandbox_bash", input: { command: "ls" } }]),
      side([{ name: "sandbox_bash", input: { command: "ls", description: "List files" } }]),
    );
    expect(d.toolCalls.map((e) => e.kind)).toEqual(["same"]);
    expect(d.toolCallsMatch).toBe(true);
  });

  it("改参数算 args_changed；改名算 name_changed", () => {
    const d = structuralDiff(
      side([
        { name: "search", input: { q: "x" } },
        { name: "read", input: { id: 1 } },
      ]),
      side([
        { name: "search", input: { q: "y" } },
        { name: "write", input: { id: 1 } },
      ]),
    );
    expect(d.toolCalls.map((e) => e.kind)).toEqual(["args_changed", "name_changed"]);
    expect(d.toolCalls.map((e) => e.index)).toEqual([0, 1]);
    expect(d.toolCallsMatch).toBe(false);
  });

  it("多一个调用算 added，少一个算 removed；按名字对齐，不因插入而错位", () => {
    const added = structuralDiff(
      side([
        { name: "a", input: {} },
        { name: "c", input: {} },
      ]),
      side([
        { name: "a", input: {} },
        { name: "b", input: { n: 1 } },
        { name: "c", input: {} },
      ]),
    );
    expect(added.toolCalls.map((e) => e.kind)).toEqual(["same", "added", "same"]);
    expect(added.toolCalls[1]).toEqual({
      index: 1,
      kind: "added",
      candidate: { name: "b", input: { n: 1 } },
    });
    expect(added.toolCallsMatch).toBe(false);

    const removed = structuralDiff(side([{ name: "a", input: {} }]), side([]));
    expect(removed.toolCalls).toEqual([
      { index: 0, kind: "removed", baseline: { name: "a", input: {} } },
    ]);
    expect(removed.toolCallsMatch).toBe(false);
  });

  it("都没有工具调用：toolCallsMatch 为 true；停止原因不同则 stopReasonMatch 为 false", () => {
    const d = structuralDiff(side([], "a b", "end_turn"), side([], "a c", "max_tokens"));
    expect(d.toolCalls).toEqual([]);
    expect(d.toolCallsMatch).toBe(true);
    expect(d.textSimilarity).toBe(0.5);
    expect(d.stopReasonMatch).toBe(false);
  });

  it("调用数之积超过 MAX_ALIGN_CELLS：按位置比较，不做名字对齐", () => {
    expect(MAX_ALIGN_CELLS).toBe(1_000_000);
    const n = 1001;
    const base = Array.from({ length: n }, (_, i) => ({ name: `t${i}`, input: {} }));
    const extra = { name: "x", input: {} };
    // 候选在开头插入一个调用：对齐时只有一个 added；按位置比较则每个位置都是 name_changed
    const big = structuralDiff(side(base), side([extra, ...base.slice(0, n - 1)]));
    expect(big.toolCalls).toHaveLength(n);
    expect(big.toolCalls.every((e) => e.kind === "name_changed")).toBe(true);
    // 规模以内照常对齐
    const ten = base.slice(0, 10);
    const small = structuralDiff(side(ten), side([extra, ...ten]));
    expect(small.toolCalls.map((e) => e.kind)).toEqual(["added", ...Array(10).fill("same")]);
  });

  it("replyParts：从内容块取工具调用与文本（忽略 thinking）", () => {
    expect(
      replyParts([
        { type: "thinking", text: "hmm" },
        { type: "text", text: "looking" },
        { type: "tool_call", id: "c1", name: "t", input: { a: 1 } },
        { type: "text", text: "more" },
      ]),
    ).toEqual({ toolCalls: [{ name: "t", input: { a: 1 } }], text: "looking\nmore" });
  });
});
