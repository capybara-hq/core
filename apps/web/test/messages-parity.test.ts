import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { CatalogItemVersion } from "../src/lib/catalog";
import { PLATFORM_COMPONENT_KINDS } from "../src/lib/components";

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

describe("the owner's name (maintainer decision V, 2026-11-07)", () => {
  // An agent's owner is its 所有者 (the creator, "owner" in en): the zh copy never calls it 负责人.
  it("zh.json says 所有者, never 负责人, and agents you own are 你拥有的", () => {
    const zh = readFileSync(new URL("../messages/zh.json", import.meta.url), "utf8");
    expect(zh).not.toContain("负责人");
    expect(zh).not.toContain("你负责的");
  });

  it("the sample data of the catalog and the design fixtures says 所有者 too", () => {
    const files = [
      "../src/dev/catalog/fixtures.tsx",
      "../src/dev/catalog/stress.tsx",
      "../src/dev/catalog/templates/list.tsx",
      "../../../packages/design/src/fixtures/index.ts",
    ];
    for (const f of files) {
      const text = readFileSync(new URL(f, import.meta.url), "utf8");
      // string literals only: comments may keep the old word (no bulk translation)
      expect(text, f).not.toMatch(/"[^"\n]*负责人[^"\n]*"/);
    }
  });
});

describe("eval drift labels (final review m5)", () => {
  // The kernel's `DriftReason` values (packages/kernel/src/evals/reconstruct.ts DRIFT_ORDER, plus
  // the worker's); keep in step when a reason is added
  const REASONS = [
    "system_hash",
    "tools_changed",
    "tool_spec_missing",
    "definition_missing",
    "pinned_changed",
    "subagent_changed",
    "legacy_event",
    "params_changed",
    "model_switched",
    "media_missing",
    "media_changed",
    "context_fit",
    "tool_unmatched",
  ];
  it.each(["zh", "en"])("%s labels every drift reason", (locale) => {
    const drift = (load(locale) as { evals: { drift: Record<string, string> } }).evals.drift;
    expect(REASONS.filter((r) => typeof drift[r] !== "string")).toEqual([]);
  });
});

describe("plugin version sources (kernel CatalogVersionSource)", () => {
  // `bootstrap` was missing: the admin plugin detail's 版本 tab threw MISSING_MESSAGE for a
  // preinstalled plugin (acceptance 2026-11-07)
  const SOURCES: CatalogItemVersion["source"][] = [
    "file",
    "npm",
    "marketplace",
    "git",
    "bootstrap",
  ];
  it.each(["zh", "en"])("%s labels every version source", (locale) => {
    const labels = (load(locale) as { catalog: { versionSource: Record<string, string> } }).catalog
      .versionSource;
    expect(SOURCES.filter((s) => typeof labels[s] !== "string")).toEqual([]);
  });
});

describe("every platform component kind has its labels", () => {
  // A kind added to PLATFORM_COMPONENT_KINDS (e.g. theme) must be labelled wherever a kind is
  // drawn from a template key, or the page throws MISSING_MESSAGE (acceptance 2026-11-10).
  const paths = ["catalog.update.kind", "orgComponents.kind"];
  for (const locale of ["zh", "en"]) {
    it(locale, () => {
      const messages = load(locale) as Record<string, unknown>;
      for (const path of paths) {
        const node = path
          .split(".")
          .reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], messages);
        for (const kind of PLATFORM_COMPONENT_KINDS) {
          expect(
            (node as Record<string, unknown> | undefined)?.[kind],
            `${locale} ${path}.${kind}`,
          ).toEqual(expect.any(String));
        }
      }
    });
  }
});
