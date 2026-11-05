import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { checkDesignI18n, checkI18n, flattenKeys } from "../src/i18n.js";

const fixture = (name: string) =>
  fileURLToPath(new URL(`../fixtures/i18n/${name}`, import.meta.url));
const webMessages = fileURLToPath(new URL("../../../apps/web/messages", import.meta.url));
const designMessages = fileURLToPath(
  new URL("../../../packages/design/src/i18n.ts", import.meta.url),
);

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

  it("a message next-intl cannot parse (an unescaped tag, an unclosed brace) -> i18n-invalid-message", () => {
    const d = dirWith({
      "zh.json": '{"a":{"ok":"共 {count} 个","tag":"例如 1.0.0+git.<sha>"}}',
      "en.json": '{"a":{"ok":"{count} in all","tag":"for example 1.0.0+git.<commit>."}}',
    });
    const f = checkI18n(d);
    expect(f.map((x) => [x.rule, x.file.endsWith("zh.json")])).toEqual([
      ["i18n-invalid-message", true],
      ["i18n-invalid-message", false],
    ]);
    expect(f[1]?.message).toContain("「a.tag」");
    expect(f[1]?.message).toContain("UNCLOSED_TAG");

    const brace = dirWith({ "zh.json": '{"b":"{count"}', "en.json": '{"b":"x"}' });
    expect(checkI18n(brace).map((x) => x.rule)).toEqual(["i18n-invalid-message"]);
  });

  it("quoted brackets, rich-text tags and plurals are valid messages", () => {
    const d = dirWith({
      "zh.json": `{"q":"'<'commit'>'","r":"<b>粗</b>","p":"{n, plural, one {# 个} other {# 个}}"}`,
      "en.json": `{"q":"'<'commit'>'","r":"<b>bold</b>","p":"{n, plural, one {# item} other {# items}}"}`,
    });
    expect(checkI18n(d)).toEqual([]);
  });

  it("a title, label or button ending with a period -> i18n-label-period (zh and en)", () => {
    const f = checkI18n(fixture("label-period"));
    expect(f.map((x) => [x.rule, x.file.endsWith("zh.json") ? "zh" : "en"])).toEqual([
      ["i18n-label-period", "zh"],
      ["i18n-label-period", "zh"],
      ["i18n-label-period", "en"],
    ]);
    expect(f.map((x) => x.message.match(/「([^」]+)」/)?.[1])).toEqual([
      "agents.form.submit",
      "agents.form.confirmLabel",
      "agents.title",
    ]);
    // the line points at the key; sentences (hints) and an ellipsis are fine
    expect(f[0]?.line).toBe(5);
  });

  it("label keys: the last segment or its camelCase last word, case-insensitive", () => {
    const d = dirWith({
      "zh.json": JSON.stringify({
        a: { Title: "x。", pageTitle: "y。", subtitle: "z。", titled: "w。", menuItem: "v。" },
      }),
      "en.json": JSON.stringify({
        a: { Title: "x", pageTitle: "y", subtitle: "z.", titled: "w.", menuItem: "v" },
      }),
    });
    expect(checkI18n(d).map((x) => x.message.match(/「([^」]+)」/)?.[1])).toEqual([
      "a.Title",
      "a.pageTitle",
      "a.menuItem",
    ]);
  });

  it("three dots in a message -> i18n-ellipsis (zh and en), the single character is fine", () => {
    const f = checkI18n(fixture("ellipsis"));
    expect(f.map((x) => [x.rule, x.file.endsWith("zh.json") ? "zh" : "en"])).toEqual([
      ["i18n-ellipsis", "zh"],
      ["i18n-ellipsis", "zh"],
      ["i18n-ellipsis", "en"],
      ["i18n-ellipsis", "en"],
    ]);
    expect(f[0]?.message).toContain("org.delete");
    expect(f[0]?.line).toBe(3);
  });

  it("a half-width ? ! : ; right after a CJK character in zh -> i18n-cjk-halfwidth", () => {
    const f = checkI18n(fixture("cjk-halfwidth"));
    expect(f.map((x) => x.rule)).toEqual(Array(4).fill("i18n-cjk-halfwidth"));
    expect(f.every((x) => x.file.endsWith("zh.json"))).toBe(true);
    expect(f.map((x) => x.message.match(/「([^」]+)」/)?.[1])).toEqual([
      "chat.placeholder",
      "chat.warn",
      "chat.colon",
      "chat.semi",
    ]);
  });

  it("企业 in a zh message -> i18n-zh-enterprise (zh only; en may say enterprise)", () => {
    const f = checkI18n(fixture("zh-enterprise"));
    expect(f.map((x) => x.rule)).toEqual(["i18n-zh-enterprise", "i18n-zh-enterprise"]);
    expect(f.every((x) => x.file.endsWith("zh.json"))).toBe(true);
    expect(f.map((x) => x.message.match(/「([^」]+)」/)?.[1])).toEqual([
      "admin.role",
      "admin.catalog",
    ]);
    expect(f[0]?.message).toContain("超级管理员");
    expect(f[0]?.line).toBe(3);
  });

  it("the Latin word agent in a zh message -> i18n-zh-agent; placeholders and select keys are not text", () => {
    const f = checkI18n(fixture("zh-agent"));
    expect(f.map((x) => x.rule)).toEqual(Array(4).fill("i18n-zh-agent"));
    expect(f.every((x) => x.file.endsWith("zh.json"))).toBe(true);
    expect(f.map((x) => x.message.match(/「([^」]+)」/)?.[1])).toEqual([
      "agents.title",
      "agents.new",
      "agents.sub",
      "agents.branch",
    ]);
    expect(f[1]?.message).toContain("智能体");
  });

  it("JSON 解析失败 -> i18n-invalid-json", () => {
    const d = dirWith({ "zh.json": '{"a":"x"}', "en.json": "{" });
    expect(checkI18n(d).map((x) => x.rule)).toEqual(["i18n-invalid-json"]);
  });
});

describe("checkDesignI18n", () => {
  it("applies the zh word rules to the design system's zh strings; en and placeholders pass", () => {
    const file = join(fixture("design-zh"), "i18n.ts");
    const f = checkDesignI18n(file);
    expect(f.map((x) => [x.rule, x.line])).toEqual([
      ["i18n-zh-agent", 4],
      ["i18n-zh-enterprise", 5],
    ]);
    expect(f.every((x) => x.file === file)).toBe(true);
    expect(f[0]?.message).toContain("nav.agents");
    expect(f[1]?.message).toContain("平台");
  });

  it("an entry of the zh object that is not a plain string literal cannot be confirmed", () => {
    const file = join(fixture("design-unreadable"), "i18n.ts");
    const f = checkDesignI18n(file);
    expect(f.map((x) => [x.rule, x.line])).toEqual([["i18n-design-unreadable", 3]]);
    expect(f[0]?.message).toContain("cannot be confirmed statically");
  });

  it("a file without a zh object is reported", () => {
    const d = dirWith({ "i18n.ts": "export const en = {};\n" });
    expect(checkDesignI18n(join(d, "i18n.ts")).map((x) => x.rule)).toEqual([
      "i18n-design-unreadable",
    ]);
  });

  it("the design system's zh strings pass", () => {
    expect(checkDesignI18n(designMessages)).toEqual([]);
  });
});
