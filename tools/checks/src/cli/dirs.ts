import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { scanTargetProblem } from "../sentinel.js";
import { root } from "./report.js";

/** Scans only packages/*\/src/migrations and plugins/*\/migrations; fixtures are out of scope. */
export function migrationDirs(): string[] {
  const dirs: string[] = [];
  const sub = (base: string, rest: string) => {
    const b = join(root, base);
    if (!existsSync(b)) return;
    for (const e of readdirSync(b, { withFileTypes: true })) {
      if (e.isDirectory()) dirs.push(join(b, e.name, rest));
    }
  };
  sub("packages", "src/migrations");
  sub("plugins", "migrations");
  return dirs;
}

/** Every plugin directory under plugins/* (real code; fixtures are out of scope). */
export function pluginDirs(): string[] {
  const base = join(root, "plugins");
  if (!existsSync(base)) return [];
  return readdirSync(base, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== "node_modules")
    .map((e) => join(base, e.name))
    .sort();
}

/** Scope of the tool-design check: the kernel builtin tools directory plus all plugins (fixtures are out of scope). */
export function toolDesignDirs(plugins: string[]): string[] {
  return [join(root, "packages/kernel/src/tools/builtins"), ...plugins];
}

/** Sentinel: exit 1 when the plugin directory is empty or plugin-sdk is missing, so an empty scan cannot pass. */
export function requireScanTargets(): void {
  const problem = scanTargetProblem(pluginDirs(), root);
  if (problem === undefined) return;
  console.error(problem);
  process.exit(1);
}
