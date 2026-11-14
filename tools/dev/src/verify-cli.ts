/**
 * Runs locally what CI's required checks run for this branch's diff (`pnpm verify`).
 *
 *   tsx tools/dev/src/verify-cli.ts [--json] [--full] [--fast] [--plan-only]
 *
 * When CI's plan runs everything, only the tests of the packages the diff touches run here (CI
 * runs the full suite); `--full` runs the full suite locally too. `--fast` runs lint, typecheck,
 * the custom checks and the container-free tests (kernel unit, design, plugin-client): a quick
 * advisory signal that does no upstream/fetch/merge-base/plan work (the steps themselves may still
 * use git: `pnpm check` lists tracked files) and is never the gate (it takes precedence over
 * `--full`). `--plan-only` (with `--fast` only) reports the steps and their commands without
 * running them: a testing aid for the fast path's own test.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadWorkspace, planFromFiles, type Workspace } from "@capybara-hq/ci/affected";
import { findUpstream, readRemotes } from "./remotes.ts";
import { type Check, printReport } from "./report.ts";
import {
  baseChecks,
  changesetWarning,
  fastSteps,
  localTestPlan,
  safePlan,
  tryChangedFiles,
  type VerifyStep,
  verifySteps,
} from "./verify.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url)).replace(/\/$/, "");
const json = process.argv.includes("--json");
const full = process.argv.includes("--full");
const fast = process.argv.includes("--fast");
const planOnly = process.argv.includes("--plan-only");
// In --json mode stdout carries only the report; progress goes to stderr.
const say = (s: string) => (json ? console.error(s) : console.log(s));

/** Runs the steps in order and collects one check each (a step without a command is a skip). */
function runSteps(steps: VerifyStep[]): Check[] {
  const checks: Check[] = [];
  for (const step of steps) {
    if (step.cmd === null) {
      checks.push({ id: step.id, title: step.title, status: "skip", detail: step.note ?? "" });
      continue;
    }
    say(`\n==> ${step.title}: ${step.cmd.join(" ")}`);
    const [cmd, ...args] = step.cmd as [string, ...string[]];
    const r = spawnSync(cmd, args, {
      cwd: root,
      encoding: "utf8",
      stdio: json ? "pipe" : "inherit",
      maxBuffer: 256 * 1024 * 1024,
    });
    const ok = r.status === 0;
    const tail = json
      ? `${r.stdout ?? ""}${r.stderr ?? ""}`.trimEnd().split("\n").slice(-20).join("\n")
      : "";
    checks.push({
      id: step.id,
      title: step.title,
      status: ok ? "pass" : "fail",
      detail: ok
        ? `${step.cmd.join(" ")}${step.note ? ` (${step.note})` : ""}`
        : `exit ${r.status ?? "signal"}${tail ? `\n${tail}` : ""}`,
    });
  }
  return checks;
}

if (fast) {
  // Self-contained: no upstream remote, no fetch, no merge base, no plan, no changeset warning.
  if (full) say("--fast takes precedence over --full");
  if (planOnly) {
    // A testing aid: the same step list, reported without spawning anything.
    const checks: Check[] = fastSteps().map((step) => ({
      id: step.id,
      title: step.title,
      status: "planned",
      detail: step.cmd?.join(" ") ?? step.note ?? "",
    }));
    if (json) process.exitCode = printReport(checks, true);
    else for (const c of checks) console.log(`${c.id}: ${c.detail}`);
  } else {
    const checks = runSteps(fastSteps());
    say("\nfast check only; pnpm verify (or CI) runs the affected tests before merge");
    say("");
    process.exitCode = printReport(checks, json);
  }
} else {
  const upstream = findUpstream(readRemotes(root), "core");
  if (upstream === null) {
    process.exitCode = printReport(
      [
        {
          id: "remotes",
          title: "Upstream remote",
          status: "fail",
          detail: "no remote points to github.com/capybara-hq/core",
          fix: "git remote add upstream https://github.com/capybara-hq/core.git",
        },
      ],
      json,
    );
  } else {
    const fetched = spawnSync("git", ["fetch", upstream.remote, "main"], {
      cwd: root,
      stdio: "pipe",
    });
    const mb = spawnSync("git", ["merge-base", "HEAD", `${upstream.remote}/main`], {
      cwd: root,
      encoding: "utf8",
    });
    const resolved = baseChecks(
      upstream.remote,
      fetched.status === 0,
      mb.status === 0 ? mb.stdout.trim() : null,
    );
    const listed = resolved.base === null ? null : tryChangedFiles(root, resolved.base);
    if (resolved.base === null || listed === null || listed.files === null) {
      const checks = [...resolved.checks, ...(listed?.check ? [listed.check] : [])];
      process.exitCode = printReport(checks, json);
    } else {
      const base = resolved.base;
      const files = listed.files;
      let ws: Workspace | null = null;
      const plan = safePlan(() => {
        ws = loadWorkspace(root);
        return planFromFiles(files, ws);
      });
      say(`base: ${base}`);
      say(`changed files: ${files.length}`);
      say(`plan: ${plan.reason}`);

      const loaded = ws as Workspace | null;
      const local = plan.all && !full && loaded !== null ? localTestPlan(files, loaded) : null;
      if (local !== null)
        say(`local tests: ${local.reason}${local.test ? `: ${local.testDirs.join(", ")}` : ""}`);

      const checks: Check[] = [...resolved.checks];
      checks.push(...runSteps(verifySteps(plan, base, { full, local })));
      const warning = ws === null ? null : changesetWarning(files, ws, root);
      if (warning !== null) checks.push(warning);
      say("");
      process.exitCode = printReport(checks, json);
    }
  }
}
