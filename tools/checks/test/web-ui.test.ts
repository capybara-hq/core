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

  const one = (name: string, rule: string, line?: number) => {
    const f = run(name);
    expect(f.map((x) => x.rule)).toEqual([rule]);
    if (line !== undefined) expect(f[0]?.line).toBe(line);
  };

  it("dev 目录豁免模板规则，其他规则仍生效", () => {
    expect(run("dev-exempt")).toEqual([]);
  });
  it("{...{ className }} 展开 -> web-ui-class-name", () =>
    one("spread-class", "web-ui-class-name", 6));
  it("createElement 的 style -> web-ui-style", () =>
    one("create-element-style", "web-ui-style", 7));
  it("JSX class 属性 -> web-ui-class-name", () => one("class-attr", "web-ui-class-name", 6));
  it("<style> 元素 -> web-ui-style", () => one("style-element", "web-ui-style", 6));
  it("别名导入的模板通过", () => expect(run("aliased-template")).toEqual([]));
  it("本地同名组件不算模板", () => one("local-template", "web-ui-template"));
  it("styled-components 导入 -> web-ui-import", () => one("styled-import", "web-ui-import", 1));
  it("require 的 .css -> web-ui-import", () => one("require-css", "web-ui-import", 3));
  it("大写十六进制 -> web-ui-color", () => one("uppercase-hex", "web-ui-color", 3));
  it("模板字面量里的颜色函数 -> web-ui-color", () => one("template-color", "web-ui-color", 3));
  it("只调用 next/navigation 的 notFound()、不含 JSX 的 page 豁免模板规则", () =>
    expect(run("not-found-only")).toEqual([]));
  it("调用 notFound() 但含 JSX 且无模板 -> web-ui-template", () =>
    one("not-found-with-jsx", "web-ui-template"));
  it("本地定义的 notFound 不算豁免 -> web-ui-template", () =>
    one("not-found-local", "web-ui-template"));
});
