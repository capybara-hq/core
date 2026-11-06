import { describe, expect, it } from "vitest";
import { groupMarketplaceEntries, type MarketplaceEntry } from "../src/lib/catalog";

const entry = (version: string | null, over: Partial<MarketplaceEntry> = {}): MarketplaceEntry => ({
  sourceId: "official",
  sourceName: "Official",
  name: "cat-a",
  version,
  summary: { en: "Cat A" },
  displayName: null,
  minKernel: null,
  homepage: null,
  permissions: null,
  source: { path: "./plugins/cat-a" },
  deprecated: null,
  compatible: true,
  importable: true,
  adopted: null,
  newerAvailable: false,
  contentChanged: false,
  ...over,
});
const versions = (entries: MarketplaceEntry[]) =>
  groupMarketplaceEntries(entries).map((g) => [g.latest.version, g.others.map((o) => o.version)]);

describe("groupMarketplaceEntries", () => {
  it("the newest stable version is the row's; newer prereleases fold into the other versions", () => {
    expect(
      versions([entry("1.0.0"), entry("2.0.0-rc.1"), entry("1.1.0"), entry("2.0.0-rc.0")]),
    ).toEqual([["1.1.0", ["2.0.0-rc.1", "2.0.0-rc.0", "1.0.0"]]]);
  });

  it("only prereleases: the newest prerelease is the row's", () => {
    expect(versions([entry("1.0.0-rc.2"), entry("1.0.0-rc.10")])).toEqual([
      ["1.0.0-rc.10", ["1.0.0-rc.2"]],
    ]);
  });

  it("a deprecated version is never the row's while another can be imported", () => {
    const gone = { deprecated: { reason: "broken" } };
    expect(versions([entry("2.0.0", gone), entry("1.0.0")])).toEqual([["1.0.0", ["2.0.0"]]]);
    // a deprecated stable version: a prerelease that is not deprecated comes first
    expect(versions([entry("1.0.0", gone), entry("1.1.0-rc.0")])).toEqual([
      ["1.1.0-rc.0", ["1.0.0"]],
    ]);
    // all deprecated: the newest, shown as deprecated
    expect(
      versions([entry("1.0.0", gone), entry("2.0.0", { deprecated: { reason: null } })]),
    ).toEqual([["2.0.0", ["1.0.0"]]]);
  });

  it("an incompatible stable version gives way to an importable one", () => {
    expect(versions([entry("2.0.0", { compatible: false }), entry("1.0.0")])).toEqual([
      ["1.0.0", ["2.0.0"]],
    ]);
  });
  it("the same default as the kernel's import (loadMarketplaceEntry) when nothing can be imported", () => {
    const off = { compatible: false };
    // a versioned entry that can be imported comes before one without a version
    expect(versions([entry(null), entry("1.0.0")])).toEqual([["1.0.0", [null]]]);
    // none can be: the entry without a version that is not deprecated
    expect(versions([entry("1.0.0", off), entry(null, off)])).toEqual([[null, ["1.0.0"]]]);
    // then the newest versioned one that is not deprecated
    expect(
      versions([entry("2.0.0", { ...off, deprecated: { reason: null } }), entry("1.0.0", off)]),
    ).toEqual([["1.0.0", ["2.0.0"]]]);
  });
});
