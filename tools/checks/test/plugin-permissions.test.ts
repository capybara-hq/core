import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkPluginPermissions } from "../src/plugin-permissions.js";

const fixture = (name: string) => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
const real = (path: string) => fileURLToPath(new URL(`../../../${path}`, import.meta.url));

/** 行尾标 FLAG 的行号。 */
function flagged(name: string): number[] {
  return readFileSync(fixture(`${name}/src/index.ts`), "utf8")
    .split("\n")
    .flatMap((l, i) => (l.includes("// FLAG") ? [i + 1] : []));
}

describe("违规 fixture：每条规则一个，恰好报行尾标 FLAG 的那些", () => {
  const cases: [string, string, number][] = [
    ["plugin-perm-secrets", "perm-secrets", 1],
    ["plugin-perm-http", "perm-http", 3],
    ["plugin-perm-tools", "perm-tools", 2],
    ["plugin-perm-capability", "perm-capability", 2],
    ["plugin-perm-reserved", "perm-reserved", 2],
  ];
  for (const [dir, rule, count] of cases) {
    it(`${rule}`, () => {
      const f = checkPluginPermissions([fixture(dir)]);
      expect(flagged(dir).length).toBe(count);
      expect(f.map((x) => x.line)).toEqual(flagged(dir));
      expect(f.every((x) => x.rule === rule)).toBe(true);
    });
  }

  it("报错信息指出清单里要改哪一项", () => {
    const msg = (d: string) => checkPluginPermissions([fixture(d)])[0]?.message;
    expect(msg("plugin-perm-secrets")).toContain("permissions.secrets");
    expect(msg("plugin-perm-http")).toContain("permissions.http");
    expect(msg("plugin-perm-tools")).toContain("permissions.tools");
    expect(msg("plugin-perm-capability")).toContain("requires or optional");
  });
});

describe("动态值与豁免", () => {
  it("动态路径 / 工具名 / 能力 ref 报「无法静态确认」，带原因的豁免不报，空原因仍报", () => {
    const f = checkPluginPermissions([fixture("plugin-perm-dynamic")]);
    // 行尾标 FLAG 的三处，加最后一行的空原因豁免（行尾不能再写 FLAG）
    expect(f.map((x) => x.line)).toEqual([...flagged("plugin-perm-dynamic"), 19]);
    expect(f.map((x) => x.rule)).toEqual([
      "perm-http",
      "perm-tools",
      "perm-capability",
      "perm-capability",
    ]);
    expect(f[0]?.message).toContain("Cannot statically confirm");
    expect(f[3]?.message).toContain("reason");
  });
});

describe("豁免注释只放行「无法静态确认」", () => {
  it("明确违规（secrets / http / tools / capability / storage / models）带豁免注释仍报", () => {
    const f = checkPluginPermissions([fixture("plugin-perm-marker")]);
    expect(f.map((x) => x.line)).toEqual(flagged("plugin-perm-marker"));
    expect(f.map((x) => x.rule)).toEqual([
      "perm-secrets",
      "perm-http",
      "perm-tools",
      "perm-capability",
      "perm-reserved",
      "perm-reserved",
    ]);
    expect(f.some((x) => x.message.includes("Cannot statically"))).toBe(false);
  });
});

describe("解构、计算成员与参数默认值", () => {
  it("解构 ctx / 计算成员 / 解构参数报无法静态确认（带原因的豁免不报）；默认值参数照常跟踪", () => {
    const f = checkPluginPermissions([fixture("plugin-perm-destructure")]);
    expect(f.map((x) => x.line)).toEqual(flagged("plugin-perm-destructure"));
    expect(f.map((x) => x.rule)).toEqual([
      "perm-reserved",
      "perm-reserved",
      "perm-reserved",
      "perm-secrets",
    ]);
    expect(f[0]?.message).toContain("Cannot statically confirm");
    expect(f[3]?.message).toContain("permissions.secrets");
  });
});

describe("正例与解析失败", () => {
  it("clean fixture（别名、传给同文件函数的 ctx、同文件 const）通过", () => {
    expect(checkPluginPermissions([fixture("plugin-perm-clean")])).toEqual([]);
  });

  it("现有全部插件通过", () => {
    expect(checkPluginPermissions([real("plugins")])).toEqual([]);
  });

  it("语法错误 -> parse-error（不能静默放过）", () => {
    const d = mkdtempSync(join(tmpdir(), "capybara-pp-"));
    try {
      writeFileSync(join(d, "index.ts"), "const = ;;; let\n");
      expect(checkPluginPermissions([d]).map((x) => x.rule)).toEqual(["parse-error"]);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});
