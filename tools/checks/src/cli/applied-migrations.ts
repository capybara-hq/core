import { join } from "node:path";
import { parseArgs } from "node:util";
import { diffAppliedMigrations, diffNewMigrationNumbers } from "../applied-migrations.js";
import { report, root } from "./report.js";

// PR-only check: `pnpm check:applied-migrations --base <base sha>` compares <base>...HEAD: no
// applied migration edited, deleted or renamed (applied-migration-edited), and every added one
// numbered above its directory's highest at <base> (migration-number-behind-base).
const { values } = parseArgs({ options: { base: { type: "string" } } });
const base = values.base;
if (!base) {
  console.log(
    "Applied migrations check skipped: no --base given (it runs on pull requests; locally pass --base origin/main)",
  );
  process.exit(0);
}

report(
  "Applied migrations",
  [...diffAppliedMigrations(root, base), ...diffNewMigrationNumbers(root, base)].map((f) => ({
    ...f,
    file: join(root, f.file),
  })),
);
