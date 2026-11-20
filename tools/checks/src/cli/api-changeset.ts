import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { API_REPORTS, checkApiChangeset } from "../api-changeset.js";
import type { Finding } from "../source.js";
import { report, root } from "./report.js";

// PR-only check: `pnpm check:api-changeset --base <base sha>` compares <base>...HEAD.
const { values } = parseArgs({ options: { base: { type: "string" } } });
const base = values.base;
if (!base) {
  console.error("usage: pnpm check:api-changeset --base <base commit>");
  process.exit(2);
}

const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
const lines = (out: string) => out.split("\n").filter((l) => l !== "");
const versionOf = (text: string) => String((JSON.parse(text) as { version?: unknown }).version);
const existsAt = (rev: string, path: string) => {
  try {
    execFileSync("git", ["cat-file", "-e", `${rev}:${path}`], { cwd: root, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

const changed = lines(git("diff", "--name-only", `${base}...HEAD`));
const added = lines(
  git("diff", "--name-only", "--diff-filter=A", `${base}...HEAD`, "--", ".changeset"),
).filter((f) => f.endsWith(".md") && !f.endsWith("/README.md"));
const changesets = new Map(added.map((f) => [f, readFileSync(join(root, f), "utf8")]));

// Where the branch started: what CI passes as `HEAD^1`, and what a local `--base origin/main` on an
// old branch must compare against too, since main's tip may already hold the change or postdate the
// package itself.
const mergeBase = git("merge-base", base, "HEAD").trim();

const findings: Finding[] = [];
for (const entry of API_REPORTS) {
  // A package whose report or manifest the merge base does not have is new in this diff: there is
  // no earlier API to compare against.
  const reportAtBase = existsAt(mergeBase, entry.report) && existsAt(mergeBase, entry.manifest);
  if (!reportAtBase)
    console.log(`${entry.report} does not exist at ${mergeBase}: skipped (the PR introduces it)`);
  // Each package's version and API report at the merge base vs the working tree: a version raised
  // or following by hand (see checkApiChangeset). A report or manifest missing from the working
  // tree (deleted in this diff) leaves the changeset requirement alone and only drops the
  // exemption, so the finding names the missing changeset instead of printing ENOENT.
  const reportNow = join(root, entry.report);
  const manifestNow = join(root, entry.manifest);
  const baselines =
    reportAtBase && existsSync(reportNow) && existsSync(manifestNow)
      ? {
          versions: {
            base: versionOf(git("show", `${mergeBase}:${entry.manifest}`)),
            head: versionOf(readFileSync(manifestNow, "utf8")),
          },
          reports: {
            base: git("show", `${mergeBase}:${entry.report}`),
            head: readFileSync(reportNow, "utf8"),
          },
        }
      : {};
  findings.push(
    ...checkApiChangeset(entry, changed, changesets, { reportAtBase, ...baselines }).map((f) => ({
      ...f,
      file: join(root, f.file),
    })),
  );
}

report("API changeset", findings);
