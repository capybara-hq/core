import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Plan, Workspace } from "@capybara-hq/ci/affected";
import { afterEach, describe, expect, it } from "vitest";
import { changedFiles, changesetWarning, verifySteps } from "../src/verify.ts";

const basePlan: Plan = {
  reason: "test",
  all: false,
  testDirs: [],
  test: false,
  shards: 1,
  web: false,
  visual: false,
  e2e: false,
};
const find = (plan: Plan, id: string) => verifySteps(plan, "abc").find((s) => s.id === id);

describe("verifySteps", () => {
  it("for a docs-only plan has no test command", () => {
    const test = find(basePlan, "test");
    expect(test?.cmd).toBeNull();
    expect(test?.note).toBe("no affected tests");
    expect(find(basePlan, "commitlint")?.cmd).toEqual([
      "pnpm",
      "exec",
      "commitlint",
      "--from",
      "abc",
      "--to",
      "HEAD",
    ]);
  });

  it("plan.all runs pnpm test", () => {
    expect(find({ ...basePlan, all: true, test: true }, "test")?.cmd).toEqual(["pnpm", "test"]);
  });

  it("testDirs become vitest filters", () => {
    const plan = { ...basePlan, test: true, testDirs: ["packages/kernel", "tools/dev"] };
    expect(find(plan, "test")?.cmd).toEqual([
      "pnpm",
      "exec",
      "vitest",
      "run",
      "packages/kernel/",
      "tools/dev/",
    ]);
  });

  it("web/visual/e2e are reported, not run", () => {
    const plan = { ...basePlan, web: true, visual: true, e2e: true };
    for (const id of ["web", "visual", "e2e"]) {
      expect(find(plan, id)).toMatchObject({ cmd: null, note: "CI runs this" });
    }
    expect(find(basePlan, "web")).toBeUndefined();
  });
});

describe("changesetWarning", () => {
  const root = join(import.meta.dirname, "../../..");
  const ws: Workspace = {
    packages: [
      { dir: "packages/kernel", name: "@capybara-hq/kernel", deps: [], hasTests: true },
      { dir: "tools/dev", name: "@capybara-hq/dev", deps: [], hasTests: true },
    ],
    testPlugins: {},
  };

  it("warns for packages/kernel without a changeset", () => {
    const w = changesetWarning(["packages/kernel/src/a.ts"], ws, root);
    expect(w?.status).toBe("warn");
    expect(w?.detail).toContain("@capybara-hq/kernel");
  });

  it("is null when a changeset is in the diff", () => {
    expect(changesetWarning(["packages/kernel/src/a.ts", ".changeset/x.md"], ws, root)).toBeNull();
  });

  it("is null for tools/dev (private)", () => {
    expect(changesetWarning(["tools/dev/src/a.ts"], ws, root)).toBeNull();
  });
});

describe("changedFiles", () => {
  let dir = "";
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      [
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@example.com",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ],
      { cwd: dir, encoding: "utf8" },
    ).trim();

  it("includes an untracked file", () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "cap-verify-")));
    git("init", "-q", "-b", "main");
    writeFileSync(join(dir, "a.txt"), "a\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");
    const base = git("rev-parse", "HEAD");
    writeFileSync(join(dir, "b.txt"), "b\n");
    git("add", "b.txt");
    git("commit", "-q", "-m", "b");
    writeFileSync(join(dir, "a.txt"), "changed\n");
    writeFileSync(join(dir, "new.txt"), "n\n");
    expect(changedFiles(dir, base)).toEqual(["a.txt", "b.txt", "new.txt"]);
  });
});
