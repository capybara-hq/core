import { relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  changedTestFiles,
  checkTestPortfolio,
  listCandidates,
  readBaseline,
} from "../src/test-portfolio.js";

const fixture = (name: string) =>
  fileURLToPath(new URL(`../fixtures/test-portfolio/${name}`, import.meta.url));
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const badFile = "packages/kernel/test/portfolio/waits.test.ts";

describe("checkTestPortfolio", () => {
  it("passes a clean test file", () => {
    expect(checkTestPortfolio({ root: fixture("clean") })).toEqual([]);
  });

  it("flags a small file that boots through a helper, not one importing helpers/runs for waitFor", () => {
    const root = fixture("boots");
    const got = checkTestPortfolio({ root });
    expect(got.map((f) => [f.rule, relative(root, f.file).split(sep).join("/")])).toEqual([
      ["test-small-app-file", "packages/kernel/test/catalog/env.test.ts"],
      ["test-small-app-file", "packages/kernel/test/catalog/http.test.ts"],
      ["test-small-app-file", "packages/kernel/test/catalog/transitive.test.ts"],
    ]);
    expect(got.some((f) => f.file.endsWith("waits-only.test.ts"))).toBe(false);
  });

  it("reports fixed waits, timeout overrides, a small app file and a double boot in order", () => {
    expect(checkTestPortfolio({ root: fixture("bad") })).toEqual([
      expect.objectContaining({ rule: "test-fixed-sleep" }),
      expect.objectContaining({ rule: "test-fixed-settimeout" }),
      expect.objectContaining({ rule: "test-timeout-override" }),
      expect.objectContaining({ rule: "test-timeout-override" }),
      expect.objectContaining({ rule: "test-small-app-file" }),
      expect.objectContaining({ rule: "test-double-boot" }),
    ]);
  });

  it("skips a file listed in the grandfather list", () => {
    expect(
      checkTestPortfolio({
        root: fixture("bad"),
        baseline: [{ path: badFile, reason: "timeout override: removed by the T1 batch" }],
      }),
    ).toEqual([]);
  });

  it("reports a grandfather entry without a reason and one that no longer violates", () => {
    const root = fixture("baseline");
    const got = checkTestPortfolio({ root });
    expect(got.map((f) => f.rule)).toEqual([
      "test-fixed-sleep",
      "test-portfolio-baseline-stale",
      "test-portfolio-baseline-unjustified",
    ]);
    expect(got[1]?.file).toBe(`${root}/tools/checks/test-portfolio-baseline.json`);
    expect(got[1]?.message).toContain("clean.test.ts");
    expect(got[2]?.message).toContain("unjustified.test.ts");
  });

  it("scans only the changed files in diff mode", () => {
    const root = fixture("bad");
    expect(checkTestPortfolio({ root, changed: new Set([badFile]) })).toHaveLength(6);
    expect(checkTestPortfolio({ root, changed: new Set() })).toEqual([]);
    expect(
      checkTestPortfolio({ root, changed: new Set(["packages/kernel/test/other.test.ts"]) }),
    ).toEqual([]);
  });

  it("reports the second occurrence of a path listed twice", () => {
    const root = fixture("overlap");
    const got = checkTestPortfolio({ root });
    expect(got.map((f) => f.rule)).toEqual(["test-portfolio-list-overlap"]);
    expect(got[0]?.file).toBe(`${root}/packages/kernel/test/container-tests.json`);
    expect(got[0]?.line).toBe(1);
    expect(got[0]?.message).toContain("packages/kernel/test/unit-tests.json:1");
  });

  it("reports a listed path with no file on the list", () => {
    const root = fixture("missing");
    const got = checkTestPortfolio({ root });
    expect(got.map((f) => [f.rule, f.file, f.line])).toEqual([
      ["test-portfolio-missing-file", `${root}/packages/kernel/test/unit-tests.json`, 1],
    ]);
    expect(got[0]?.message).toContain("gone.test.ts");
  });

  it("treats a base that does not resolve as skipped and a resolvable one as an empty diff", () => {
    expect(changedTestFiles(repoRoot, "no-such-ref-for-the-portfolio-check")).toBeUndefined();
    expect(changedTestFiles(repoRoot, "HEAD")).toEqual(new Set());
  });

  it("lists the candidates of an area with the small app files first", () => {
    expect(listCandidates(fixture("bad"), "portfolio")).toEqual([
      `${badFile}\ttest-small-app-file`,
      `${badFile}\ttest-fixed-sleep`,
      `${badFile}\ttest-fixed-settimeout`,
      `${badFile}\ttest-timeout-override`,
      `${badFile}\ttest-timeout-override`,
      `${badFile}\ttest-double-boot`,
    ]);
  });

  it("passes the real tree, and every grandfather entry is justified and still violates", () => {
    expect(checkTestPortfolio({ root: repoRoot })).toEqual([]);
    const entries = readBaseline(repoRoot);
    expect(entries.length).toBeGreaterThan(0);
    // With the grandfather list empty the tree still has violations: the list is not vacuous.
    expect(checkTestPortfolio({ root: repoRoot, baseline: [] }).length).toBeGreaterThan(0);
  });
});
