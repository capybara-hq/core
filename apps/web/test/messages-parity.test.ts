import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** 把嵌套文案展平为叶子 key 的点路径（有序）；非对象值都算叶子。 */
function flattenKeys(value: unknown, prefix = ""): string[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return prefix === "" ? [] : [prefix];
  }
  return Object.entries(value as Record<string, unknown>)
    .flatMap(([k, v]) => flattenKeys(v, prefix === "" ? k : `${prefix}.${k}`))
    .sort();
}

/** 两份文案的 key 差异：只在 a 里有的、只在 b 里有的。 */
function keyDiff(a: unknown, b: unknown): { onlyInA: string[]; onlyInB: string[] } {
  const ka = new Set(flattenKeys(a));
  const kb = new Set(flattenKeys(b));
  return {
    onlyInA: [...ka].filter((k) => !kb.has(k)),
    onlyInB: [...kb].filter((k) => !ka.has(k)),
  };
}

const load = (locale: string): unknown =>
  JSON.parse(readFileSync(new URL(`../messages/${locale}.json`, import.meta.url), "utf8"));

describe("界面文案 zh / en key 一致", () => {
  it("比较方法能发现缺失的 key（嵌套对象按点路径比较）", () => {
    const zh = { a: { b: "一", c: "二" }, d: "三" };
    const en = { a: { b: "one" }, d: "three", e: "extra" };
    expect(keyDiff(zh, en)).toEqual({ onlyInA: ["a.c"], onlyInB: ["e"] });
    expect(keyDiff(zh, zh)).toEqual({ onlyInA: [], onlyInB: [] });
  });

  it("apps/web/messages 的 zh.json 与 en.json key 集合完全相同", () => {
    const diff = keyDiff(load("zh"), load("en"));
    expect(diff, "keys only in zh.json (onlyInA) / only in en.json (onlyInB)").toEqual({
      onlyInA: [],
      onlyInB: [],
    });
  });
});
