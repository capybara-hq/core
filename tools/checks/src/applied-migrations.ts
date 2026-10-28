import { execFileSync } from "node:child_process";
import {
  checkAppliedMigrations as checkApplied,
  migrationFileMatcher,
} from "@capybara-hq/plugin-tools";
import type { Finding } from "./source.js";

/**
 * Core's applied migrations: the kernel's (`packages/kernel/src/migrations/*.sql`) and the plugins'
 * (`plugins/<name>/migrations/*.sql`). The check itself is plugin-tools' `checkAppliedMigrations`.
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

/** plugin-tools' `checkAppliedMigrations` on core's migrations ({@link isMigrationFile}). */
export const checkAppliedMigrations = (nameStatus: string): Finding[] =>
  checkApplied(withoutRemovedPlugins(nameStatus), isMigrationFile);

/** The applied-migrations check on `<base>...HEAD` in `cwd` (the repository root). */
export function diffAppliedMigrations(cwd: string, base: string): Finding[] {
  const out = execFileSync(
    "git",
    ["diff", "--name-status", "--no-ext-diff", "--relative", "-M", `${base}...HEAD`],
    { cwd, encoding: "utf8" },
  );
  return checkAppliedMigrations(out);
}
