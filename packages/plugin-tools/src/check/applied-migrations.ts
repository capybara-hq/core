import { execFileSync } from "node:child_process";
import { globToRegExp } from "../discover.js";
import type { Finding } from "./source.js";

/** Whether a repo-relative POSIX path is a migration file the check guards. */
export type MigrationFilePredicate = (path: string) => boolean;

/**
 * A {@link MigrationFilePredicate} for migration directories given as globs relative to the
 * repository root (`plugins/*\/migrations`, `packages/kernel/src/migrations`, `migrations` for a
 * single-plugin repository): a `*.sql` file directly inside a matching directory. Globs also match
 * directories that no longer exist, so deleting a whole plugin's migrations is still reported.
 */
export function migrationFileMatcher(dirGlobs: string[]): MigrationFilePredicate {
  const dirs = dirGlobs.map(globToRegExp);
  return (path) => {
    if (!path.endsWith(".sql")) return false;
    const slash = path.lastIndexOf("/");
    const dir = slash < 0 ? "" : path.slice(0, slash);
    return dirs.some((re) => re.test(dir));
  };
}

/**
 * PR check: an applied migration is never edited, deleted or renamed. The migrator records each
 * file by name and checksum: an edited file stops `capybara migrate` (checksum mismatch) on every
 * database that already ran it, a renamed one is out of order there, and a deleted one leaves those
 * databases on a different schema than fresh ones. Fresh test databases pass either way, so only a
 * diff check catches it. Adding new files is fine.
 *
 * `nameStatus` is the output of `git diff --name-status -M <base>...HEAD`: an `M`, `D` or `T`
 * entry on a migration (`isMigration`), or an `R` entry whose source is a migration, is reported.
 * `A` and `C` (a new file) are not.
 */
export function checkAppliedMigrations(
  nameStatus: string,
  isMigration: MigrationFilePredicate,
): Finding[] {
  const findings: Finding[] = [];
  for (const line of nameStatus.split("\n")) {
    if (line === "") continue;
    const [status = "", from = ""] = line.split("\t");
    const kind = status[0];
    if (kind === "A" || kind === "C") continue;
    if (!isMigration(from)) continue;
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

/**
 * Runs {@link checkAppliedMigrations} on `<base>...HEAD` (changes since the merge base) in `cwd`.
 * Paths are relative to `cwd` (`git diff --relative`), so `cwd` may be a subdirectory of the
 * repository; finding files are relative to `cwd` too.
 */
export function diffAppliedMigrations(
  cwd: string,
  base: string,
  isMigration: MigrationFilePredicate,
): Finding[] {
  const out = execFileSync(
    "git",
    ["diff", "--name-status", "--no-ext-diff", "--relative", "-M", `${base}...HEAD`],
    { cwd, encoding: "utf8" },
  );
  return checkAppliedMigrations(out, isMigration);
}
