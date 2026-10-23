import { describe, expect, it } from "vitest";
import { calibrate, estimateTokens } from "../../../src/runtime/context/tokens.js";

const user = (text: string) => ({
  role: "user" as const,
  content: [{ type: "text" as const, text }],
});

describe("estimateTokens", () => {
  it("counts non-ASCII chars as 1 and ASCII chars as 1/4, rounded up", () => {
    expect(estimateTokens([user("你好")], [])).toBe(2);
    expect(estimateTokens([user("abcd")], [])).toBe(1);
    expect(estimateTokens([user("abcde")], [])).toBe(2);
    expect(estimateTokens([], [])).toBe(0);
  });

  it("includes system blocks, system messages, thinking, tool calls and results", () => {
    const n = estimateTokens(
      [
        { role: "system", content: "abcd" },
        {
          role: "assistant",
          content: [
            { type: "thinking", text: "abcd" },
            { type: "tool_call", id: "c", name: "ab", input: { a: 1 } },
          ],
        },
        {
          role: "user",
          content: [{ type: "tool_result", callId: "c", content: "中", isError: false }],
        },
      ],
      [{ text: "abcd", cache: true }],
    );
    // system 4 + reminder 4 + thinking 4 + name 2 + '{"a":1}' 7 = 21 ASCII; + 1 CJK
    expect(n).toBe(Math.ceil(21 / 4 + 1));
  });

  it("handles 2 million CJK characters in well under 2s (linear, not quadratic)", () => {
    const big = "中".repeat(2_000_000);
    const t0 = performance.now();
    expect(estimateTokens([user(big)], [])).toBe(2_000_000);
    // A linear pass takes tens of ms; a quadratic one would take minutes. 2 s tolerates CI load.
    expect(performance.now() - t0).toBeLessThan(2000);
  });
});

describe("calibrate", () => {
  it("returns the estimate unchanged without a previous actual", () => {
    expect(calibrate(1000, null)).toBe(1000);
  });

  it("scales by inputTokens / estimate", () => {
    expect(calibrate(1000, { estimate: 100, inputTokens: 150 })).toBe(1500);
  });

  it("clamps the ratio to [0.5, 3]", () => {
    expect(calibrate(1000, { estimate: 100, inputTokens: 1000 })).toBe(3000);
    expect(calibrate(1000, { estimate: 100, inputTokens: 10 })).toBe(500);
  });

  it("ignores a degenerate previous estimate", () => {
    expect(calibrate(1000, { estimate: 0, inputTokens: 10 })).toBe(1000);
  });
});
