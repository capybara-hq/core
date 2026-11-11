import { execFileSync } from "node:child_process";
import {
  checkAppliedMigrations as checkApplied,
  diffMigrationNumbers,
  migrationFileMatcher,
} from "@capybara-hq/plugin-tools";
import type { Finding } from "./source.js";

/**
 * Core's applied migrations: the kernel's (`packages/kernel/src/migrations/*.sql`) and the plugins'
 * (`plugins/<name>/migrations/*.sql`). The checks themselves are plugin-tools'
 * `checkAppliedMigrations` and `checkMigrationNumbers`.
 */
export const isMigrationFile = migrationFileMatcher([
  "packages/kernel/src/migrations",
  "plugins/*/migrations",
]);

const PLUGIN_MANIFEST = /^plugins\/([^/]+)\/\.capybara-plugin\/plugin\.json$/;
const PLUGIN_MIGRATION = /^plugins\/([^/]+)\/migrations\/[^/]+$/;

/**
 * Drops the deletions of migrations whose whole plugin the diff deletes (its
 * `.capybara-plugin/plugin.json` deleted or renamed away in the same diff): the plugin moved to
 * another repository (as the official plugins moved to capybara-hq/plugins) and its migrations with
 * it, so no database of this repository's kernel loses a schema it still loads. A migration
 * deleted while its plugin stays, or edited, renamed or retyped, is still reported.
 */
export function withoutRemovedPlugins(nameStatus: string): string {
  const lines = nameStatus.split("\n");
  const removed = new Set<string>();
  for (const line of lines) {
    const [status = "", from = ""] = line.split("\t");
    if (status[0] !== "D" && status[0] !== "R") continue;
    const m = PLUGIN_MANIFEST.exec(from);
    if (m?.[1] !== undefined) removed.add(m[1]);
  }
  if (removed.size === 0) return nameStatus;
  return lines
    .filter((line) => {
      const [status = "", from = ""] = line.split("\t");
      if (status[0] !== "D") return true;
      const plugin = PLUGIN_MIGRATION.exec(from)?.[1];
      return plugin === undefined || !removed.has(plugin);
    })
    .join("\n");
}

/** A migration moved to another number with its content unchanged, and why. */
export interface Renumbered {
  from: string;
  to: string;
  reason: string;
}

/**
 * Renumbers that may rename a migration of the base. Only for a collision that already reached
 * `main` (two PRs taking the same numbers while neither had the other in its base): the file merged
 * last and not released moves above the other, content unchanged (git reports `R100`), so databases
 * that ran the other file are not refused as out of order. An entry is only read by the diff of the
 * PR that makes the rename; a later PR may remove it.
 */
export const RENUMBERED_MIGRATIONS: readonly Renumbered[] = [
  {
    from: "packages/kernel/src/migrations/0109_agent_skill_sharing.sql",
    to: "packages/kernel/src/migrations/0111_agent_skill_sharing.sql",
    reason: "#169 and #171 both took 0109; #169's was merged last and not released",
  },
  {
    from: "packages/kernel/src/migrations/0110_skill_share_requests.sql",
    to: "packages/kernel/src/migrations/0112_skill_share_requests.sql",
    reason: "#169 and #171 both took 0110; #169's was merged last and not released",
  },
];

/** Drops the `R100` lines of `nameStatus` that match an entry of `renumbered` exactly. */
export function withoutListedRenumbers(
  nameStatus: string,
  renumbered: readonly Renumbered[],
): string {
  return nameStatus
    .split("\n")
    .filter((line) => {
      const [status = "", from = "", to = ""] = line.split("\t");
      return !(status === "R100" && renumbered.some((r) => r.from === from && r.to === to));
    })
    .join("\n");
}

/** plugin-tools' `checkAppliedMigrations` on core's migrations ({@link isMigrationFile}). */
export const checkAppliedMigrations = (
  nameStatus: string,
  renumbered: readonly Renumbered[] = RENUMBERED_MIGRATIONS,
): Finding[] =>
  checkApplied(
    withoutListedRenumbers(withoutRemovedPlugins(nameStatus), renumbered),
    isMigrationFile,
  );

/** The applied-migrations check on `<base>...HEAD` in `cwd` (the repository root). */
export function diffAppliedMigrations(cwd: string, base: string): Finding[] {
  const out = execFileSync(
    "git",
    ["diff", "--name-status", "--no-ext-diff", "--relative", "-M", `${base}...HEAD`],
    { cwd, encoding: "utf8" },
  );
  return checkAppliedMigrations(out);
}

/**
 * plugin-tools' `migration-number-behind-base` on `<base>...HEAD` in `cwd`: every migration the
 * diff adds to {@link isMigrationFile}'s directories is numbered above the highest number of its
 * directory at `<base>`.
 */
export const diffNewMigrationNumbers = (cwd: string, base: string): Finding[] =>
  diffMigrationNumbers(cwd, base, isMigrationFile);
