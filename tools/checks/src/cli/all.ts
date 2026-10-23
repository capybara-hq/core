import { join, relative } from "node:path";
import { checkComposeHaproxy } from "../compose-haproxy.js";
import { checkConfigDocs } from "../config-docs.js";
import { checkDeps } from "../deps.js";
import { checkI18n } from "../i18n.js";
import { checkMigrations } from "../migrations.js";
import { checkPackageSchemas } from "../package-schemas.js";
import { checkPluginPack } from "../plugin-pack.js";
import { checkPluginPermissions } from "../plugin-permissions.js";
import { checkPluginState } from "../plugin-state.js";
import type { Finding } from "../source.js";
import { checkSyncedSkills } from "../synced-skills.js";
import { checkTestPlugins } from "../test-plugins.js";
import { checkToolDesign } from "../tool-design.js";
import { checkWebUi } from "../web-ui.js";
import { migrationDirs, pluginDirs, requireScanTargets, toolDesignDirs } from "./dirs.js";
import { root } from "./report.js";

requireScanTargets();

const checks: { name: string; run: () => Finding[] | Promise<Finding[]> }[] = [
  { name: "迁移", run: () => checkMigrations(migrationDirs()) },
  { name: "依赖边界", run: () => checkDeps(pluginDirs(), [join(root, "packages/plugin-sdk")]) },
  { name: "插件状态", run: () => checkPluginState(pluginDirs()) },
  { name: "插件权限", run: () => checkPluginPermissions(pluginDirs()) },
  { name: "插件打包", run: () => checkPluginPack(pluginDirs()) },
  { name: "工具设计", run: () => checkToolDesign(toolDesignDirs(pluginDirs())) },
  { name: "配置文档", run: () => checkConfigDocs() },
  { name: "包 JSON Schema", run: () => checkPackageSchemas() },
  { name: "界面文案", run: () => checkI18n(join(root, "apps/web/messages")) },
  {
    name: "界面规范",
    run: () => checkWebUi(join(root, "apps/web/src"), join(root, "packages/design/src")),
  },
  { name: "测试插件", run: () => checkTestPlugins(root) },
  { name: "Synced skills", run: () => checkSyncedSkills(root) },
  {
    name: "compose haproxy",
    run: () =>
      checkComposeHaproxy(
        join(root, "docker/compose.yaml"),
        join(root, "docker/sandbox-proxy/haproxy.cfg"),
      ),
  },
];

let failed = 0;
for (const c of checks) {
  let findings: Finding[];
  try {
    findings = await c.run();
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
