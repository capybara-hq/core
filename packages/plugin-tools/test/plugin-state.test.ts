import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { checkPluginState, type Finding } from "../src/check/plugin-state.js";
import { bypassFixture } from "./bypass-fixture.js";

const fixture = (name: string) => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));

const tmp: string[] = [];
afterEach(() => {
  for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("plugin-module-state", () => {
  let all: Finding[] = [];
  let idx: Finding[] = [];
  beforeAll(async () => {
    all = await checkPluginState([fixture("plugin-module-state")]);
    idx = all.filter((x) => x.file.endsWith("index.ts"));
  });

  it("let / var / export let / Map / Set / WeakMap / WeakSet / 数组（含 as 与括号包裹）都报，恰好行尾标 FLAG 的那些", async () => {
    const flagged = readFileSync(fixture("plugin-module-state/src/index.ts"), "utf8")
      .split("\n")
      .flatMap((l, i) => (l.includes("// FLAG") ? [i + 1] : []));
    expect(flagged.length).toBe(11);
    expect(idx.map((x) => x.line)).toEqual(flagged);
    expect(idx.every((x) => x.rule === "plugin-module-state")).toBe(true);
  });

  it("报错信息给出改法", async () => {
    expect(idx[0]?.message).toContain("ctx.kv");
    expect(idx[0]?.message).toContain("ctx.queue");
    expect(idx[0]?.message).toContain("ctx.bus");
  });

  it("豁免：同行、紧邻上一行带原因 -> 不报；空原因、块注释、隔行、上一语句行尾 -> 仍报", async () => {
    const m = all.filter((x) => x.file.endsWith("marked.ts"));
    expect(m.map((x) => x.line)).toEqual([6, 7, 10, 12]);
    expect(m.find((x) => x.line === 6)?.message).toContain("原因");
  });
});

describe("plugin-timer", () => {
  let all: Finding[] = [];
  beforeAll(async () => {
    all = await checkPluginState([fixture("plugin-timer")]);
  });
  it("setTimeout / setInterval / setImmediate / globalThis.x / globalThis['x'] / 别名 / timers 导入都报", async () => {
    expect(all.every((x) => x.rule === "plugin-timer")).toBe(true);
    const idx = all.filter((x) => x.file.endsWith("index.ts")).map((x) => x.line);
    expect(idx).toEqual([2, 3, 6, 7, 8, 9, 10, 11, 13]);
    expect(idx).not.toContain(12);
  });
  it("require / 动态 import node:timers 也报", async () => {
    const r = all.filter((x) => x.file.endsWith("require.ts")).map((x) => x.line);
    expect(r).toEqual([1, 2]);
  });
  it("报错信息给出改法", async () => {
    expect(all[0]?.message).toContain("ctx.queue");
  });
});

describe("plugin-timer and client code", () => {
  const dir = fixture("plugin-timer-client");
  let all: Finding[] = [];
  beforeAll(async () => {
    all = await checkPluginState([dir]);
  });
  const flagged = (rel: string) =>
    readFileSync(join(dir, rel), "utf8")
      .split("\n")
      .flatMap((l, i) => (l.includes("// FLAG") ? [`${rel}:${i + 1}`] : []));

  // `#` subpath imports are followed through the package.json imports map on both sides
  it("refuses timers and module state in server modules, allows them in modules only the client entry reaches", async () => {
    const expected = [
      "src/index.ts",
      "src/orphan.ts",
      "src/server-helper.ts",
      "src/shared.ts",
      "src/util.ts",
    ]
      .flatMap(flagged)
      .sort();
    expect(expected).toHaveLength(7);
    expect(all.map((x) => `${x.file.slice(dir.length + 1)}:${x.line}`).sort()).toEqual(expected);
    const state = all.filter((x) => x.rule === "plugin-module-state");
    expect(state.map((x) => x.file.slice(dir.length + 1)).sort()).toEqual([
      "src/server-helper.ts",
      "src/shared.ts",
    ]);
  });

  it("a client entry the server entry imports is server code", async () => {
    const d = mkdtempSync(join(tmpdir(), "capybara-ps-"));
    tmp.push(d);
    cpSync(dir, d, { recursive: true });
    writeFileSync(join(d, "src/index.ts"), 'export { boot } from "./client.js";\n');
    const files = (await checkPluginState([d])).map((x) => x.file.slice(d.length + 1));
    expect(files).toContain("src/client.tsx");
    expect(files).toContain("src/ui/glitch.tsx");
  });

  it("module state in a client entry the server entry imports is refused", async () => {
    const d = mkdtempSync(join(tmpdir(), "capybara-ps-"));
    tmp.push(d);
    cpSync(dir, d, { recursive: true });
    writeFileSync(join(d, "src/index.ts"), 'export { boot } from "./client.js";\n');
    const state = (await checkPluginState([d])).filter((x) => x.rule === "plugin-module-state");
    expect(state.map((x) => x.file.slice(d.length + 1))).toContain("src/client.tsx");
    expect(state.map((x) => x.file.slice(d.length + 1))).toContain("src/ui/glitch.tsx");
  });
});

describe("the server side is the packer's esbuild bundle", () => {
  /**
   * A plugin whose client entry imports `src/ui/a.ts` (a timer on line 1, module state on line 2);
   * `index` is its server entry and `setup` adds what the edge needs.
   */
  function plugin(index: string, setup: (d: string) => void = () => {}): string {
    const d = mkdtempSync(join(tmpdir(), "capybara-ps-"));
    tmp.push(d);
    mkdirSync(join(d, "src/ui"), { recursive: true });
    writeFileSync(
      join(d, "package.json"),
      JSON.stringify({ name: "selfref", version: "0.0.0", private: true, type: "module" }),
    );
    writeFileSync(
      join(d, "src/client.tsx"),
      'import { a } from "./ui/a.js";\nexport default { a };\n',
    );
    writeFileSync(
      join(d, "src/ui/a.ts"),
      "export const a = () => setTimeout(() => {}, 1);\nexport const cache = new Map<string, number>();\n",
    );
    writeFileSync(join(d, "src/index.ts"), index);
    setup(d);
    return d;
  }
  const onA = async (d: string) =>
    (await checkPluginState([d]))
      .filter((x) => x.file.endsWith(join("src", "ui", "a.ts")))
      .map((x) => `${x.line} ${x.rule}`);
  const BOTH = ["1 plugin-timer", "2 plugin-module-state"];

  it("a module only the client entry reaches is not checked", async () => {
    expect(await onA(plugin("export default {};\n"))).toEqual([]);
  });

  const reached: [string, string, ((d: string) => void)?][] = [
    ["a glob import()", "export const load = (n: string) => import(`./ui/${n}.ts`);\n"],
    [
      "tsconfig paths",
      'import { a } from "@app/ui/a";\nexport default { a };\n',
      (d) =>
        writeFileSync(
          join(d, "tsconfig.json"),
          JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@app/*": ["src/*"] } } }),
        ),
    ],
    [
      "a symlinked file",
      'import { a } from "./helper.js";\nexport default { a };\n',
      (d) => symlinkSync(join(d, "src/ui/a.ts"), join(d, "src/helper.ts")),
    ],
    [
      "a symlinked directory",
      'import { a } from "./lib/a.js";\nexport default { a };\n',
      (d) => symlinkSync(join(d, "src/ui"), join(d, "src/lib")),
    ],
    [
      "a self reference through package.json exports",
      'import { a } from "selfref/ui";\nexport default { a };\n',
      (d) =>
        writeFileSync(
          join(d, "package.json"),
          JSON.stringify({
            name: "selfref",
            version: "0.0.0",
            private: true,
            type: "module",
            exports: { "./ui": "./src/ui/a.ts" },
          }),
        ),
    ],
    ["./a.jsx for a.ts", 'import { a } from "./ui/a.jsx";\nexport default { a };\n'],
    ["a literal import()", 'export const load = () => import("./ui/a.js");\n'],
    ["require", 'export const a = require("./ui/a.ts");\n'],
    ["export *", 'export * from "./ui/a.js";\n'],
    [
      "a chain through a shared module",
      'export { a } from "./shared.js";\n',
      (d) => writeFileSync(join(d, "src/shared.ts"), 'export { a } from "./ui/a.js";\n'),
    ],
  ];
  for (const [edge, index, setup] of reached) {
    it(`a module the server bundle reaches through ${edge} is checked`, async () => {
      expect(await onA(plugin(index, setup))).toEqual(BOTH);
    });
  }

  it("fails closed: when the server build fails, every module is checked", async () => {
    const d = plugin('import x from "not-an-installed-package";\nexport default { x };\n');
    expect(await onA(d)).toEqual(BOTH);
  });
});

describe("真实正例与反例", () => {
  it("a clean plugin -> no findings", async () => {
    expect(await checkPluginState([fixture("plugin-clean")])).toEqual([]);
  });

  it("test 目录、*.test.ts、node_modules、dist 不扫描", async () => {
    const d = mkdtempSync(join(tmpdir(), "capybara-ps-"));
    tmp.push(d);
    for (const p of ["test", "node_modules/x", "dist", "src"]) {
      cpSync(fixture("plugin-module-state/src"), join(d, p), { recursive: true });
    }
    writeFileSync(join(d, "a.test.ts"), "let x = 1;\nexport { x };\n");
    const files = new Set((await checkPluginState([d])).map((x) => x.file.replace(d, "")));
    expect([...files].every((f) => f.startsWith("/src/"))).toBe(true);
    expect(files.size).toBeGreaterThan(0);
  });

  it("语法错误 -> parse-error（不能静默放过）", async () => {
    const d = mkdtempSync(join(tmpdir(), "capybara-ps-"));
    tmp.push(d);
    writeFileSync(join(d, "index.ts"), "const = ;;; let\n");
    expect((await checkPluginState([d])).map((x) => x.rule)).toEqual(["parse-error"]);
  });
});

describe("绕过形态", () => {
  it("改名解构、Reflect.get 字符串、简写解构、字符串字面量拼接的计算键都报 plugin-timer", async () => {
    const f = await checkPluginState([fixture("plugin-bypass-state")]);
    expect(f.map((x) => [x.line, x.rule])).toEqual([
      [1, "plugin-timer"],
      [2, "plugin-timer"],
      [3, "plugin-timer"],
      [4, "plugin-timer"],
      [5, "plugin-timer"],
    ]);
  });

  it("名叫 test / dist 的子目录不再被跳过；插件根的 test/ 与 *.test.ts 仍跳过", async () => {
    const fx = bypassFixture();
    tmp.push(fx.dir.replace(/\/plugin-bypass-test-dir$/, ""));
    const f = await checkPluginState([fx.dir]);
    const rel = [...new Set(f.map((x) => x.file.split("plugin-bypass-test-dir/")[1]))].sort();
    expect(rel).toEqual(["src/dist/impl.ts", "src/test/impl.ts"]);
    expect(f.map((x) => x.rule).sort()).toEqual([
      "plugin-module-state",
      "plugin-module-state",
      "plugin-timer",
      "plugin-timer",
    ]);
  });
});
