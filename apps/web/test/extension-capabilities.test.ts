import { describe, expect, it } from "vitest";
import {
  capabilitiesIn,
  capabilitiesOf,
  inTab,
  parseExtensionTab,
  sortExtensions,
  tabCounts,
  tabsOf,
} from "../src/lib/extension-capabilities";
import type { PermissionGroup } from "../src/lib/extensions";

const group = (category: string, items: string[]): PermissionGroup => ({
  category,
  sensitive: false,
  items,
  entries: items.map((value) => ({ value, sensitive: false })),
});
const provides = (...points: string[]) => [group("provides", points)];

describe("extension capabilities and the 扩展 tabs", () => {
  it("maps each point to its tab; Jina's two web points are one tab", () => {
    expect(tabsOf(provides("model-provider@2"))).toEqual(["model"]);
    expect(tabsOf(provides("web-search@1", "web-fetch@1"))).toEqual(["web"]);
    expect(tabsOf(provides("connector@1"))).toEqual(["connector"]);
    expect(tabsOf(provides("sandbox@1"))).toEqual(["sandbox"]);
    expect(tabsOf(provides("object-store@1"))).toEqual(["storage"]);
  });

  it("an extension spanning two tabs sits in both, and shows only that tab's capabilities there", () => {
    const groups = [...provides("model-provider@2", "sandbox@1"), group("tools", ["run"])];
    expect(tabsOf(groups)).toEqual(["model", "sandbox"]);
    expect(capabilitiesIn(groups, "all")).toEqual(["model", "sandbox", "tools"]);
    expect(capabilitiesIn(groups, "sandbox")).toEqual(["sandbox"]);
    // Agent tools of an extension with a tab of its own don't put it in 工具与界面
    expect(capabilitiesIn(groups, "tools")).toEqual([]);
  });

  it("工具与界面 is the catch-all: tools, UI views, channels, an unknown point, nothing at all", () => {
    expect(tabsOf([group("tools", ["echo"]), group("ui", ["board"])])).toEqual(["tools"]);
    expect(capabilitiesIn([group("tools", ["echo"]), group("ui", ["board"])], "tools")).toEqual([
      "tools",
      "ui",
    ]);
    expect(tabsOf(provides("channel@1", "directory@1"))).toEqual(["tools"]);
    expect(capabilitiesOf(provides("future-thing@3"))).toEqual([
      { capability: "point:future-thing", tab: "tools" },
    ]);
    expect(tabsOf([])).toEqual(["tools"]);
  });

  it("counts: 全部 once per extension, each tab once per extension in it", () => {
    const rows = [
      provides("web-search@1", "web-fetch@1"),
      provides("model-provider@2", "sandbox@1"),
      [group("tools", ["echo"])],
    ];
    expect(tabCounts(rows, (r) => r)).toEqual({
      all: 3,
      model: 1,
      web: 1,
      connector: 0,
      sandbox: 1,
      storage: 0,
      tools: 1,
    });
    expect(inTab(rows, "web", (r) => r)).toEqual([rows[0]]);
    expect(inTab(rows, "all", (r) => r)).toHaveLength(3);
  });

  it("sorts by rank, then name; reads ?tab=", () => {
    const rows = [
      { n: "b", r: 1 as const },
      { n: "a", r: 2 as const },
      { n: "c", r: 0 as const },
      { n: "A", r: 1 as const },
    ];
    expect(
      sortExtensions(
        rows,
        (x) => x.r,
        (x) => x.n,
        "en",
      ).map((x) => x.n),
    ).toEqual(["c", "A", "b", "a"]);
    expect(parseExtensionTab("web")).toBe("web");
    expect(parseExtensionTab("nope")).toBe("all");
    expect(parseExtensionTab(undefined)).toBe("all");
  });
});
