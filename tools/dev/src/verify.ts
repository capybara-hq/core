import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Plan, planAll, planFromFiles, type Workspace } from "@capybara-hq/ci/affected";
import type { Check } from "./report.ts";

export type VerifyStep = { id: string; title: string; cmd: string[] | null; note?: string };

function git(cwd: string, args: string[]): string[] {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.split("\n").filter((l) => l !== "");
}

/**
 * Repo-relative files changed since `base`: the committed diff `base...HEAD` plus staged, unstaged
 * and untracked files (the working tree as it is). Deletions are included, as in CI.
 */
export function changedFiles(cwd: string, base: string): string[] {
  const out = new Set<string>();
  for (const args of [
    ["diff", "--name-only", `${base}...HEAD`],
    ["diff", "--name-only", "--cached"],
    ["diff", "--name-only"],
    ["ls-files", "--others", "--exclude-standard"],
  ]) {
    for (const f of git(cwd, args)) out.add(f);
  }
  return [...out].sort();
}

/**
 * The tests worth running locally when CI's plan runs everything: the plan of the diff without its
 * run-everything triggers (the packages the change touches and what depends on them), plus the own
 * tests of a package a trigger belongs to (`tools/ci`, `packages/testing`). CI runs the full suite
 * anyway, and locally it takes several times as long (`pnpm verify --full` still runs it here).
 */
export function localTestPlan(files: string[], ws: Workspace): Plan {
  const triggers = files.filter((f) => planFromFiles([f], ws).all);
  const plan = planFromFiles(
    files.filter((f) => !triggers.includes(f)),
    ws,
  );
  const owners = new Set<string>();
  for (const f of triggers) {
    const owner = ws.packages
      .filter((p) => p.hasTests && f.startsWith(`${p.dir}/`))
      .sort((a, b) => b.dir.length - a.dir.length)[0];
    if (owner !== undefined) owners.add(owner.dir);
  }
  if (owners.size === 0) return plan;
  const testDirs = [...new Set([...plan.testDirs, ...owners])].sort();
  return {
    ...plan,
    test: true,
    testDirs,
    reason: `${plan.reason}; trigger packages: ${[...owners].sort().join(", ")}`,
  };
}

export type VerifyOptions = {
  /** Run only the fast checks (`--fast`): no upstream/plan work, no containers ({@link fastSteps}). */
  fast?: boolean;
  /** Run the full suite when the plan runs everything (`--full`). */
  full?: boolean;
  /** For a run-everything plan without `full`: the tests to run instead ({@link localTestPlan}). */
  local?: Plan | null;
};

/** The steps every verify run shares, in run order. */
function checkSteps(): VerifyStep[] {
  return [
    { id: "lint", title: "Lint", cmd: ["pnpm", "lint"] },
    { id: "typecheck", title: "Typecheck", cmd: ["pnpm", "typecheck"] },
    { id: "check", title: "Custom checks", cmd: ["pnpm", "check"] },
  ];
}

/**
 * The fast, advisory steps (`--fast`): no containers, no database, and no upstream/fetch/
 * merge-base/plan work (the steps themselves may still use git: `pnpm check` lists tracked files).
 * The kernel unit project plus the two no-container jsdom projects, so a UI change in design or
 * plugin-client is covered too.
 */
