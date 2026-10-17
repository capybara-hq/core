import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { scanTargetProblem } from "../sentinel.js";
import { root } from "./report.js";

/** 只扫描 packages/*\/src/migrations 与 plugins/*\/migrations；fixtures 不在扫描范围内。 */
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

/** plugins/* 下的所有插件目录（真实代码；fixtures 不在范围内）。 */
export function pluginDirs(): string[] {
  const base = join(root, "plugins");
  if (!existsSync(base)) return [];
  return readdirSync(base, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== "node_modules")
    .map((e) => join(base, e.name))
    .sort();
}

/** 哨兵：插件目录为空或 plugin-sdk 缺失时直接 exit 1，避免空扫描假绿。 */
export function requireScanTargets(): void {
  const problem = scanTargetProblem(pluginDirs(), root);
  if (problem === undefined) return;
  console.error(problem);
  process.exit(1);
}
