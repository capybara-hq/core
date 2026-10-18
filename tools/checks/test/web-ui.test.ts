import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// design 是浏览器包（无扩展名导入）；names.ts 无 React 依赖，直接按相对路径取常量。
import { PAGE_TEMPLATES } from "../../../packages/design/src/templates/names.js";
import { checkWebUi, WEB_UI_TEMPLATES } from "../src/web-ui.js";

const run = (name: string) => {
  const dir = fileURLToPath(new URL(`../fixtures/web-ui/${name}`, import.meta.url));
  return checkWebUi(join(dir, "apps/web/src"), join(dir, "packages/design/src"));
};

describe("checkWebUi", () => {
  it("WEB_UI_TEMPLATES 与 design 的 PAGE_TEMPLATES 一致", () => {
    expect([...WEB_UI_TEMPLATES]).toEqual([...PAGE_TEMPLATES]);
  });

  it("clean -> 0 条", () => {
    expect(run("clean")).toEqual([]);
  });

  it("bad-import -> web-ui-import，行号正确", () => {
    const f = run("bad-import");
    expect(f.map((x) => x.rule)).toEqual(["web-ui-import"]);
    expect(f[0]?.line).toBe(2);
    expect(f[0]?.message).toContain("@capybara-hq/design");
  });

  it("class-name -> web-ui-class-name", () => {
    const f = run("class-name");
    expect(f.map((x) => x.rule)).toEqual(["web-ui-class-name"]);
    expect(f[0]?.line).toBe(6);
  });

  it("inline-style -> web-ui-style", () => {
    const f = run("inline-style");
    expect(f.map((x) => x.rule)).toEqual(["web-ui-style"]);
    expect(f[0]?.line).toBe(6);
  });

  it("css-file -> web-ui-css-file", () => {
    const f = run("css-file");
    expect(f.map((x) => x.rule)).toEqual(["web-ui-css-file"]);
    expect(f[0]?.file).toMatch(/local\.css$/);
  });

  it("color-literal -> web-ui-color", () => {
    const f = run("color-literal");
    expect(f.map((x) => x.rule)).toEqual(["web-ui-color"]);
    expect(f[0]?.line).toBe(3);
  });

  it("page-without-template -> web-ui-template", () => {
    const f = run("page-without-template");
    expect(f.map((x) => x.rule)).toEqual(["web-ui-template"]);
    expect(f[0]?.message).toContain("ListPage");
  });

  it("design-color -> design-color-literal（tokens.css 豁免）", () => {
    const f = run("design-color");
    expect(f.map((x) => x.rule)).toEqual(["design-color-literal"]);
    expect(f[0]?.file).toMatch(/button\.tsx$/);
    expect(f[0]?.line).toBe(1);
  });
});