export function fastSteps(): VerifyStep[] {
  return [
    ...checkSteps(),
    {
      id: "unit",
      title: "Unit tests",
      cmd: [
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
    },
  ];
}

/** The local equivalent of CI's required jobs for this plan, in run order. */
export function verifySteps(plan: Plan, base: string, opts: VerifyOptions = {}): VerifyStep[] {
  // A fast check is an advisory signal and ignores the plan: no containers, no database, no git
  // state of its own.
  if (opts.fast) return fastSteps();
  const steps: VerifyStep[] = checkSteps();
  // CI runs it in the ci job when bootstrap.json changed (or on a full run); it needs the network
  if (plan.bootstrapNetwork)
    steps.push({
      id: "bootstrap-network",
      title: "Bootstrap manifest against npm and the marketplace",
      cmd: ["pnpm", "check:bootstrap", "--network"],
    });
  steps.push({
    id: "commitlint",
    title: "Commit messages",
    cmd: ["pnpm", "exec", "commitlint", "--from", base, "--to", "HEAD"],
  });
  const vitest = (dirs: string[]) => ["pnpm", "exec", "vitest", "run", ...dirs.map((d) => `${d}/`)];
  const fullNote = "CI runs the full suite; pnpm verify --full runs it here";
  if (plan.all && opts.full) steps.push({ id: "test", title: "Tests", cmd: ["pnpm", "test"] });
  else if (plan.all) {
    const local = opts.local;
    if (local?.test && local.testDirs.length > 0)
      steps.push({
        id: "test",
        title: "Tests (affected packages)",
        cmd: vitest(local.testDirs),
        note: fullNote,
      });
    else steps.push({ id: "test", title: "Tests", cmd: null, note: fullNote });
  } else if (plan.test) {
    steps.push({ id: "test", title: "Tests", cmd: vitest(plan.testDirs) });
  } else steps.push({ id: "test", title: "Tests", cmd: null, note: "no affected tests" });
  for (const id of ["web", "visual", "e2e", "docker"] as const) {
    if (plan[id]) steps.push({ id, title: id, cmd: null, note: "CI runs this" });
  }
  return steps;
}

/** Warns when a published (non-private) package changed without a changeset in the diff. */
export function changesetWarning(files: string[], ws: Workspace, root: string): Check | null {
  const hasChangeset = files.some(
    (f) => /^\.changeset\/[^/]+\.md$/.test(f) && f !== ".changeset/README.md",
  );
  if (hasChangeset) return null;
  const changed = ws.packages.filter((p) => files.some((f) => f.startsWith(`${p.dir}/`)));
  const published = changed.filter((p) => {
    const file = join(root, p.dir, "package.json");
    if (!existsSync(file)) return false;
    return (JSON.parse(readFileSync(file, "utf8")) as { private?: boolean }).private !== true;
  });
  if (published.length === 0) return null;
  return {
    id: "changeset",
    title: "Changeset",
    status: "warn",
    detail: `published packages changed without a changeset: ${published.map((p) => p.name).join(", ")}`,
    fix: "pnpm changeset",
  };
}

/**
 * Interprets the outcome of `git fetch <remote> main` and `git merge-base HEAD <remote>/main`.
 * A failed fetch is a warning (the local ref may be fresh enough); a missing merge base is a
 * failure, since there is nothing to diff against. `base` is null exactly when a check failed.
 */
export function baseChecks(
  remote: string,
  fetchOk: boolean,
  mergeBase: string | null,
): { checks: Check[]; base: string | null } {
  const checks: Check[] = [];
  if (!fetchOk) {
    checks.push({
      id: "fetch",
      title: "Fetch upstream",
      status: "warn",
      detail: `git fetch ${remote} main failed; using the local ${remote}/main`,
      fix: `git fetch ${remote} main`,
    });
  }
  if (mergeBase === null || mergeBase === "") {
    checks.push({
      id: "base",
      title: "Merge base",
      status: "fail",
      detail: `cannot find a merge base between HEAD and ${remote}/main`,
      fix: `git fetch ${remote} main (in a shallow clone: git fetch --unshallow ${remote})`,
    });
    return { checks, base: null };
  }
  return { checks, base: mergeBase };
}

/** `changedFiles`, with a git failure turned into a `base` failure check instead of a throw. */
export function tryChangedFiles(
  cwd: string,
  base: string,
): { files: string[]; check: null } | { files: null; check: Check } {
  try {
    return { files: changedFiles(cwd, base), check: null };
  } catch (e) {
    return {
      files: null,
      check: {
        id: "base",
        title: "Changed files",
        status: "fail",
        detail: `could not list the changed files: ${e instanceof Error ? e.message : String(e)}`,
        fix: "git fetch --unshallow <remote> (or check that the repository is intact)",
      },
    };
  }
}

/** The CI plan for `files`; on any error falls back to running everything, as tools/ci does. */
export function safePlan(compute: () => Plan): Plan {
  try {
    return compute();
  } catch (e) {
    return planAll(`could not compute the plan: ${e instanceof Error ? e.message : String(e)}`);
  }
}
