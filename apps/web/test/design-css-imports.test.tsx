import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postcss, { type AtRule, type Node } from "postcss";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const webDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const entry = resolve(webDir, "../../packages/design/src/styles/index.css");
const nextConfig = require("../next.config.mjs").default;

type Rule = { enforce?: string; test?: (resource: string) => boolean; use: { loader: string }[] };
const configInput = () => ({
  context: webDir,
  resolve: { conditionNames: ["browser", "development", "import"] },
  module: { rules: [] as Rule[] },
});

function inDesignLayer(node: Node): boolean {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (parent.type !== "atrule") continue;
    const atRule = parent as AtRule;
    if (atRule.name === "layer" && atRule.params === "design") {
      return true;
    }
  }
  return false;
}

describe("development design CSS imports", () => {
  it("expands the real design entry into active layers before Next's legacy CSS parser", async () => {
    const config = nextConfig.webpack(configInput(), { dev: true });
    const rule = (config.module.rules as Rule[]).find((item) => item.test?.(entry));
    expect(rule?.enforce).toBe("pre");
    expect(rule?.test?.(resolve(dirname(entry), "base.css"))).toBe(false);
    if (!rule) throw new Error("Missing design entry preprocessing rule");
    const loader = require(rule.use[0]?.loader ?? "");
    const dependencies = new Set<string>();
    const result = await new Promise<{ css: string; map: { sources: string[] } }>(
      (done, reject) => {
        loader.call(
          {
            resourcePath: entry,
            sourceMap: true,
            addDependency: (file: string) => dependencies.add(file),
            emitWarning: reject,
            async: () => (error: Error | null, css: string, map: { sources: string[] }) =>
              error ? reject(error) : done({ css, map }),
          },
          readFileSync(entry, "utf8"),
        );
      },
    );
    const root = postcss.parse(result.css);
    const order = root.nodes[0] as AtRule;
    expect([order.name, order.params, order.nodes]).toEqual([
      "layer",
      "design, theme, extensions",
      undefined,
    ]);
    const layers: AtRule[] = [];
    root.walkAtRules("layer", (node) => {
      if (node.nodes) layers.push(node);
    });
    expect(layers.length).toBeGreaterThan(0);
    expect(layers.every((node) => node.params === "design")).toBe(true);
    root.walkAtRules("import", () => {
      throw new Error("A layered import reached Next's legacy import parser");
    });
    root.walkAtRules("media", (node) => expect(node.params).not.toMatch(/layer\(/));
    const bodyRules: string[] = [];
    const authRules: string[] = [];
    root.walkRules((node) => {
      expect(inDesignLayer(node)).toBe(true);
      if (node.selector === "body") bodyRules.push(node.toString());
      if (node.selector === ".cb-auth-main") authRules.push(node.toString());
    });
    expect(bodyRules.join("\n")).toContain("margin: 0");
    expect(authRules.join("\n")).toContain("display: flex");
    expect(result.css.indexOf('font-family: "Sarasa Mono SC"')).toBeLessThan(
      result.css.indexOf("--cb-font:"),
    );
    expect(result.css.indexOf("--cb-font:")).toBeLessThan(result.css.indexOf("box-sizing:"));

    // These imports are read by the preprocessor, so Webpack must watch each one for HMR.
    postcss.parse(readFileSync(entry, "utf8")).walkAtRules("import", (node) => {
      const imported = node.params.match(/^"([^"]+)"/)?.[1];
      expect(imported).toBeDefined();
      expect(dependencies.has(resolve(dirname(entry), imported ?? ""))).toBe(true);
    });
    expect(result.map.sources.some((source) => source.endsWith("fonts.css"))).toBe(true);
    expect(result.map.sources.some((source) => source.endsWith("templates.css"))).toBe(true);

    // All current design imports are siblings of the entry; their font URLs must still resolve.
    const fonts: string[] = [];
    root.walkAtRules("font-face", (node) => {
      node.walkDecls("src", (declaration) => {
        const url = declaration.value.match(/url\("([^"]+)"\)/)?.[1];
        expect(url).toBeDefined();
        expect(existsSync(resolve(dirname(entry), url ?? ""))).toBe(true);
        fonts.push(url ?? "");
      });
    });
    expect(fonts).toHaveLength(6);
    expect(fonts).toContain("../fonts/SarasaMonoSC-Regular.subset.woff2");
    expect(config.resolve.conditionNames).toEqual([
      "@capybara-hq/source",
      "browser",
      "development",
      "import",
    ]);
    expect(config.resolve.alias["next-intl/config"]).toBe(resolve(webDir, "src/i18n/request.ts"));
  });

  it("leaves production rules and resolver conditions unchanged", () => {
    const input = configInput();
    const config = nextConfig.webpack(input, { dev: false });
    expect(config.module.rules).toEqual([]);
    expect(config.resolve.conditionNames).toEqual(["browser", "development", "import"]);
  });
});
