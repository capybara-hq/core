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

const NUMBERED = /^(\d{4})_[^/]*\.sql$/;

/** The files of a migration directory at the base (repo-relative `dir`, POSIX); `[]` when absent. */
export type BaseMigrationNames = (dir: string) => readonly string[];

/**
 * PR check (rule `migration-number-behind-base`): every migration the diff adds is numbered above
 * the highest number of its directory at the base. A branch that numbered its migrations before
 * the base released the same or higher numbers (a branch's `0063..0068` against main's new
 * `0063`) would otherwise merge with a collision or out of order: databases that already ran the
 * base's files never run a lower-numbered newcomer in sequence, and a shared one ends up numbered
 * differently from a fresh one.
 *
 * `nameStatus` is the output of `git diff --name-status -M <base>...HEAD`; the added files are the
 * `A` entries and the destinations of `C` and `R` entries (`R` sources are
 * {@link checkAppliedMigrations}'). `baseNames` lists a directory at the base itself (not the merge
 * base: the base may have moved on since the branch started). A file that already exists at the
 * base under the same name is not new to it and is skipped.
 */
export function checkMigrationNumbers(
  nameStatus: string,
  isMigration: MigrationFilePredicate,
  baseNames: BaseMigrationNames,
): Finding[] {
  const findings: Finding[] = [];
  const highest = new Map<string, { n: number; name: string } | null>();
  const highestIn = (dir: string) => {
    if (!highest.has(dir)) {
      let top: { n: number; name: string } | null = null;
      for (const name of baseNames(dir)) {
        const m = NUMBERED.exec(name);
        if (m?.[1] === undefined) continue;
        const n = Number(m[1]);
        if (top === null || n > top.n) top = { n, name };
      }
      highest.set(dir, top);
    }
    return highest.get(dir) ?? null;
  };
  for (const line of nameStatus.split("\n")) {
    if (line === "") continue;
    const parts = line.split("\t");
    const kind = parts[0]?.[0];
    const added = kind === "A" ? parts[1] : kind === "C" || kind === "R" ? parts[2] : undefined;
    if (added === undefined || !isMigration(added)) continue;
    const slash = added.lastIndexOf("/");
    const dir = slash < 0 ? "" : added.slice(0, slash);
    const name = added.slice(slash + 1);
    const m = NUMBERED.exec(name);
    if (m?.[1] === undefined) continue; // the naming rule reports it
    if (baseNames(dir).includes(name)) continue;
    const top = highestIn(dir);
    if (top === null || Number(m[1]) > top.n) continue;
    findings.push({
      file: added,
      line: 1,
      rule: "migration-number-behind-base",
      message: `migration number ${m[1]} is not above the base's highest in ${dir || "."} (${top.name}): renumber the files this change adds to follow it`,
    });
  }
  return findings;
}

/**
 * Runs {@link checkMigrationNumbers} on `<base>...HEAD` in `cwd`, listing each directory at
 * `<base>` itself with `git ls-tree`. Paths are relative to `cwd`, as in
 * {@link diffAppliedMigrations}.
 */
export function diffMigrationNumbers(
  cwd: string,
  base: string,
  isMigration: MigrationFilePredicate,
): Finding[] {
  const out = execFileSync(
    "git",
    ["diff", "--name-status", "--no-ext-diff", "--relative", "-M", `${base}...HEAD`],
    { cwd, encoding: "utf8" },
  );
  const listed = new Map<string, string[]>();
  const baseNames: BaseMigrationNames = (dir) => {
    let names = listed.get(dir);
    if (names === undefined) {
      const tree = execFileSync("git", ["ls-tree", "--name-only", base, "--", `${dir || "."}/`], {
        cwd,
        encoding: "utf8",
      });
      names = tree
        .split("\n")
        .filter((p) => p !== "")
        .map((p) => p.slice(p.lastIndexOf("/") + 1));
      listed.set(dir, names);
    }
    return names;
  };
  return checkMigrationNumbers(out, isMigration, baseNames);
}
