import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { scanTargetProblem } from "../sentinel.js";
import { root } from "./report.js";

/**
 * Scans packages/*\/src/migrations, plugins/*\/migrations and the migrations of the fake extensions
 * ({@link fakeExtensionDirs}); other fixtures are out of scope.
 */
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
  for (const d of fakeExtensionDirs()) dirs.push(join(d, "migrations"));
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

/**
 * The fake extensions of `@capybara-hq/testing` (packages/testing/fixtures/extensions/*): core tests
 * load them instead of the official plugins and the plugins repo will reuse them, so they follow
 * the same rules as plugins (dependency boundary, extension state, permissions, pack, tool design,
 * migrations). Other fixtures are out of scope.
 */
export function fakeExtensionDirs(): string[] {
  const base = join(root, "packages/testing/fixtures/extensions");
  if (!existsSync(base)) return [];
  return readdirSync(base, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== "node_modules")
    .map((e) => join(base, e.name))
    .sort();
}

/** Every directory the plugin-scoped checks scan: {@link pluginDirs} plus {@link fakeExtensionDirs}. */
export function extensionDirs(): string[] {
  return [...pluginDirs(), ...fakeExtensionDirs()];
}

/** Scope of the tool-design check: the kernel builtin tools directory plus the given extension dirs. */
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
