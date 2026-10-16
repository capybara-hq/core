import { existsSync } from "node:fs";
import { join } from "node:path";

/** 扫描目标为空或缺失时的错误说明；目标正常返回 undefined。 */
export function scanTargetProblem(pluginDirs: string[], root: string): string | undefined {
  const problems: string[] = [];
  if (pluginDirs.length === 0) problems.push("plugins/* 下没有找到任何插件目录");
  if (!existsSync(join(root, "packages/plugin-sdk"))) problems.push("packages/plugin-sdk 不存在");
  if (problems.length === 0) return undefined;
  return `扫描目标为空，检查等于没跑：${problems.join("；")}`;
}
