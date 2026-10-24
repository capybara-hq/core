import { execFileSync } from "node:child_process";
import type { Finding } from "./source.js";

/** Kernel (`packages/kernel/src/migrations/*.sql`) and plugin (`plugins/<name>/migrations/*.sql`) migrations. */
const MIGRATION_FILE =
  /^(?:packages\/kernel\/src\/migrations|plugins\/[^/]+\/migrations)\/[^/]+\.sql$/;

export function isMigrationFile(path: string): boolean {
  return MIGRATION_FILE.test(path);
}

/**
 * PR check: an applied migration is never edited, deleted or renamed. The migrator records each
 * file by name and checksum: an edited file stops `capybara migrate` (checksum mismatch) on every
 * database that already ran it, a renamed one is out of order there, and a deleted one leaves those
 * databases on a different schema than fresh ones. Fresh test databases pass either way, so only a
 * diff check catches it. Adding new files is fine.
 *
 * `nameStatus` is the output of `git diff --name-status -M <base>...HEAD`: an `M`, `D` or `T`
 * entry on a migration, or an `R` entry whose source is a migration, is reported. `A` and `C`
 * (a new file) are not.
 */
export function checkAppliedMigrations(nameStatus: string): Finding[] {
  const findings: Finding[] = [];
  for (const line of nameStatus.split("\n")) {
    if (line === "") continue;
    const [status = "", from = ""] = line.split("\t");
    const kind = status[0];
    if (kind === "A" || kind === "C") continue;
    if (!isMigrationFile(from)) continue;
    const what =
      kind === "D"
        ? "deleted"
        : kind === "R"
          ? "renamed"
          : kind === "T"
            ? "changed type"
            : "edited";
    findings.push({
      file: from,
      line: 1,
      rule: "applied-migration-edited",
      message: `migration ${what}: applied migrations are immutable (the migrator records them by name and checksum); restore it and add a new migration instead`,
    });
  }
  return findings;
}

/** Runs {@link checkAppliedMigrations} on `<base>...HEAD` (changes since the merge base) in `cwd`. */
export function diffAppliedMigrations(cwd: string, base: string): Finding[] {
  const out = execFileSync(
    "git",
    ["diff", "--name-status", "--no-ext-diff", "-M", `${base}...HEAD`],
    { cwd, encoding: "utf8" },
  );
  return checkAppliedMigrations(out);
}
