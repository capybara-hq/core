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
    expect(checkTestPortfolio({ root: fixture("bad"), baseline: [badFile] })).toEqual([]);
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

  it("passes the real tree, and the grandfather list is exactly the violations", () => {
    expect(checkTestPortfolio({ root: repoRoot })).toEqual([]);
    const baseline = new Set(readBaseline(repoRoot));
    const violations = new Set(
      checkTestPortfolio({ root: repoRoot, baseline: [] }).map((f) =>
        relative(repoRoot, f.file).split(sep).join("/"),
      ),
    );
    expect(violations.size).toBeGreaterThan(0);
    expect([...baseline].sort()).toEqual([...violations].sort());
  });
});
