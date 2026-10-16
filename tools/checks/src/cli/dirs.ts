import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { root } from "./report.js";

/** plugins/* 下的所有插件目录（真实代码；fixtures 不在范围内）。 */
export function pluginDirs(): string[] {
  const base = join(root, "plugins");
  if (!existsSync(base)) return [];
  return readdirSync(base, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== "node_modules")
    .map((e) => join(base, e.name))
    .sort();
}
