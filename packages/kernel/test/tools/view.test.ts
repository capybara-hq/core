import { describe, expect, it } from "vitest";
import { ToolViewSchema } from "../../src/conversations/events.js";
import { lineDiff, TOOL_VIEW_DIFF_MAX_LINES } from "../../src/tools/view.js";

const lines = (n: number, f: (i: number) => string) =>
  `${Array.from({ length: n }, (_, i) => f(i + 1)).join("\n")}\n`;

describe("lineDiff", () => {
  it("one replaced line: 1 add, 1 del, 3 lines of context on each side", () => {
    const before = lines(20, (i) => `line ${i}`);
    const after = before.replace("line 10\n", "LINE 10\n");
    const d = lineDiff(before, after);
    expect(d).toMatchObject({ added: 1, removed: 1, truncated: false });
    expect(d.hunks).toHaveLength(1);
    const h = d.hunks[0];
    expect(h?.oldStart).toBe(7);
    expect(h?.newStart).toBe(7);
    expect(h?.lines).toEqual([
      { kind: "ctx", text: "line 7" },
      { kind: "ctx", text: "line 8" },
      { kind: "ctx", text: "line 9" },
      { kind: "del", text: "line 10" },
      { kind: "add", text: "LINE 10" },
      { kind: "ctx", text: "line 11" },
      { kind: "ctx", text: "line 12" },
      { kind: "ctx", text: "line 13" },
    ]);
  });

  it("identical text: no hunks", () => {
    expect(lineDiff("a\nb\n", "a\nb\n")).toEqual({
      hunks: [],
      added: 0,
      removed: 0,
      truncated: false,
    });
  });

  it("a new file: every line added, the hunk starts at old line 0", () => {
    const d = lineDiff("", "a\nb\n");
    expect(d).toMatchObject({ added: 2, removed: 0, truncated: false });
    expect(d.hunks).toEqual([
      {
        oldStart: 0,
        newStart: 1,
        lines: [
          { kind: "add", text: "a" },
          { kind: "add", text: "b" },
        ],
      },
    ]);
  });

  it("changes far apart make separate hunks; close ones merge", () => {
    const before = lines(40, (i) => `l${i}`);
    const far = before.replace("l5\n", "X5\n").replace("l30\n", "X30\n");
    expect(lineDiff(before, far).hunks).toHaveLength(2);
    const near = before.replace("l5\n", "X5\n").replace("l10\n", "X10\n");
    expect(lineDiff(before, near).hunks).toHaveLength(1);
  });

  it("finds the minimal diff around an insertion", () => {
    const d = lineDiff("a\nb\nc\nd\n", "a\nb\nnew\nc\nd\n");
    expect(d).toMatchObject({ added: 1, removed: 0 });
    expect(d.hunks[0]?.lines.filter((l) => l.kind !== "ctx")).toEqual([
      { kind: "add", text: "new" },
    ]);
  });

  it("3,000 changed lines: truncated, at most TOOL_VIEW_DIFF_MAX_LINES lines, full counts", () => {
    const d = lineDiff(
      lines(3000, (i) => `a${i}`),
      lines(3000, (i) => `b${i}`),
    );
    expect(d.truncated).toBe(true);
    expect(d.added).toBe(3000);
    expect(d.removed).toBe(3000);
    const n = d.hunks.reduce((a, h) => a + h.lines.length, 0);
    expect(n).toBeLessThanOrEqual(TOOL_VIEW_DIFF_MAX_LINES);
    expect(n).toBeGreaterThan(0);
  });

  it("over 1 MB on one side: no hunks, counts from comparing the line sets", () => {
    const big = lines(80_000, (i) => `row ${i} ${"x".repeat(10)}`);
    const d = lineDiff(big, `${big}extra\n`);
    expect(d).toEqual({ hunks: [], added: 1, removed: 0, truncated: true });
  });

  it("long lines are cut so the view stays within the schema", () => {
    const d = lineDiff("", `${"y".repeat(5000)}\n`);
    expect(d.hunks[0]?.lines[0]?.text.length).toBeLessThanOrEqual(2000);
    const view = { kind: "edit", path: "/workspace/a", created: true, ...d };
    expect(ToolViewSchema.safeParse(view).success).toBe(true);
  });
});
