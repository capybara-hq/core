/**
 * Runs locally what CI's required checks run for this branch's diff (`pnpm verify`).
 *
 *   tsx tools/dev/src/verify-cli.ts [--json]
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadWorkspace, planFromFiles } from "@capybara-hq/ci/affected";
import { findUpstream, readRemotes } from "./remotes.ts";
import { type Check, printReport } from "./report.ts";
import { changedFiles, changesetWarning, verifySteps } from "./verify.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url)).replace(/\/$/, "");
const json = process.argv.includes("--json");
// In --json mode stdout carries only the report; progress goes to stderr.
const say = (s: string) => (json ? console.error(s) : console.log(s));

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
  if (fetched.status !== 0) console.error(`warning: git fetch ${upstream.remote} main failed`);
  const mb = spawnSync("git", ["merge-base", "HEAD", `${upstream.remote}/main`], {
    cwd: root,
    encoding: "utf8",
  });
  if (mb.status !== 0) {
    console.error(`cannot find a merge base with ${upstream.remote}/main`);
    process.exit(1);
  }
  const base = mb.stdout.trim();
  const files = changedFiles(root, base);
  const ws = loadWorkspace(root);
  const plan = planFromFiles(files, ws);
  say(`base: ${base}`);
  say(`changed files: ${files.length}`);
  say(`plan: ${plan.reason}`);

  const checks: Check[] = [];
  for (const step of verifySteps(plan, base)) {
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
      detail: ok ? step.cmd.join(" ") : `exit ${r.status ?? "signal"}${tail ? `\n${tail}` : ""}`,
    });
  }
  const warning = changesetWarning(files, ws, root);
  if (warning !== null) checks.push(warning);
  say("");
  process.exitCode = printReport(checks, json);
}
