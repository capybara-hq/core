import { join } from "node:path";
import { checkDeps } from "./deps.js";
import { checkMigrations } from "./migrations.js";
import { checkPluginPack } from "./plugin-pack.js";
import { checkPluginPermissions } from "./plugin-permissions.js";
import { checkPluginState } from "./plugin-state.js";
import { printCheck } from "./report.js";
import type { Finding } from "./source.js";
import { checkToolDesign } from "./tool-design.js";

/** What the plugin-scoped checks scan. */
export interface PluginCheckScope {
  /**
   * Plugin directories: every check runs on each (dependency boundary, extension state,
   * permissions, pack, tool design, and the migrations in `<plugin>/migrations`).
   */
  plugins: string[];
  /** Package directories held to the SDK's boundary (core: `packages/plugin-sdk`). */
  sdkDirs?: string[];
  /** More directories the tool design rules scan (core: the kernel's builtin tools). */
  toolDesignDirs?: string[];
  /** More migration directories (core: the kernel's migrations). */
  migrationDirs?: string[];
}

/** A named check: `run` returns its findings. */
export interface NamedCheck {
  name: string;
  run: () => Finding[] | Promise<Finding[]>;
}

/**
 * Every plugin-scoped check over `scope`, in the order `capybara-plugin check` and core's `pnpm
 * check` run them. `checkAppliedMigrations` is not here: it needs a diff base (PR only).
 */
export function pluginChecks(scope: PluginCheckScope): NamedCheck[] {
  const { plugins } = scope;
  return [
    {
      name: "Migrations",
      run: () =>
        checkMigrations([
          ...(scope.migrationDirs ?? []),
          ...plugins.map((p) => join(p, "migrations")),
        ]),
    },
    { name: "Dependency boundary", run: () => checkDeps(plugins, scope.sdkDirs ?? []) },
    { name: "Extension state", run: () => checkPluginState(plugins) },
    { name: "Extension permissions", run: () => checkPluginPermissions(plugins) },
    { name: "Plugin pack", run: () => checkPluginPack(plugins) },
    {
      name: "Tool design",
      run: () => checkToolDesign([...(scope.toolDesignDirs ?? []), ...plugins]),
    },
  ];
}

/**
 * Runs `checks` in order and prints each result ({@link printCheck}, paths relative to `root`); a
 * check that throws counts as failed. Returns the number of failed checks.
 */
export async function runChecks(checks: NamedCheck[], root: string): Promise<number> {
  let failed = 0;
  for (const c of checks) {
    let findings: Finding[];
    try {
      findings = await c.run();
    } catch (e) {
      console.error(
        `[${c.name}] check crashed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`,
      );
      failed++;
      continue;
    }
    if (!printCheck(c.name, findings, root)) failed++;
  }
  return failed;
}
