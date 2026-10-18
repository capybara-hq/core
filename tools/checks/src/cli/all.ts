import { join, relative } from "node:path";
import { checkConfigDocs } from "../config-docs.js";
import { checkDeps } from "../deps.js";
import { checkI18n } from "../i18n.js";
import { checkMigrations } from "../migrations.js";
import { checkPluginState } from "../plugin-state.js";
import type { Finding } from "../source.js";
import { migrationDirs, pluginDirs, requireScanTargets } from "./dirs.js";
import { root } from "./report.js";

requireScanTargets();

const checks: { name: string; run: () => Finding[] }[] = [
  { name: "迁移", run: () => checkMigrations(migrationDirs()) },
  { name: "依赖边界", run: () => checkDeps(pluginDirs(), [join(root, "packages/plugin-sdk")]) },
  { name: "插件状态", run: () => checkPluginState(pluginDirs()) },
  { name: "配置文档", run: () => checkConfigDocs() },
  { name: "界面文案", run: () => checkI18n(join(root, "apps/web/messages")) },
];

let failed = 0;
for (const c of checks) {
  let findings: Finding[];
  try {
    findings = c.run();
  } catch (e) {
    console.error(
      `[${c.name}] 检查自身崩溃：${e instanceof Error ? (e.stack ?? e.message) : String(e)}`,
    );
    failed++;
    continue;
  }
  if (findings.length === 0) {
    console.log(`[${c.name}] 通过`);
    continue;
  }
  failed++;
  console.error(`[${c.name}] ${findings.length} 条问题`);
  for (const f of findings)
    console.error(`  ${relative(root, f.file)}:${f.line} ${f.rule} ${f.message}`);
}
if (failed > 0) {
  console.error(`\n${failed} 项检查未通过`);
  process.exit(1);
}
console.log("\n全部检查通过");
