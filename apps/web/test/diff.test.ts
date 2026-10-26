import { describe, expect, it } from "vitest";
import { lineDiff, pairFiles } from "../src/lib/diff";

describe("lineDiff（纯文本按行比较）", () => {
  it("新增 / 删除 / 不变的行带前缀；没有改动返回空串", () => {
    expect(lineDiff("a\nb\nc\n", "a\nx\nc\n")).toBe("  a\n- b\n+ x\n  c");
    expect(lineDiff("", "one\ntwo")).toBe("+ one\n+ two");
    expect(lineDiff("gone\n", "")).toBe("- gone");
    expect(lineDiff("same\n", "same\n")).toBe("");
  });

  it("只保留改动前后 3 行上下文，中间以 … 隔开", () => {
    const before = Array.from({ length: 20 }, (_, i) => `l${i}`).join("\n");
    const after = before.replace("l2\n", "L2\n").replace("l17\n", "L17\n");
    const out = lineDiff(before, after).split("\n");
    expect(out).toContain("- l2");
    expect(out).toContain("+ L2");
    expect(out).toContain("…");
    expect(out).not.toContain("  l10");
    expect(out.at(-1)).toBe("  l19");
  });

  it("太大时不逐行比较：整段删除旧的、加入新的", () => {
    const big = (p: string) => Array.from({ length: 2500 }, (_, i) => `${p}${i}`).join("\n");
    const out = lineDiff(big("a"), big("b")).split("\n");
    expect(out[0]).toBe("- a0");
    expect(out.filter((l) => l.startsWith("+ "))).toHaveLength(2500);
  });
});

describe("pairFiles", () => {
  it("按路径配对：新增、修改、未变、删除（只在当前版本里的排在后面）", () => {
    const f = (path: string, content: string | null) => ({ path, size: 1, content });
    expect(
      pairFiles(
        [f("SKILL.md", "b"), f("a.txt", "same"), f("new.txt", "n")],
        [f("SKILL.md", "a"), f("a.txt", "same"), f("old.txt", "o")],
      ).map((p) => [p.path, p.change]),
    ).toEqual([
      ["SKILL.md", "modified"],
      ["a.txt", "unchanged"],
      ["new.txt", "added"],
      ["old.txt", "removed"],
    ]);
  });
});
