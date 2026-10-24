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

  it("report absent at the base (bootstrap PR) -> skipped", () => {
    expect(checkSdkApiChangeset([SDK_API_REPORT], new Map(), { reportAtBase: false })).toEqual([]);
  });
});
