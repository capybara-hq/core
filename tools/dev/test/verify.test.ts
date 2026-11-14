import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Plan, Workspace } from "@capybara-hq/ci/affected";
import { afterEach, describe, expect, it, vi } from "vitest";
import { maxWorkersFromEnv } from "../../../vitest.config.ts";
import { printReport } from "../src/report.ts";
import {
  baseChecks,
  changedFiles,
  changesetWarning,
  fastSteps,
  localTestPlan,
  safePlan,
  tryChangedFiles,
  verifySteps,
} from "../src/verify.ts";

const basePlan: Plan = {
  reason: "test",
  all: false,
  testDirs: [],
  test: false,
  shards: 1,
  web: false,
  visual: false,
  e2e: false,
  docker: false,
  bootstrapNetwork: false,
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

  it("plan.all runs pnpm test with --full", () => {
    const all = { ...basePlan, all: true, test: true };
    expect(verifySteps(all, "abc", { full: true }).find((s) => s.id === "test")?.cmd).toEqual([
      "pnpm",
      "test",
    ]);
  });

  it("plan.all without --full runs the local plan's tests and leaves the full suite to CI", () => {
    const all = { ...basePlan, all: true, test: true };
    const local = { ...basePlan, test: true, testDirs: ["tools/ci", "tools/checks"] };
    const test = verifySteps(all, "abc", { local }).find((s) => s.id === "test");
    expect(test?.cmd).toEqual(["pnpm", "exec", "vitest", "run", "tools/ci/", "tools/checks/"]);
    expect(test?.note).toMatch(/CI runs the full suite/);
  });

  it("plan.all without --full and nothing local skips the tests with a note", () => {
    const all = { ...basePlan, all: true, test: true };
    for (const local of [null, basePlan]) {
      const test = verifySteps(all, "abc", { local }).find((s) => s.id === "test");
      expect(test?.cmd).toBeNull();
      expect(test?.note).toMatch(/pnpm verify --full/);
    }
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

  it("runs the network half of check:bootstrap when the plan says so", () => {
    expect(find({ ...basePlan, bootstrapNetwork: true }, "bootstrap-network")?.cmd).toEqual([
      "pnpm",
      "check:bootstrap",
      "--network",
    ]);
    expect(find(basePlan, "bootstrap-network")).toBeUndefined();
  });

  it("web/visual/e2e/docker are reported, not run", () => {
    const plan = { ...basePlan, web: true, visual: true, e2e: true, docker: true };
    for (const id of ["web", "visual", "e2e", "docker"]) {
      expect(find(plan, id)).toMatchObject({ cmd: null, note: "CI runs this" });
    }
    expect(find(basePlan, "web")).toBeUndefined();
  });

  it("--fast runs only lint, typecheck, check and the container-free tests", () => {
    const everything = {
      ...basePlan,
      all: true,
      test: true,
      testDirs: ["packages/kernel"],
      web: true,
      visual: true,
      e2e: true,
      docker: true,
      bootstrapNetwork: true,
    };
    const fast = verifySteps(everything, "abc", { fast: true });
    expect(fast.map((s) => [s.id, s.cmd])).toEqual([
      ["lint", ["pnpm", "lint"]],
      ["typecheck", ["pnpm", "typecheck"]],
      ["check", ["pnpm", "check"]],
      [
        "unit",
        [
          "pnpm",
          "exec",
          "vitest",
          "run",
          "--project",
          "kernel-unit",
          "--project",
          "design",
          "--project",
          "plugin-client",
        ],
      ],
    ]);
    expect(fast.every((s) => s.cmd !== null)).toBe(true);
    // The fast list depends on nothing but the flag: no plan and no base.
    expect(fast).toEqual(fastSteps());

    // The same plan without --fast keeps the full step list.
    expect(verifySteps(everything, "abc", { full: true }).map((s) => s.id)).toEqual([
      "lint",
      "typecheck",
      "check",
      "bootstrap-network",
      "commitlint",
      "test",
      "web",
      "visual",
      "e2e",
      "docker",
    ]);
  });

  it("--fast takes precedence over --full", () => {
    const everything = { ...basePlan, all: true, test: true };
    expect(verifySteps(everything, "abc", { fast: true, full: true })).toEqual(fastSteps());
  });
});

describe("localTestPlan", () => {
  const ws: Workspace = {
    packages: [
      { dir: "packages/kernel", name: "@x/kernel", deps: [], hasTests: true },
      { dir: "tools/ci", name: "@x/ci", deps: [], hasTests: true },
      { dir: "tools/checks", name: "@x/checks", deps: ["@x/kernel"], hasTests: true },
    ],
    testPlugins: {},
  };

  it("drops the run-everything triggers and keeps what the rest of the diff affects", () => {
    const local = localTestPlan(
      [".github/workflows/ci.yml", "tools/ci/README.md", "AGENTS.md", "packages/kernel/src/a.ts"],
      ws,
    );
    expect(local.all).toBe(false);
    expect(local.testDirs).toEqual(["packages/kernel", "tools/checks", "tools/ci"]);
  });

  it("runs the own tests of a package a trigger belongs to", () => {
    const local = localTestPlan(["tools/ci/src/affected.ts", "tools/ci/README.md"], ws);
    expect(local.test).toBe(true);
    expect(local.testDirs).toEqual(["tools/ci"]);
  });

  it("runs nothing when only run-everything triggers and docs changed", () => {
    expect(localTestPlan(["pnpm-lock.yaml", "docs/x.md"], ws).test).toBe(false);
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

describe("baseChecks", () => {
  it("passes through a merge base with no checks", () => {
    expect(baseChecks("origin", true, "abc123")).toEqual({ checks: [], base: "abc123" });
  });

  it("turns a failed fetch into a warning and keeps the base", () => {
    const r = baseChecks("upstream", false, "abc123");
    expect(r.base).toBe("abc123");
    expect(r.checks.map((c) => [c.id, c.status])).toEqual([["fetch", "warn"]]);
  });

  it("turns a missing merge base into a fail check with a fix, and the report is the JSON contract", () => {
    const r = baseChecks("upstream", false, null);
    expect(r.base).toBeNull();
    expect(r.checks.map((c) => [c.id, c.status])).toEqual([
      ["fetch", "warn"],
      ["base", "fail"],
    ]);
    expect(r.checks[1]?.fix).toContain("git fetch --unshallow upstream");

    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(printReport(r.checks, true)).toBe(1);
      const out = JSON.parse(String(log.mock.calls[0]?.[0])) as {
        ok: boolean;
        checks: { id: string; title: string; status: string; detail: string; fix?: string }[];
      };
      expect(out.ok).toBe(false);
      expect(out.checks.find((c) => c.id === "base")).toMatchObject({
        status: "fail",
        title: expect.any(String),
        detail: expect.any(String),
        fix: expect.any(String),
      });
    } finally {
      log.mockRestore();
    }
  });
});

describe("tryChangedFiles / safePlan", () => {
  it("reports a git failure as a base fail check instead of throwing", () => {
    const dir = mkdtempSync(join(tmpdir(), "verify-nogit-"));
    try {
      const r = tryChangedFiles(dir, "deadbeef");
      expect(r.files).toBeNull();
      expect(r.check?.id).toBe("base");
      expect(r.check?.status).toBe("fail");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to running everything when the plan can't be computed", () => {
    const plan = safePlan(() => {
      throw new Error("boom");
    });
    expect(plan.all).toBe(true);
    expect(plan.reason).toBe("could not compute the plan: boom");
  });
});

describe("maxWorkersFromEnv", () => {
  it("accepts only a positive integer and ignores anything else", () => {
    for (const raw of [undefined, "", "abc", "0", "-3", "3.5"]) {
      expect(maxWorkersFromEnv(raw)).toBeUndefined();
    }
    expect(maxWorkersFromEnv("2")).toBe(2);
    expect(maxWorkersFromEnv(" 4 ")).toBe(4);
  });
});

describe("verify-cli --fast --plan-only", () => {
  it("plans the four steps without any git work", () => {
    const root = join(import.meta.dirname, "../../..");
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "cap-verify-plan-")));
    try {
      // A `git` first on PATH that logs every call, hides every remote and fails the commands the
      // plan needs. The fast path must never call them.
      const log = join(dir, "git.log");
      const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
      writeFileSync(
        join(dir, "git"),
        `#!/bin/sh
printf '%s\\n' "$*" >> "$CAP_VERIFY_GIT_LOG"
if [ "$1" = config ] && [ "$2" = --get-regexp ]; then exit 128; fi
case "$1" in fetch|merge-base) exit 128 ;; esac
exec "${realGit}" "$@"
`,
        { mode: 0o755 },
      );
      const r = spawnSync(
        join(root, "node_modules", ".bin", "tsx"),
        ["tools/dev/src/verify-cli.ts", "--fast", "--plan-only", "--json"],
        {
          cwd: root,
          env: {
            ...process.env,
            PATH: `${dir}:${process.env.PATH ?? ""}`,
            CAP_VERIFY_GIT_LOG: log,
          },
          encoding: "utf8",
        },
      );
      expect(r.status).toBe(0);
      const report = JSON.parse(r.stdout) as {
        ok: boolean;
        checks: { id: string; status: string; detail: string }[];
      };
      expect(report.ok).toBe(true);
      expect(report.checks.map((c) => [c.id, c.status])).toEqual([
        ["lint", "planned"],
        ["typecheck", "planned"],
        ["check", "planned"],
        ["unit", "planned"],
      ]);
      expect(report.checks[3]?.detail).toContain("--project kernel-unit");
      // No plan or diff header on stderr, and the shim never saw the plan's git commands.
      expect(r.stderr).not.toMatch(/^(base|changed files|plan|local tests):/m);
      const calls = existsSync(log) ? readFileSync(log, "utf8") : "";
      expect(calls).not.toMatch(/^(config --get-regexp|fetch|merge-base)/m);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
