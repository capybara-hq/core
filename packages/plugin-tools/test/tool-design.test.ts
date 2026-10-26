import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkToolDesign } from "../src/check/tool-design.js";

const fixture = (name: string) =>
  fileURLToPath(new URL(`../fixtures/tool-design/${name}`, import.meta.url));

/** 行尾带某标记注释的行号。 */
function markedLines(file: string, marker: string): number[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .flatMap((l, i) => (l.includes(`// ${marker}`) ? [i + 1] : []));
}

describe("tool-design", () => {
  it("合规 fixture（含本地常量 / 函数 / 导入的消息）-> 0 条", () => {
    expect(checkToolDesign([fixture("clean")])).toEqual([]);
  });

  it("tool-description：过短、中文、非字面量、缺失、无法解析的 spec、BuiltinTool 字面量都报", () => {
    const f = checkToolDesign([fixture("bad-description")]);
    expect(f.every((x) => x.rule === "tool-description")).toBe(true);
    expect(f).toHaveLength(6);
    const msgs = f.map((x) => x.message);
    expect(msgs.filter((m) => m.includes("至少 20"))).toHaveLength(2); // register 过短 + builtin 过短
    expect(msgs.filter((m) => m.includes("不得含中文"))).toHaveLength(1);
    expect(msgs.filter((m) => m.includes("字符串字面量"))).toHaveLength(3);
    const file = `${fixture("bad-description")}/src/index.ts`;
    // 行号落在工具注册的调用处（即使 spec 是别处声明的常量）
    const lineOfText = (t: string) =>
      readFileSync(file, "utf8")
        .split("\n")
        .findIndex((l) => l.includes(t)) + 1;
    expect(f.map((x) => x.line)).toContain(lineOfText("register(NO_DESC"));
    expect(f.map((x) => x.line)).toContain(lineOfText('name: "short"'));
  });

  it("tool-error-actionable：无建议动词、动态消息都报；整词匹配", () => {
    const f = checkToolDesign([fixture("bad-error")]);
    expect(f.every((x) => x.rule === "tool-error-actionable")).toBe(true);
    const file = `${fixture("bad-error")}/src/index.ts`;
    const expected = ["LITERAL", "TEMPLATE", "CONST", "FUNCTION", "DYNAMIC", "WORD BOUNDARY"].map(
      (m) => markedLines(file, m)[0],
    );
    expect(f.map((x) => x.line)).toEqual(expected);
    expect(f[4]?.message).toContain("字符串字面量");
    expect(f[0]?.message).toContain("建议动词");
  });
});
