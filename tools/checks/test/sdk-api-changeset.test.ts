import { describe, expect, it } from "vitest";
import { checkSdkApiChangeset, SDK_API_REPORT } from "../src/sdk-api-changeset.js";

const sdkMinor = `---
"@capybara-hq/plugin-sdk": minor
---

Add a hook.
`;
const kernelOnly = `---
"@capybara-hq/kernel": patch
---

Mentions @capybara-hq/plugin-sdk in the body only, which does not count.
`;

describe("checkSdkApiChangeset", () => {
  it("API report changed, no changeset -> one finding", () => {
    const f = checkSdkApiChangeset([SDK_API_REPORT], new Map());
    expect(f).toHaveLength(1);
    expect(f[0]?.rule).toBe("sdk-api-changeset");
    expect(f[0]?.file).toBe(SDK_API_REPORT);
    expect(f[0]?.message).toContain("pnpm changeset");
  });

  it("API report changed with an SDK changeset -> passes", () => {
    const f = checkSdkApiChangeset(
      [SDK_API_REPORT, ".changeset/sdk.md"],
      new Map([[".changeset/sdk.md", sdkMinor]]),
    );
    expect(f).toEqual([]);
  });

  it("single-quoted and unquoted package keys count", () => {
    for (const key of ["'@capybara-hq/plugin-sdk'", "@capybara-hq/plugin-sdk"]) {
      const content = `---\n${key}: patch\n---\n\nFix.\n`;
      expect(
        checkSdkApiChangeset([SDK_API_REPORT], new Map([[".changeset/a.md", content]])),
      ).toEqual([]);
    }
  });

  it("API report changed with only a kernel changeset -> one finding", () => {
    const f = checkSdkApiChangeset(
      [SDK_API_REPORT, ".changeset/kernel.md"],
      new Map([[".changeset/kernel.md", kernelOnly]]),
    );
    expect(f).toHaveLength(1);
  });

  it("API report unchanged -> passes without a changeset", () => {
    expect(checkSdkApiChangeset(["packages/kernel/src/kernel.ts"], new Map())).toEqual([]);
  });

  it("the SDK version raised by hand in the diff (a release, e.g. 0.1.0-rc.0) -> passes", () => {
    const changed = [SDK_API_REPORT, "packages/plugin-sdk/package.json"];
    const pass = (base: string, head: string) =>
      checkSdkApiChangeset(changed, new Map(), { sdkVersions: { base, head } });
    expect(pass("0.1.0", "0.1.1")).toEqual([]);
    expect(pass("0.1.0-rc.0", "0.1.0-rc.1")).toEqual([]);
    expect(pass("0.1.0-rc.1", "0.1.0")).toEqual([]);
    // Not raised: unchanged, lowered (0.1.0 -> 0.1.0-rc.0 is lower), or not a semver.
    expect(pass("0.1.0", "0.1.0")).toHaveLength(1);
    expect(pass("0.1.0", "0.1.0-rc.0")).toHaveLength(1);
    expect(pass("0.2.0", "0.1.9")).toHaveLength(1);
    expect(pass("0.1.0", "next")).toHaveLength(1);
    expect(checkSdkApiChangeset(changed, new Map(), {})).toHaveLength(1);
  });

  it("a report change that is only SDK_VERSION following package.json -> passes", () => {
    const changed = [SDK_API_REPORT, "packages/plugin-sdk/package.json"];
    const report = (v: string, extra = "") =>
      `## API Report\n\nexport const SDK_VERSION = "${v}";\n${extra}\nexport type X = 1;\n`;
    const run = (base: string, head: string, sdkVersions: { base: string; head: string }) =>
      checkSdkApiChangeset(changed, new Map(), { reports: { base, head }, sdkVersions });
    // The first release sets 0.1.0-rc.0 by hand over 0.1.0: lower, but nothing else changed.
    const v = { base: "0.1.0", head: "0.1.0-rc.0" };
    expect(run(report("0.1.0"), report("0.1.0-rc.0"), v)).toEqual([]);
    // Anything else in the report still needs a changeset.
    expect(run(report("0.1.0"), report("0.1.0-rc.0", "export type Y = 2;"), v)).toHaveLength(1);
    // The literal must be the package version.
    expect(run(report("0.1.0"), report("0.1.0-rc.9"), v)).toHaveLength(1);
  });

  it("report absent at the base (bootstrap PR) -> skipped", () => {
    expect(checkSdkApiChangeset([SDK_API_REPORT], new Map(), { reportAtBase: false })).toEqual([]);
  });
});
