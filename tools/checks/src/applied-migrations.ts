import {
  checkAppliedMigrations as checkApplied,
  diffAppliedMigrations as diffApplied,
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

/** plugin-tools' `checkAppliedMigrations` on core's migrations ({@link isMigrationFile}). */
export const checkAppliedMigrations = (nameStatus: string): Finding[] =>
  checkApplied(nameStatus, isMigrationFile);

/** The applied-migrations check on `<base>...HEAD` in `cwd` (the repository root). */
export const diffAppliedMigrations = (cwd: string, base: string): Finding[] =>
  diffApplied(cwd, base, isMigrationFile);
