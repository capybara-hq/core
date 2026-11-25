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
  /** Run only the fast checks (`--fast`): no fetch, no plan, no containers ({@link fastSteps}). */
  fast?: boolean;
  /** With `fast`: the local upstream ref to compare with ({@link fastBaseCheck}). */
  fastBase?: FastBase | null;
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
 * The local upstream ref the fast check compares with, resolved without fetching: `ref` is the
 * remote-tracking ref (`origin/main`), `sha` the commit it points to, `mergeBase` its merge base
 * with HEAD.
 */
export type FastBase = { ref: string; sha: string; mergeBase: string };

/** The fast steps that need {@link FastBase}: skipped (with a warning) when it is missing. */
export const FAST_BASE_STEPS = ["english-comments", "commitlint", "applied-migrations"] as const;

/**
 * The fast, advisory steps (`--fast`): no containers, no database and no fetch. Lint, typecheck,
 * the custom checks; the PR-only checks of CI's `ci` job against the local upstream ref when it
 * exists (`base`; never fetched, so it may be stale): English comment lines the branch adds,
 * commit messages, applied migrations and migration numbers (against the ref itself, so a number
 * main took meanwhile fails here); then the container-free tests: kernel unit, the internal tools
 * (`tools/*`: error copy, platform parity, workflow pins and the other repository-reading tests),
 * the jsdom projects design and plugin-client. Not the web project: about a minute alone, and run
 * together with these it more than triples the step on a dev Mac (CI runs it by diff).
 */
export function fastSteps(base: FastBase | null = null): VerifyStep[] {
  const noBase = "no local upstream main to compare with (git fetch it; fast never fetches)";
  const withBase = (
    id: (typeof FAST_BASE_STEPS)[number],
    title: string,
    cmd: (b: FastBase) => string[],
  ): VerifyStep =>
    base === null ? { id, title, cmd: null, note: noBase } : { id, title, cmd: cmd(base) };
  return [
    ...checkSteps(),
    withBase("english-comments", "English comments (added lines)", (b) => [
      "pnpm",
      "check:english-comments",
      "--base",
      b.mergeBase,
    ]),
    withBase("commitlint", "Commit messages", (b) => [
      "pnpm",
      "exec",
      "commitlint",
      "--from",
      b.mergeBase,
      "--to",
      "HEAD",
    ]),
    withBase("applied-migrations", "Applied migrations and migration numbers", (b) => [
      "pnpm",
      "check:applied-migrations",
      "--base",
      b.sha,
    ]),
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
        "tools",
        "--project",
        "design",
        "--project",
        "plugin-client",
      ],
    },
  ];
}

/**
 * Interprets the local lookup of the fast check's base: the upstream remote (null when none points
 * to capybara-hq/core), the commit its `main` ref points to (null when the ref does not exist
 * locally) and the merge base with HEAD. A missing piece is a warning, never a failure: the steps
 * that need the base are skipped ({@link FAST_BASE_STEPS}) and CI runs them on the PR.
 */
export function fastBaseCheck(
  remote: string | null,
  sha: string | null,
  mergeBase: string | null,
): { check: Check | null; base: FastBase | null } {
  const skipped = `skipped ${FAST_BASE_STEPS.join(", ")}`;
  if (remote === null)
    return {
      base: null,
      check: {
        id: "base",
        title: "Upstream base",
        status: "warn",
        detail: `no remote points to github.com/capybara-hq/core; ${skipped}`,
        fix: "git remote add upstream https://github.com/capybara-hq/core.git && git fetch upstream main",
      },
    };
  const ref = `${remote}/main`;
  if (sha === null || sha === "")
    return {
      base: null,
      check: {
        id: "base",
        title: "Upstream base",
        status: "warn",
        detail: `no local ${ref} (fast never fetches); ${skipped}`,
        fix: `git fetch ${remote} main`,
      },
    };
  if (mergeBase === null || mergeBase === "")
    return {
      base: null,
      check: {
        id: "base",
        title: "Upstream base",
        status: "warn",
        detail: `no merge base between HEAD and ${ref}; ${skipped}`,
        fix: `git fetch ${remote} main (in a shallow clone: git fetch --unshallow ${remote})`,
      },
    };
  return { check: null, base: { ref, sha, mergeBase } };
}

/** The local equivalent of CI's required jobs for this plan, in run order. */
export function verifySteps(plan: Plan, base: string, opts: VerifyOptions = {}): VerifyStep[] {
  // A fast check is an advisory signal and ignores the plan: no containers, no database, no fetch.
  if (opts.fast) return fastSteps(opts.fastBase ?? null);
  const steps: VerifyStep[] = checkSteps();
  // CI runs it in the ci job when bootstrap.json changed (or on a full run); it needs the network
  if (plan.bootstrapNetwork)
    steps.push({
      id: "bootstrap-network",
      title: "Bootstrap manifest against npm and the marketplace",
      cmd: ["pnpm", "check:bootstrap", "--network"],
    });
  // likewise when the device's image pin or its check changed: it needs the registry
  if (plan.deviceImagePinNetwork)
    steps.push({
      id: "device-image-pin-network",
      title: "Device image pin against the registry",
      cmd: ["pnpm", "check:device-image-pin", "--network"],
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
