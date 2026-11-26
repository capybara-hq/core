import { describe, expect, it } from "vitest";
import { liveEditDiff, liveWriteDiff, writingLines } from "../src/lib/live-diff";

const lines = (n: number, f: (i: number) => string) =>
  `${Array.from({ length: n }, (_, i) => f(i + 1)).join("\n")}\n`;

describe("liveWriteDiff", () => {
  it("an identical prefix has no hunks; the rest of the base is pending", () => {
    const base = lines(10, (i) => `line ${i}`);
    const r = liveWriteDiff(
      base,
      lines(4, (i) => `line ${i}`),
    );
    expect(r.diff.hunks).toEqual([]);
    expect(r).toMatchObject({ added: 0, removed: 0, pending: 6 });
  });

  it("a rewrite of the middle removes lines only before the aligned line", () => {
    const base = lines(12, (i) => `line ${i}`);
    const prefix = "line 1\nline 2\nNEW\nline 5\nline 6\nline 7\nline 8\n";
    const r = liveWriteDiff(base, prefix);
    expect(r).toMatchObject({ added: 1, removed: 2, pending: 4 });
    const changes = r.diff.hunks.flatMap((h) => h.lines.filter((l) => l.kind !== "ctx"));
    expect(changes).toEqual([
      { kind: "del", text: "line 3" },
      { kind: "del", text: "line 4" },
      { kind: "add", text: "NEW" },
    ]);
    // real line numbers
    expect(r.diff.hunks[0]).toMatchObject({ oldStart: 1, newStart: 1 });
  });

  it("the unfinished last line is shown as added and aligns nothing", () => {
    const base = "a\nb\nc\n";
    const r = liveWriteDiff(base, "a\nb");
    // "b" is still being written, so it and "c" are both not reached
    expect(r).toMatchObject({ added: 1, removed: 0, pending: 2 });
    expect(r.diff.hunks[0]?.lines.at(-1)).toEqual({ kind: "add", text: "b" });
  });

  it("unrelated text: no aligned line, so the whole base is pending", () => {
    const r = liveWriteDiff("x\ny\n", "p\nq\n");
    expect(r).toMatchObject({ added: 2, removed: 0, pending: 2 });
  });

  it("a blank matched line is not the last aligned line", () => {
    const r = liveWriteDiff("a\n\nz\n", "a\nq\n\n");
    // the blank after "a" matches only at the end: "a" stays the last aligned line
    expect(r.removed).toBe(0);
    expect(r.pending).toBeGreaterThanOrEqual(1);
  });

  it("an empty prefix leaves everything pending", () => {
    expect(liveWriteDiff("a\nb\n", "")).toMatchObject({ added: 0, removed: 0, pending: 2 });
  });

  it("the finished prefix gives the kernel's hunks for a replaced line", () => {
    const before = lines(20, (i) => `line ${i}`);
    const after = before.replace("line 10\n", "LINE 10\n");
    const r = liveWriteDiff(before, after);
    expect(r).toMatchObject({ added: 1, removed: 1, pending: 0 });
    expect(r.diff.hunks).toEqual([
      {
        oldStart: 7,
        newStart: 7,
        lines: [
          { kind: "ctx", text: "line 7" },
          { kind: "ctx", text: "line 8" },
          { kind: "ctx", text: "line 9" },
          { kind: "del", text: "line 10" },
          { kind: "add", text: "LINE 10" },
          { kind: "ctx", text: "line 11" },
          { kind: "ctx", text: "line 12" },
          { kind: "ctx", text: "line 13" },
        ],
      },
    ]);
  });

  it("the finished prefix of an insertion gives the kernel's minimal diff", () => {
    const r = liveWriteDiff("a\nb\nc\nd\n", "a\nb\nnew\nc\nd\n");
    expect(r).toMatchObject({ added: 1, removed: 0, pending: 0 });
    expect(r.diff.hunks[0]?.lines.filter((l) => l.kind !== "ctx")).toEqual([
      { kind: "add", text: "new" },
    ]);
  });

  it("a new file: every line added, the hunk starts at old line 0", () => {
    const r = liveWriteDiff("", "a\nb\n");
    expect(r).toMatchObject({ added: 2, removed: 0, pending: 0 });
    expect(r.diff.hunks).toEqual([
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
    expect(liveWriteDiff(before, far).diff.hunks).toHaveLength(2);
    const near = before.replace("l5\n", "X5\n").replace("l10\n", "X10\n");
    expect(liveWriteDiff(before, near).diff.hunks).toHaveLength(1);
  });

  it("beyond the edit budget the part is removed then added, not minimal but correct", () => {
    const before = `head\n${lines(1500, (i) => `a${i}`)}tail\n`;
    // 1,500 different lines, then the old tail again: more than 1,000 edits to align
    const after = `head\n${lines(1500, (i) => `b${i}`)}tail\n`;
    const r = liveWriteDiff(before, after);
    const kinds = r.diff.hunks.flatMap((h) => h.lines.map((l) => l.kind));
    expect(kinds.filter((k) => k === "add")).toHaveLength(1501);
    // no add before a del: the part is one removed run, then one added run
    expect(kinds.indexOf("add")).toBeGreaterThan(kinds.lastIndexOf("del"));
    // nothing after "head" aligned, so every old line past it is pending
    expect(r).toMatchObject({ removed: 0, pending: 1501 });
  });

  it("keeps the last 2,000 diff lines of a huge write and says so", () => {
    const r = liveWriteDiff(
      "",
      lines(3000, (i) => `n${i}`),
    );
    expect(r.added).toBe(3000);
    expect(r.diff.truncated).toBe(true);
    expect(r.diff.totalLines).toBe(3000);
    const kept = r.diff.hunks.flatMap((h) => h.lines);
    expect(kept).toHaveLength(2000);
    expect(kept.at(-1)?.text).toBe("n3000");
    expect(r.diff.hunks[0]?.newStart).toBe(1001);
  });
});

describe("liveEditDiff", () => {
  it("puts every old line as del and the new prefix as add, with a pending gutter", () => {
    const d = liveEditDiff("a\nb\n", "A\nB\nC");
    expect(d).toEqual({
      hunks: [
        {
          oldStart: 0,
          newStart: 0,
          lines: [
            { kind: "del", text: "a" },
            { kind: "del", text: "b" },
            { kind: "add", text: "A" },
            { kind: "add", text: "B" },
            { kind: "add", text: "C" },
          ],
        },
      ],
      truncated: false,
    });
  });

  it("nothing yet: no hunks", () => {
    expect(liveEditDiff("", "")).toEqual({ hunks: [], truncated: false });
  });
});

describe("writingLines", () => {
  it("numbers context lines from 1, the unfinished line included", () => {
    expect(writingLines("a\nb\nc")).toEqual({
      hunks: [
        {
          oldStart: 1,
          newStart: 1,
          lines: [
            { kind: "ctx", text: "a" },
            { kind: "ctx", text: "b" },
            { kind: "ctx", text: "c" },
          ],
        },
      ],
      truncated: false,
    });
    expect(writingLines("")).toEqual({ hunks: [], truncated: false });
  });
});
