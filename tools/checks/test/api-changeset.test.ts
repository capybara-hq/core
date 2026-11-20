import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { API_REPORTS, type ApiReport, checkApiChangeset } from "../src/api-changeset.js";

const entryOf = (pkg: string): ApiReport => {
  const entry = API_REPORTS.find((r) => r.pkg === pkg);
  if (entry === undefined) throw new Error(`no API report entry for ${pkg}`);
  return entry;
};
const sdk = entryOf("@capybara-hq/plugin-sdk");
const client = entryOf("@capybara-hq/plugin-client");

const sdkMinor = `---
"@capybara-hq/plugin-sdk": minor
---

Add a hook.
`;
const clientMinor = `---
"@capybara-hq/plugin-client": minor
---

Add a hook.
`;
const kernelOnly = `---
"@capybara-hq/kernel": patch
---

Mentions @capybara-hq/plugin-sdk and @capybara-hq/plugin-client in the body only, which does not
count.
`;

describe("checkApiChangeset", () => {
  it("API report changed, no changeset -> one finding", () => {
    const f = checkApiChangeset(sdk, [sdk.report], new Map());
    expect(f).toHaveLength(1);
    expect(f[0]?.rule).toBe("api-changeset");
    expect(f[0]?.file).toBe(sdk.report);
    expect(f[0]?.message).toContain("pnpm changeset");
  });

  it("API report changed with a changeset for that package -> passes", () => {
    expect(
      checkApiChangeset(
        sdk,
        [sdk.report, ".changeset/sdk.md"],
        new Map([[".changeset/sdk.md", sdkMinor]]),
      ),
    ).toEqual([]);
    expect(
      checkApiChangeset(
        client,
        [client.report, ".changeset/client.md"],
        new Map([[".changeset/client.md", clientMinor]]),
      ),
    ).toEqual([]);
  });

  it("the plugin-client report changed with no changeset -> one finding for plugin-client", () => {
    const f = checkApiChangeset(client, [client.report], new Map());
    expect(f).toHaveLength(1);
    expect(f[0]?.file).toBe(client.report);
    expect(f[0]?.message).toContain('"@capybara-hq/plugin-client"');
  });

  it("a changeset for the other package does not count", () => {
    expect(
      checkApiChangeset(client, [client.report], new Map([[".changeset/sdk.md", sdkMinor]])),
    ).toHaveLength(1);
    expect(
      checkApiChangeset(sdk, [sdk.report], new Map([[".changeset/client.md", clientMinor]])),
    ).toHaveLength(1);
  });

  it("both reports changed with only one changeset -> one finding for the other", () => {
    const changed = [sdk.report, client.report, ".changeset/sdk.md"];
    const f = checkApiChangeset(client, changed, new Map([[".changeset/sdk.md", sdkMinor]]));
    expect(f).toHaveLength(1);
    expect(f[0]?.file).toBe(client.report);
  });

  it("single-quoted and unquoted package keys count", () => {
    for (const key of ["'@capybara-hq/plugin-client'", "@capybara-hq/plugin-client"]) {
      const content = `---\n${key}: patch\n---\n\nFix.\n`;
      expect(
        checkApiChangeset(client, [client.report], new Map([[".changeset/a.md", content]])),
      ).toEqual([]);
    }
  });

  it("API report changed with only a kernel changeset -> one finding", () => {
    const f = checkApiChangeset(
      sdk,
      [sdk.report, ".changeset/kernel.md"],
      new Map([[".changeset/kernel.md", kernelOnly]]),
    );
    expect(f).toHaveLength(1);
  });

  it("API report unchanged -> passes without a changeset", () => {
    expect(checkApiChangeset(sdk, ["packages/kernel/src/kernel.ts"], new Map())).toEqual([]);
  });

  it("the package version raised by hand in the diff (a release, e.g. 0.1.0-rc.0) -> passes", () => {
    const pass = (entry: ApiReport, base: string, head: string) =>
      checkApiChangeset(entry, [entry.report, entry.manifest], new Map(), {
        versions: { base, head },
      });
    for (const entry of [sdk, client]) {
      expect(pass(entry, "0.1.0", "0.1.1")).toEqual([]);
      expect(pass(entry, "0.1.0-rc.0", "0.1.0-rc.1")).toEqual([]);
      expect(pass(entry, "0.1.0-rc.1", "0.1.0")).toEqual([]);
      // Not raised: unchanged, lowered (0.1.0 -> 0.1.0-rc.0 is lower), or not a semver.
      expect(pass(entry, "0.1.0", "0.1.0")).toHaveLength(1);
      expect(pass(entry, "0.1.0", "0.1.0-rc.0")).toHaveLength(1);
      expect(pass(entry, "0.2.0", "0.1.9")).toHaveLength(1);
      expect(pass(entry, "0.1.0", "next")).toHaveLength(1);
      expect(checkApiChangeset(entry, [entry.report, entry.manifest], new Map(), {})).toHaveLength(
        1,
      );
    }
  });

  it("a report change that is only SDK_VERSION following package.json -> passes", () => {
    const report = (v: string, extra = "") =>
      `## API Report\n\nexport const SDK_VERSION = "${v}";\n${extra}\nexport type X = 1;\n`;
    const run = (base: string, head: string, versions: { base: string; head: string }) =>
      checkApiChangeset(sdk, [sdk.report, sdk.manifest], new Map(), {
        reports: { base, head },
        versions,
      });
    // The first release sets 0.1.0-rc.0 by hand over 0.1.0: lower, but nothing else changed.
    const v = { base: "0.1.0", head: "0.1.0-rc.0" };
    expect(run(report("0.1.0"), report("0.1.0-rc.0"), v)).toEqual([]);
    // Anything else in the report still needs a changeset.
    expect(run(report("0.1.0"), report("0.1.0-rc.0", "export type Y = 2;"), v)).toHaveLength(1);
    // The literal must be the package version.
    expect(run(report("0.1.0"), report("0.1.0-rc.9"), v)).toHaveLength(1);
  });

  it("report absent at the base (bootstrap PR) -> skipped", () => {
    expect(checkApiChangeset(sdk, [sdk.report], new Map(), { reportAtBase: false })).toEqual([]);
  });
});

describe("API_REPORTS", () => {
  it("has an entry for every committed api-extractor report", () => {
    // A published package that starts committing a report must be added here, or its report can
    // change without a changeset (the reason plugin-client was missed).
    const root = join(import.meta.dirname, "../../..");
    const found = readdirSync(join(root, "packages"), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => join(root, "packages", d.name, "api"))
      .filter((dir) => existsSync(dir))
      .flatMap((dir) =>
        readdirSync(dir)
          .filter((f) => f.endsWith(".api.md"))
          .map((f) => relative(root, join(dir, f))),
      );
    expect(found.sort()).toEqual(API_REPORTS.map((r) => r.report).sort());
  });

  it("names a real package, manifest and version line", () => {
    // A typo here either crashes the check or makes the rule unsatisfiable: no changeset would
    // ever name the package.
    const root = join(import.meta.dirname, "../../..");
    for (const entry of API_REPORTS) {
      const manifest = JSON.parse(readFileSync(join(root, entry.manifest), "utf8")) as {
        name?: string;
      };
      expect(manifest.name).toBe(entry.pkg);
      const report = readFileSync(join(root, entry.report), "utf8");
      if (entry.versionLine !== undefined) expect(entry.versionLine.test(report)).toBe(true);
    }
  });
});
