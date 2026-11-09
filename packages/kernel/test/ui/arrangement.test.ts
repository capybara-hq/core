import { describe, expect, it } from "vitest";
import {
  arrange,
  effectiveEntry,
  type UiArrangement,
  type UiListEntry,
} from "../../src/ui/arrangement.js";
import type { UiContributionItem } from "../../src/ui/views.js";

const item = (plugin: string, id: string, after?: string): UiContributionItem => ({
  plugin,
  id,
  title: { zh: id, en: id },
  slot: "conversation.properties.section",
  ...(after !== undefined && { after }),
  kind: "view",
  icon: "puzzle",
});
const keys = (items: UiContributionItem[]) => items.map((i) => `${i.plugin}/${i.id}`);
const entry = (e: Partial<UiListEntry>): UiListEntry => ({
  hidden: [],
  order: [],
  ...e,
});

describe("arrange", () => {
  const items = [
    item("aa", "one", "context"),
    item("aa", "two", "context"),
    item("bb", "three", "context"),
  ];

  it("order puts listed keys first within their anchor", () => {
    expect(keys(arrange(items, entry({ order: ["bb/three", "aa/two"] })))).toEqual([
      "bb/three",
      "aa/two",
      "aa/one",
    ]);
  });

  it("hidden keys are removed", () => {
    expect(keys(arrange(items, entry({ hidden: ["aa/two"] })))).toEqual(["aa/one", "bb/three"]);
  });

  it("unknown keys are ignored", () => {
    expect(
      keys(arrange(items, entry({ hidden: ["zz/gone"], order: ["zz/gone", "bb/three"] }))),
    ).toEqual(["bb/three", "aa/one", "aa/two"]);
  });

  it("order cannot move a section across anchors", () => {
    const mixed = [
      item("aa", "one", "context"),
      item("aa", "two", "files"),
      item("bb", "three", "context"),
    ];
    // listing the files section first still leaves it after the context group
    expect(keys(arrange(mixed, entry({ order: ["aa/two", "bb/three"] })))).toEqual([
      "bb/three",
      "aa/one",
      "aa/two",
    ]);
  });
});

describe("base order (no arrangement entry)", () => {
  const none = entry({});

  it("is still grouped by anchor in the slot's anchor order", () => {
    // base order (extension name, then manifest order) puts `aa`'s files section first
    const base = [
      item("aa", "files-one", "files"),
      item("bb", "ctx-one", "context"),
      item("bb", "bg-one", "background"),
      item("cc", "ctx-two"),
    ];
    expect(keys(arrange(base, none))).toEqual([
      "bb/ctx-one",
      "cc/ctx-two",
      "aa/files-one",
      "bb/bg-one",
    ]);
  });

  it("keeps base order within an anchor and in a slot without anchors", () => {
    expect(keys(arrange([item("aa", "one", "files"), item("bb", "two", "files")], none))).toEqual([
      "aa/one",
      "bb/two",
    ]);
    const pages = [
      { ...item("bb", "x"), slot: "org.page" as const },
      { ...item("aa", "y"), slot: "org.page" as const },
    ];
    expect(keys(arrange(pages, none))).toEqual(["bb/x", "aa/y"]);
  });
});

describe("effectiveEntry", () => {
  const platform: UiArrangement = {
    "org.page": { hidden: ["aa/x"], order: [] },
    "agent.detail.section": { hidden: [], order: ["aa/y"] },
  };
  const org: UiArrangement = { "org.page": { hidden: [], order: ["aa/z"] } };

  it("an org entry replaces the platform entry for that slot only", () => {
    expect(effectiveEntry(org, platform, "org.page")).toEqual({
      entry: { hidden: [], order: ["aa/z"] },
      source: "org",
    });
  });

  it("a slot the org never arranged follows the platform", () => {
    expect(effectiveEntry(org, platform, "agent.detail.section").source).toBe("platform");
    expect(effectiveEntry(undefined, platform, "org.page").source).toBe("platform");
    expect(effectiveEntry(org, platform, "conversation.panel")).toEqual({
      entry: { hidden: [], order: [] },
      source: "none",
    });
  });
});
