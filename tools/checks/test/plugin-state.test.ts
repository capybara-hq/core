import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { checkPluginState } from "../src/plugin-state.js";

const fixture = (name: string) => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
const testing = (name: string) =>
  fileURLToPath(new URL(`../../../packages/testing/test/fixtures/${name}`, import.meta.url));

const tmp: string[] = [];
afterEach(() => {
  for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** 复制一个 fixture 到临时目录并去掉豁免标记，用来证明「没有标记就会报」。 */
function unmarked(dir: string): string {
  const out = mkdtempSync(join(tmpdir(), "capybara-ps-"));
  tmp.push(out);
  cpSync(dir, out, { recursive: true });
  for (const name of ["index.ts", "store.ts"]) {
    try {
      const p = join(out, name);
      writeFileSync(
        p,
        readFileSync(p, "utf8").replace(/\s*\/\/ capybara:allow-module-state.*$/gm, ""),
      );
    } catch {}
  }
  return out;
}

describe("plugin-module-state", () => {
  const all = checkPluginState([fixture("plugin-module-state")]);
  const idx = all.filter((x) => x.file.endsWith("index.ts"));

  it("let / var / export let / Map / Set / WeakMap / WeakSet / 数组（含 as 与括号包裹）都报，恰好行尾标 FLAG 的那些", () => {
    const flagged = readFileSync(fixture("plugin-module-state/src/index.ts"), "utf8")
      .split("\n")
      .flatMap((l, i) => (l.includes("// FLAG") ? [i + 1] : []));
    expect(flagged.length).toBe(11);
    expect(idx.map((x) => x.line)).toEqual(flagged);
    expect(idx.every((x) => x.rule === "plugin-module-state")).toBe(true);
  });

  it("报错信息给出改法", () => {
    expect(idx[0]?.message).toContain("ctx.kv");
    expect(idx[0]?.message).toContain("ctx.queue");
    expect(idx[0]?.message).toContain("ctx.bus");
  });

  it("豁免：同行、紧邻上一行带原因 -> 不报；空原因、块注释、隔行、上一语句行尾 -> 仍报", () => {
    const m = all.filter((x) => x.file.endsWith("marked.ts"));
    expect(m.map((x) => x.line)).toEqual([6, 7, 10, 12]);
    expect(m.find((x) => x.line === 6)?.message).toContain("原因");
  });
});

describe("plugin-timer", () => {
  const all = checkPluginState([fixture("plugin-timer")]);
  it("setTimeout / setInterval / setImmediate / globalThis.x / globalThis['x'] / 别名 / timers 导入都报", () => {
    expect(all.every((x) => x.rule === "plugin-timer")).toBe(true);
    const idx = all.filter((x) => x.file.endsWith("index.ts")).map((x) => x.line);
    expect(idx).toEqual([2, 3, 6, 7, 8, 9, 10, 11, 13]);
    expect(idx).not.toContain(12);
  });
  it("require / 动态 import node:timers 也报", () => {
    const r = all.filter((x) => x.file.endsWith("require.ts")).map((x) => x.line);
    expect(r).toEqual([1, 2]);
  });
  it("报错信息给出改法", () => {
    expect(all[0]?.message).toContain("ctx.queue");
  });
});

describe("真实正例与反例", () => {
  it("good-counter / whoami / 干净插件 -> 0 条", () => {
    expect(checkPluginState([testing("good-counter"), testing("whoami")])).toEqual([]);
    expect(checkPluginState([fixture("plugin-clean")])).toEqual([]);
  });

  it("leaky-counter / leaky-sibling 带豁免标记 -> 0 条（标记是有意的豁免）", () => {
    expect(checkPluginState([testing("leaky-counter"), testing("leaky-sibling")])).toEqual([]);
  });

  it("去掉标记后 leaky-counter 与 leaky-sibling（兄弟 store.ts）各报 plugin-module-state", () => {
    const a = checkPluginState([unmarked(testing("leaky-counter"))]);
    expect(a.map((x) => x.rule)).toEqual(["plugin-module-state"]);
    const b = checkPluginState([unmarked(testing("leaky-sibling"))]);
    expect(b.map((x) => x.rule)).toEqual(["plugin-module-state"]);
    expect(b[0]?.file).toContain("store.ts");
  });

  it("test 目录、*.test.ts、node_modules、dist 不扫描", () => {
    const d = mkdtempSync(join(tmpdir(), "capybara-ps-"));
    tmp.push(d);
    for (const p of ["test", "node_modules/x", "dist", "src"]) {
      cpSync(fixture("plugin-module-state/src"), join(d, p), { recursive: true });
    }
    writeFileSync(join(d, "a.test.ts"), "let x = 1;\nexport { x };\n");
    const files = new Set(checkPluginState([d]).map((x) => x.file.replace(d, "")));
    expect([...files].every((f) => f.startsWith("/src/"))).toBe(true);
    expect(files.size).toBeGreaterThan(0);
  });

  it("语法错误 -> parse-error（不能静默放过）", () => {
    const d = mkdtempSync(join(tmpdir(), "capybara-ps-"));
    tmp.push(d);
    writeFileSync(join(d, "index.ts"), "const = ;;; let\n");
    expect(checkPluginState([d]).map((x) => x.rule)).toEqual(["parse-error"]);
  });
});
