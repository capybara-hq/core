import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { checkI18n, flattenKeys } from "../src/i18n.js";

const fixture = (name: string) =>
  fileURLToPath(new URL(`../fixtures/i18n/${name}`, import.meta.url));
const webMessages = fileURLToPath(new URL("../../../apps/web/messages", import.meta.url));

const tmp: string[] = [];
afterEach(() => {
  for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true });
});
const dirWith = (files: Record<string, string>): string => {
  const d = mkdtempSync(join(tmpdir(), "capybara-i18n-"));
  tmp.push(d);
  for (const [name, body] of Object.entries(files)) writeFileSync(join(d, name), body);
  return d;
};

describe("flattenKeys", () => {
  it("嵌套对象展平为点路径，只收叶子", () => {
    expect(flattenKeys({ a: { b: "x", c: { d: "y" } }, e: "z" })).toEqual(["a.b", "a.c.d", "e"]);
  });
});

describe("checkI18n", () => {
  it("missing-key -> 恰好 1 条 i18n-missing-key，点路径正确，带修正方法", () => {
    const f = checkI18n(fixture("missing-key"));
    expect(f.map((x) => x.rule)).toEqual(["i18n-missing-key"]);
    expect(f[0]?.message).toContain("common.cancel");
    expect(f[0]?.message).toContain("在 en.json 中补上该 key");
    expect(f[0]?.file).toMatch(/en\.json$/);
  });

  it("extra-key -> 恰好 1 条 i18n-extra-key，点路径正确，行号指向该 key", () => {
    const f = checkI18n(fixture("extra-key"));
    expect(f.map((x) => x.rule)).toEqual(["i18n-extra-key"]);
    expect(f[0]?.message).toContain("login.subtitle");
    expect(f[0]?.message).toContain("删除该 key");
    expect(f[0]?.line).toBe(7);
  });

  it("仓库里的 apps/web/messages -> 0 条", () => {
    expect(checkI18n(webMessages)).toEqual([]);
  });

  it("同名 key 一边是对象一边是字符串 -> 缺失与多出各报一条", () => {
    const d = dirWith({ "zh.json": '{"a":{"b":"x"}}', "en.json": '{"a":"x"}' });
    const f = checkI18n(d);
    expect(f.map((x) => x.rule)).toEqual(["i18n-missing-key", "i18n-extra-key"]);
    expect(f[0]?.message).toContain("「a.b」");
    expect(f[1]?.message).toContain("「a」");
  });

  it("文案文件缺失 -> i18n-missing-file（不会空扫描假绿）", () => {
    const d = dirWith({ "zh.json": '{"a":"x"}' });
    expect(checkI18n(d).map((x) => x.rule)).toEqual(["i18n-missing-file"]);
    expect(checkI18n(join(d, "nope")).map((x) => x.rule)).toEqual([
      "i18n-missing-file",
      "i18n-missing-file",
    ]);
  });

  it("JSON 解析失败 -> i18n-invalid-json", () => {
    const d = dirWith({ "zh.json": '{"a":"x"}', "en.json": "{" });
    expect(checkI18n(d).map((x) => x.rule)).toEqual(["i18n-invalid-json"]);
  });
});
