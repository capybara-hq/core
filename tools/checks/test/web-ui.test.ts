import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// design 是浏览器包（无扩展名导入）；names.ts 无 React 依赖，直接按相对路径取常量。
import { PAGE_TEMPLATES } from "../../../packages/design/src/templates/names.js";
import {
  checkWebUi,
  QUERY_PENDING,
  type QueryPending,
  type SsrPending,
  WEB_UI_TEMPLATES,
} from "../src/web-ui.js";

const run = (name: string, pending: SsrPending[] = [], queryPending: QueryPending[] = []) => {
  const dir = fileURLToPath(new URL(`../fixtures/web-ui/${name}`, import.meta.url));
  return checkWebUi(
    join(dir, "apps/web/src"),
    join(dir, "packages/design/src"),
    pending,
    queryPending,
  );
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
  it("web-ui-page-path flags a page without a header path", () =>
    one("page-path-missing", "web-ui-page-path", 4));
  it("web-ui-page-path reports a top-level spread as unconfirmable", () => {
    const f = run("page-path-spread");
    expect(f.map((x) => x.rule)).toEqual(["web-ui-page-path"]);
    expect(f[0]?.message).toContain("cannot be confirmed statically");
  });
  it("web-ui-page-path follows a const and exempts conversation/auth templates", () =>
    expect(run("page-path-ok")).toEqual([]));
  it("{...{ className }} 展开 -> web-ui-class-name", () =>
    one("spread-class", "web-ui-class-name", 6));
  it("createElement 的 style -> web-ui-style", () =>
    one("create-element-style", "web-ui-style", 7));
  it("JSX class 属性 -> web-ui-class-name", () => one("class-attr", "web-ui-class-name", 6));
  it("<style> 元素 -> web-ui-style", () => one("style-element", "web-ui-style", 6));
  it("<iframe> 元素 -> web-ui-iframe", () => one("iframe-element", "web-ui-iframe", 6));
  it('createElement("iframe") -> web-ui-iframe', () =>
    one("create-element-iframe", "web-ui-iframe", 7));
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

  describe("design-char-icon", () => {
    it("reports characters used as icons in design and web, with lines and icon names", () => {
      const f = run("char-icon");
      const rel = (file: string) => file.slice(file.indexOf("char-icon/") + "char-icon/".length);
      expect(f.map((x) => [x.rule, rel(x.file), x.line])).toEqual([
        // the tab alert's old square mark (■): now a drawn dot
        ["design-char-icon", "apps/web/src/alert.tsx", 2],
        ["design-char-icon", "apps/web/src/bad.tsx", 2],
        ["design-char-icon", "packages/design/src/bad.tsx", 2],
        ["design-char-icon", "packages/design/src/bad.tsx", 5],
      ]);
    });
    it("suggests the icon name in the message", () => {
      const msgs = run("char-icon").map((x) => x.message);
      expect(msgs.some((m) => m.includes('<Icon name="chevron-down">'))).toBe(true);
      expect(msgs.some((m) => m.includes('<Icon name="spinner">'))).toBe(true);
      expect(msgs.some((m) => m.includes('<Icon name="check">'))).toBe(true);
      for (const m of msgs) expect(m).toContain("characters are not icons");
    });
    it("allows box-drawing, ⌘, ↵, →, · and …", () => {
      expect(run("char-icon-ok")).toEqual([]);
    });
    it("checks apps/web/messages/*.json values", () => {
      const f = run("char-icon-messages");
      expect(f.map((x) => [x.rule, x.file.split("/").at(-1), x.line])).toEqual([
        ["design-char-icon", "zh.json", 3],
      ]);
    });
  });

  describe("web-ui-extension-label", () => {
    it("flags a hand-built provider-slash-model template label outside lib/extension-label.ts", () => {
      const f = run("provider-label");
      expect(f.map((x) => [x.rule, x.file.split("/").at(-1), x.line])).toEqual([
        ["web-ui-extension-label", "Picker.tsx", 1],
      ]);
      expect(f[0]?.message).toContain("modelLabel");
    });
    it("flags an unspaced label property but not the value", () => {
      const f = run("provider-label-unspaced");
      expect(f.map((x) => [x.rule, x.line])).toEqual([["web-ui-extension-label", 3]]);
    });
    it("allows an unspaced option value", () => {
      expect(run("provider-label-value-ok")).toEqual([]);
    });
    it("allows the helper file itself", () => {
      expect(run("provider-label-ok")).toEqual([]);
    });
  });

  describe("server-rendered pages (web-ssr-*)", () => {
    const at = (name: string, pending: SsrPending[] = []) =>
      run(name, pending).map((x) => [x.rule, x.file.split("/").at(-1), x.line]);
    it("web-ssr-loading-file flags a loading.tsx", () =>
      expect(at("ssr-loading-file")).toEqual([["web-ssr-loading-file", "loading.tsx", 1]]));
    it("web-ssr-client-page flags a use-client page under (app)", () =>
      expect(at("ssr-client-page")).toEqual([["web-ssr-client-page", "page.tsx", 1]]));
    it("web-ssr-first-paint is gone: an unseeded useLoad is no longer an ssr finding", () =>
      expect(at("query-direct-read").map((x) => x[0])).not.toContain("web-ssr-first-paint"));
    it("a server page rendering ./view passes web-ui-template when the view has a template", () =>
      expect(run("ssr-template-view")).toEqual([]));
    it("a server page whose ./view has no template fails web-ui-template", () =>
      one("ssr-template-view-missing", "web-ui-template"));
    it("SSR_PENDING exempts a listed file from the web-ssr rules", () =>
      expect(
        run("ssr-pending", [{ path: "app/(app)/x/page.tsx", reason: "not migrated" }]),
      ).toEqual([]));
    it("an unlisted client page still fails", () =>
      expect(run("ssr-pending").map((x) => x.rule)).toEqual(["web-ssr-client-page"]));
    it("web-ssr-stale-pending: a listed file without a violation fails", () => {
      const f = run("ssr-pending-stale", [{ path: "app/(app)/x/page.tsx", reason: "r" }]);
      expect(f.map((x) => x.rule)).toEqual(["web-ssr-stale-pending"]);
    });
    it("web-ssr-stale-pending: a listed file that does not exist fails", () => {
      const f = run("ssr-pending-stale", [{ path: "app/(app)/gone/page.tsx", reason: "r" }]);
      expect(f.map((x) => x.rule)).toEqual(["web-ssr-stale-pending"]);
      expect(f[0]?.message).toContain("does not exist");
    });
  });

  it("web-lib-client-hook flags a hook imported by a lib module without use client", () => {
    const f = run("lib-client-hook");
    expect(f.map((x) => [x.rule, x.file.split("/").pop(), x.line])).toEqual([
      ["web-lib-client-hook", "plain.ts", 2],
      ["web-lib-client-hook", "define.ts", 1],
    ]);
    expect(f[1]?.message).toContain("useEffect");
  });

  describe("query cache rules (web-query-*)", () => {
    const at = (name: string, queryPending: QueryPending[] = []) =>
      run(name, [], queryPending).map((x) => [x.rule, x.file.split("/").at(-1), x.line]);
    it("web-query-no-direct-read flags lib reads, useLoad and apiFetch outside fn", () =>
      expect(at("query-direct-read")).toEqual([
        ["web-query-no-direct-read", "view.tsx", 16],
        ["web-query-no-direct-read", "view.tsx", 17],
        ["web-query-no-direct-read", "view.tsx", 19],
        ["web-query-no-direct-read", "view.tsx", 20],
        ["web-query-no-direct-read", "view.tsx", 22],
      ]));
    it("web-query-no-direct-read names the spec section", () =>
      expect(run("query-direct-read")[0]?.message).toContain("web-query-cache-design.md §8"));
    it("web-query-keys flags an array literal key outside keys.ts", () =>
      expect(at("query-key-literal")).toEqual([
        ["web-query-keys", "view.tsx", 7],
        ["web-query-keys", "view.tsx", 12],
      ]));
    it("web-query-freshness flags an inline queryKey / queryFn object, not a spread", () =>
      expect(at("query-no-freshness")).toEqual([["web-query-freshness", "view.tsx", 8]]));
    it("web-query-page-read flags loaders, read, workspace in a server page", () =>
      expect(at("query-page-read")).toEqual([
        ["web-query-page-read", "page.tsx", 9],
        ["web-query-page-read", "page.tsx", 10],
        ["web-query-page-read", "page.tsx", 10],
      ]));
    it("web-query-route-table flags a page without an entry and an entry without a reason", () =>
      expect(at("query-route-missing")).toEqual([
        ["web-query-route-table", "page.tsx", 1],
        ["web-query-route-table", "page.tsx", 1],
      ]));
    it("web-query-route-table reports which page is which", () => {
      const f = run("query-route-missing");
      expect(f[0]?.file).toContain("/y/");
      expect(f[0]?.message).toContain("none");
      expect(f[1]?.file).toContain("/z/");
      expect(f[1]?.message).toContain("/z");
    });
    it("query-ok passes", () => expect(run("query-ok")).toEqual([]));
    it("QUERY_PENDING exempts a listed file from the web-query rules", () =>
      expect(
        run("query-direct-read", [], [{ path: "app/(app)/x/view.tsx", reason: "later" }]),
      ).toEqual([]));
    it("web-query-stale-pending: a listed file without a violation fails", () => {
      const f = run("query-pending-stale", [], [{ path: "app/(app)/x/page.tsx", reason: "r" }]);
      expect(f.map((x) => x.rule)).toEqual(["web-query-stale-pending"]);
    });
    it("web-query-stale-pending: a listed file that does not exist fails", () => {
      const f = run("query-pending-stale", [], [{ path: "app/(app)/gone/view.tsx", reason: "r" }]);
      expect(f.map((x) => x.rule)).toEqual(["web-query-stale-pending"]);
      expect(f[0]?.message).toContain("does not exist");
    });
    it("every QUERY_PENDING entry has a reason that names its task", () => {
      for (const e of QUERY_PENDING) expect(e.reason).toMatch(/Task \d+/);
    });
  });
});
