import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { checkSdkApiChangeset, SDK_API_REPORT } from "../sdk-api-changeset.js";
import { report, root } from "./report.js";

// PR-only check: `pnpm check:sdk-api-changeset --base <base sha>` compares <base>...HEAD.
const { values } = parseArgs({ options: { base: { type: "string" } } });
const base = values.base;
if (!base) {
  console.error("usage: pnpm check:sdk-api-changeset --base <base commit>");
  process.exit(2);
}

const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
const lines = (out: string) => out.split("\n").filter((l) => l !== "");

let reportAtBase = true;
try {
  execFileSync("git", ["cat-file", "-e", `${base}:${SDK_API_REPORT}`], {
    cwd: root,
    stdio: "ignore",
  });
} catch {
  reportAtBase = false;
  console.log(`${SDK_API_REPORT} does not exist at ${base}: skipped (the PR introduces it)`);
}

const changed = lines(git("diff", "--name-only", `${base}...HEAD`));
const added = lines(
  git("diff", "--name-only", "--diff-filter=A", `${base}...HEAD`, "--", ".changeset"),
).filter((f) => f.endsWith(".md") && !f.endsWith("/README.md"));
const changesets = new Map(added.map((f) => [f, readFileSync(join(root, f), "utf8")]));

report(
  "SDK API changeset",
  checkSdkApiChangeset(changed, changesets, { reportAtBase }).map((f) => ({
    ...f,
    file: join(root, f.file),
  })),
);
