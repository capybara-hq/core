import { parseArgs } from "node:util";
import { changedTestFiles, checkTestPortfolio, listCandidates } from "../test-portfolio.js";
import { report, root } from "./report.js";

// The test portfolio check (design docs/superpowers/specs/2026-11-14-test-portfolio-design.md §6).
// No --base: full mode, the whole kernel test tree minus the grandfather list (what `pnpm check`
// runs). --base <sha>: diff mode, only the kernel test files <sha>...HEAD changes; a base that does
// not resolve (a non-merge checkout) skips the check and exits 0, like check:applied-migrations.
// --list --area <path>: the T1 candidates under that area, one `<path>\t<rule>` per line.
const { values } = parseArgs({
  options: {
    base: { type: "string" },
    list: { type: "boolean" },
    area: { type: "string" },
  },
});

if (values.list) {
  if (values.area === undefined) {
    console.error(
      "Usage: pnpm check:test-portfolio --list --area <path under packages/kernel/test>",
    );
    process.exit(1);
  }
  for (const line of listCandidates(root, values.area)) console.log(line);
  process.exit(0);
}

let changed: Set<string> | undefined;
if (values.base !== undefined) {
  changed = changedTestFiles(root, values.base);
  if (changed === undefined) {
    console.log(
      `Test portfolio check skipped: base ${values.base} does not resolve (a non-merge checkout; locally pass --base origin/main)`,
    );
    process.exit(0);
  }
}

report(
  "Test portfolio",
  checkTestPortfolio({ root, ...(changed === undefined ? {} : { changed }) }),
);
