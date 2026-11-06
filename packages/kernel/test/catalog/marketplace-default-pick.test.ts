import { describe, expect, it } from "vitest";
import { pickDefaultEntry } from "../../src/catalog/marketplaces.service.js";

/**
 * The default version of a marketplace import without one (`loadMarketplaceEntry`), the same as
 * the web's market row (`groupMarketplaceEntries` in apps/web/src/lib/catalog.ts; its test checks
 * the same cases): versioned entries that can be imported (stable first), then the entry without a
 * version that is not deprecated, then the newest versioned one that is not deprecated, then the
 * entry without a version, then the newest.
 */
type E = { version: string; usable?: boolean; deprecated?: boolean };
const pick = (entries: E[]) =>
  pickDefaultEntry(entries, {
    usable: (e) => e.usable ?? true,
    deprecated: (e) => e.deprecated ?? false,
  })?.version;

describe("pickDefaultEntry", () => {
  it("prefers an importable stable version, then an importable prerelease", () => {
    expect(pick([{ version: "2.0.0-rc.1" }, { version: "1.1.0" }, { version: "1.0.0" }])).toBe(
      "1.1.0",
    );
    expect(pick([{ version: "1.0.0-rc.1" }, { version: "1.0.0-rc.2" }])).toBe("1.0.0-rc.2");
    expect(pick([{ version: "" }, { version: "1.0.0" }])).toBe("1.0.0");
  });

  it("nothing importable: unversioned not deprecated, newest versioned not deprecated, then the rest", () => {
    const off = { usable: false };
    expect(
      pick([
        { version: "1.0.0", ...off },
        { version: "", ...off },
      ]),
    ).toBe("");
    expect(
      pick([
        { version: "2.0.0", ...off, deprecated: true },
        { version: "1.0.0", ...off },
      ]),
    ).toBe("1.0.0");
    expect(
      pick([
        { version: "2.0.0", ...off, deprecated: true },
        { version: "", ...off, deprecated: true },
      ]),
    ).toBe("");
    expect(
      pick([
        { version: "1.0.0", ...off, deprecated: true },
        { version: "2.0.0", ...off, deprecated: true },
      ]),
    ).toBe("2.0.0");
  });
});
