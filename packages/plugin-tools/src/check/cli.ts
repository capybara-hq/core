import { join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { discoverPlugins, pluginsGlobOf } from "../discover.js";
import { diffAppliedMigrations, migrationFileMatcher } from "./applied-migrations.js";
import { type NamedCheck, pluginChecks, runChecks } from "./run.js";

export const CHECK_USAGE = "capybara-plugin check [--root <dir>] [--plugins <glob>] [--base <ref>]";

/**
 * `capybara-plugin check`: runs every plugin-scoped check on the plugins of a repository.
 *
 * - `--root <dir>`: the repository (default: the current directory);
 * - `--plugins <glob>`: the plugin directories, relative to the root (`*` within one segment);
 *   default `plugins/*` when `<root>/plugins` exists, else the root itself when it holds
 *   `.capybara-plugin/plugin.json`;
 * - `--base <ref>`: also fail when `<ref>...HEAD` edits, deletes or renames a migration of a plugin
 *   (applied migrations are immutable); for pull requests.
 *
 * Finding no plugin is an error: an empty scan would pass without checking anything.
 *
 * Paths: * relative paths resolve against `cwd` (the current directory). Returns the exit code.
 */
export async function checkCommand(args: string[], cwd: string): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      help: { type: "boolean", short: "h", default: false },
      root: { type: "string" },
      plugins: { type: "string" },
      base: { type: "string" },
    },
  });
  if (values.help) {
    console.log(`usage: ${CHECK_USAGE}`);
    return 0;
  }
  const root = values.root === undefined ? cwd : resolve(cwd, values.root);
  let plugins: string[];
  try {
    plugins = discoverPlugins(root, values.plugins);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return 2;
  }
  if (plugins.length === 0) {
    console.error(
      `${relative(cwd, root) || "."}: no plugin found (${values.plugins ?? "plugins/* or .capybara-plugin/plugin.json"}); the checks would check nothing`,
    );
    return 1;
  }
  console.log(
    `checking ${plugins.length} plugin(s): ${plugins.map((p) => relative(root, p) || ".").join(", ")}`,
  );
  const checks: NamedCheck[] = pluginChecks({ plugins });
  const base = values.base;
  if (base !== undefined) {
    const glob = pluginsGlobOf(root, values.plugins);
    const isMigration = migrationFileMatcher([glob === "." ? "migrations" : `${glob}/migrations`]);
    checks.push({
      name: "Applied migrations",
      run: () =>
        diffAppliedMigrations(root, base, isMigration).map((f) => ({
          ...f,
          file: join(root, f.file),
        })),
    });
  }
  const failed = await runChecks(checks, root);
  if (failed > 0) {
    console.error(`\n${failed} check(s) failed`);
    return 1;
  }
  console.log("\nAll plugin checks passed");
  return 0;
}
