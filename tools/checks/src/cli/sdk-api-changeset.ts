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

// The SDK's version and API report at the merge base vs the working tree: a version raised or
// followed by hand (see checkSdkApiChangeset).
const SDK_PACKAGE_JSON = "packages/plugin-sdk/package.json";
const versionOf = (text: string) => String((JSON.parse(text) as { version?: unknown }).version);
let sdkVersions: { base: string; head: string } | undefined;
let reports: { base: string; head: string } | undefined;
if (reportAtBase) {
  const mergeBase = git("merge-base", base, "HEAD").trim();
  sdkVersions = {
    base: versionOf(git("show", `${mergeBase}:${SDK_PACKAGE_JSON}`)),
    head: versionOf(readFileSync(join(root, SDK_PACKAGE_JSON), "utf8")),
  };
  reports = {
    base: git("show", `${mergeBase}:${SDK_API_REPORT}`),
    head: readFileSync(join(root, SDK_API_REPORT), "utf8"),
  };
}
const added = lines(
  git("diff", "--name-only", "--diff-filter=A", `${base}...HEAD`, "--", ".changeset"),
).filter((f) => f.endsWith(".md") && !f.endsWith("/README.md"));
const changesets = new Map(added.map((f) => [f, readFileSync(join(root, f), "utf8")]));

report(
  "SDK API changeset",
  checkSdkApiChangeset(changed, changesets, {
    reportAtBase,
    ...(sdkVersions !== undefined && { sdkVersions }),
    ...(reports !== undefined && { reports }),
  }).map((f) => ({
    ...f,
    file: join(root, f.file),
  })),
);
